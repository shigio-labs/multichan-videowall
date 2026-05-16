// Electron main process: boots the embedded Express server, then opens a window.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');
const net  = require('node:net');

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
  process.env.PORT = String(port);

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
