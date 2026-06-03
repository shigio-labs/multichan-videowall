// Electron main process: boots the embedded Express server, then opens a window.
const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net  = require('node:net');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Silence noisy Windows GPU/disk-cache warnings — we don't need cache anyway,
// the whole app philosophy is "always fresh data".
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-features', 'DiskCache');

// Find a free port (try 3000 first, fall back to OS-assigned).
function findFreePort(preferred = 3000) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => {
      // Preferred busy → ask OS for any free port.
      const srv2 = net.createServer();
      srv2.unref();
      srv2.on('error', () => resolve(preferred));
      srv2.listen(0, () => {
        const p = srv2.address().port;
        srv2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, () => srv.close(() => resolve(preferred)));
  });
}

let mainWindow = null;
let serverPort = 0;
let activeDownload = null;

function sanitizePathSegment(value, fallback = 'item') {
  const clean = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
  return (clean || fallback).slice(0, 120);
}

function filenameFromVideo(video, index) {
  let base = 'video';
  try {
    const u = new URL(video.url);
    base = decodeURIComponent(path.basename(u.pathname)) || base;
  } catch {
    base = path.basename(String(video.url || '')) || base;
  }

  base = sanitizePathSegment(base, `video-${index + 1}`);
  if (!path.extname(base) && video.ext) base += `.${sanitizePathSegment(video.ext, 'mp4')}`;

  const prefix = String(index + 1).padStart(4, '0');
  const thread = sanitizePathSegment(video.thread || 'thread', 'thread');
  return sanitizePathSegment(`${prefix}_${thread}_${base}`, `video-${index + 1}`).slice(0, 180);
}

async function uniqueFilePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 2; ; i++) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${stem}_${i}${ext}`);
    } catch {
      return candidate;
    }
  }
}

function emitDownloadProgress(job, patch = {}, force = false) {
  if (!job || !job.webContents || job.webContents.isDestroyed()) return;
  Object.assign(job.progress, patch);

  const now = Date.now();
  if (!force && now - job.lastSent < 200) return;
  job.lastSent = now;
  job.webContents.send('downloads:progress', job.progress);
}

async function downloadOne(job, video, index) {
  const filename = filenameFromVideo(video, index);
  const filePath = await uniqueFilePath(job.outputDir, filename);
  const proxyUrl = `http://localhost:${serverPort}/proxy?src=${encodeURIComponent(video.url)}&dl=1`;
  const res = await fetch(proxyUrl, { signal: job.abort.signal });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status || 0}`);
  }

  const contentLength = Number(res.headers.get('content-length')) || 0;
  let currentBytes = 0;

  emitDownloadProgress(job, {
    status: 'running',
    current: path.basename(filePath),
    currentBytes,
    currentTotalBytes: contentLength,
  }, true);

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      currentBytes += chunk.length;
      job.progress.downloadedBytes += chunk.length;

      const itemProgress = contentLength > 0 ? currentBytes / contentLength : 0;
      const doneItems = job.progress.completed + job.progress.failed;
      const percent = job.progress.total > 0
        ? Math.min(99, Math.round(((doneItems + itemProgress) / job.progress.total) * 100))
        : 0;

      emitDownloadProgress(job, {
        currentBytes,
        currentTotalBytes: contentLength,
        percent,
      });

      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body),
      counter,
      fs.createWriteStream(filePath),
      { signal: job.abort.signal }
    );
  } catch (error) {
    await fsp.unlink(filePath).catch(() => {});
    throw error;
  }
}

async function runDownloadJob(job) {
  emitDownloadProgress(job, { status: 'running', percent: 0 }, true);

  for (let i = 0; i < job.videos.length; i++) {
    if (job.abort.signal.aborted) break;

    try {
      await downloadOne(job, job.videos[i], i);
      job.progress.completed++;
    } catch (error) {
      if (job.abort.signal.aborted) break;
      job.progress.failed++;
      job.progress.lastError = error.message;
    }

    const doneItems = job.progress.completed + job.progress.failed;
    emitDownloadProgress(job, {
      current: '',
      currentBytes: 0,
      currentTotalBytes: 0,
      percent: job.progress.total > 0
        ? Math.min(99, Math.round((doneItems / job.progress.total) * 100))
        : 0,
    }, true);
  }

  if (job.abort.signal.aborted) {
    emitDownloadProgress(job, { status: 'cancelled' }, true);
  } else {
    emitDownloadProgress(job, { status: 'done', percent: 100, current: '' }, true);
  }

  if (activeDownload === job) activeDownload = null;
}

function registerDownloadIpc() {
  ipcMain.handle('downloads:start-board', async (event, payload = {}) => {
    if (activeDownload) {
      return { ok: false, error: 'Download is already running' };
    }

    const videos = Array.isArray(payload.videos)
      ? payload.videos.filter(v => v && typeof v.url === 'string' && v.url.startsWith('http'))
      : [];

    if (!videos.length) {
      return { ok: false, error: 'No videos to download' };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose download folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled || !result.filePaths?.[0]) {
      return { ok: false, cancelled: true };
    }

    const siteName = sanitizePathSegment(payload.siteName || payload.siteId || 'site', 'site');
    const boardId = sanitizePathSegment(payload.boardId || 'board', 'board');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputDir = path.join(result.filePaths[0], `multichan_${siteName}_${boardId}_${stamp}`);
    await fsp.mkdir(outputDir, { recursive: true });

    const estimatedBytes = videos.reduce((sum, v) => sum + (Number(v.size) > 0 ? Number(v.size) * 1024 : 0), 0);
    const job = {
      webContents: event.sender,
      outputDir,
      videos,
      abort: new AbortController(),
      lastSent: 0,
      progress: {
        status: 'starting',
        directory: outputDir,
        siteName: payload.siteName || payload.siteId || '',
        boardId: payload.boardId || '',
        boardTitle: payload.boardTitle || '',
        total: videos.length,
        completed: 0,
        failed: 0,
        downloadedBytes: 0,
        estimatedBytes,
        current: '',
        currentBytes: 0,
        currentTotalBytes: 0,
        percent: 0,
        lastError: '',
      },
    };

    activeDownload = job;
    runDownloadJob(job).catch(error => {
      job.progress.lastError = error.message;
      emitDownloadProgress(job, { status: 'error' }, true);
      if (activeDownload === job) activeDownload = null;
    });

    emitDownloadProgress(job, {}, true);
    return { ok: true, directory: outputDir, total: videos.length };
  });

  ipcMain.handle('downloads:cancel-current', async () => {
    if (!activeDownload) return { ok: false, error: 'No active download' };
    activeDownload.abort.abort();
    return { ok: true };
  });
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'multichan-videowall',
    icon: path.join(__dirname, '..', 'public', 'icon.svg'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  Menu.setApplicationMenu(null);

  // Open external links in user's browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://localhost:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  await mainWindow.loadURL(`http://localhost:${port}/`);
}

app.whenReady().then(async () => {
  const port = await findFreePort(Number(process.env.PORT) || 3000);
  serverPort = port;
  process.env.PORT = String(port);
  registerDownloadIpc();

  // Server.js is ESM — must use dynamic import from CJS.
  const serverModule = await import(
    'file://' + path.join(__dirname, '..', 'server.js').replace(/\\/g, '/')
  );
  await serverModule.startServer(port);

  await createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  // Standard: quit on every platform except macOS.
  if (process.platform !== 'darwin') app.quit();
});
