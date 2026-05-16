// ── Utils ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const proxy = (url, dl) => '/proxy?src=' + encodeURIComponent(url) + (dl ? '&dl=1' : '');
const fmtSize = kb => kb > 1024 ? (kb/1024).toFixed(1) + 'MB' : kb + 'KB';

// ── Themes ────────────────────────────────────────────────────────────────
const THEMES = [
  { id: '1', name: 'Glass Cathedral',     swatch: '#a888ff' },
  { id: '2', name: 'Brutalist Mono',      swatch: '#ffeb3b' },
  { id: '4', name: 'Cyberpunk Neon',      swatch: '#ff006e' },
  { id: '5', name: 'Soft Pastel · Light', swatch: '#ff8a80' },
  { id: '6', name: 'Terminal Hacker',     swatch: '#00ff66' },
];
const DEFAULT_THEME = '6';
const THEME_KEY = 'vw_theme';

function applyTheme(id) {
  if (!THEMES.find(t => t.id === id)) id = DEFAULT_THEME;
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(THEME_KEY, id); } catch {}
  document.querySelectorAll('.theme-dot').forEach(b => b.classList.toggle('active', b.dataset.id === id));
}
function buildThemeSwitcher() {
  const el = $('themeSwitcher');
  if (!el) return;
  el.innerHTML = '<span class="theme-switcher-label">theme</span>';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-dot';
    b.dataset.id = t.id;
    b.style.setProperty('--swatch', t.swatch);
    b.title = `${t.id}. ${t.name}`;
    b.onclick = () => applyTheme(t.id);
    el.appendChild(b);
  }
  // mark current
  const cur = document.documentElement.dataset.theme || DEFAULT_THEME;
  applyTheme(cur);
}
// Run early to avoid FOUC.
(function initThemeEarly() {
  let saved;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  document.documentElement.dataset.theme = saved && THEMES.find(t => t.id === saved) ? saved : DEFAULT_THEME;
})();

// ── Density (compact mode) ──
const DENSITY_KEY = 'vw_density';
function applyDensity(mode) {
  const m = mode === 'compact' ? 'compact' : 'comfy';
  document.documentElement.dataset.density = m;
  try { localStorage.setItem(DENSITY_KEY, m); } catch {}
  const btn = $('densityBtn');
  if (btn) {
    btn.classList.toggle('btn-active', m === 'compact');
    btn.title = m === 'compact' ? 'Now: compact (click → comfy)' : 'Now: comfy (click → compact)';
  }
}
(function initDensityEarly() {
  let saved;
  try { saved = localStorage.getItem(DENSITY_KEY); } catch {}
  document.documentElement.dataset.density = saved === 'compact' ? 'compact' : 'comfy';
})();

// ── PWA: register service worker ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let toastTimer;
function showToast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ── State (no persistence — fresh every navigation) ────────────────────────
const CHUNK = 60;
let sites      = [];
let categories = [];
let activeSite  = '2ch';
let activeBoard = 'b';

// Per-board cache lives ONLY for current board; cleared on every switch.
let videos    = [];      // raw videos for current board
let rendered  = 0;       // how many cards rendered so far
let currentIdx = -1;
let fetchingMore = false;

// Filters
let filterExt  = '';
let filterSort = '';
let boardFilter = '';

// ── Filtered list ──
function filteredVideos() {
  let list = videos;
  if (filterExt) list = list.filter(v => v.ext === filterExt);
  if (filterSort === 'sizeDesc') list = [...list].sort((a, b) => b.size - a.size);
  if (filterSort === 'sizeAsc')  list = [...list].sort((a, b) => a.size - b.size);
  if (filterSort === 'thread')   list = [...list].sort((a, b) => Number(a.thread) - Number(b.thread));
  return list;
}

// ── Status bar ──
const sDot = $('sDot'), sTxt = $('sTxt'), sCount = $('sCount');
function setStatus(s, msg) {
  sDot.className = 's-dot' + (s !== 'ok' ? ' ' + s : '');
  sTxt.textContent = msg;
}
function updateCount() {
  sCount.textContent = videos.length;
}

// ── Site lookup ──
function getSite(id)            { return sites.find(s => s.id === id); }
function getBoardMeta(siteId, boardId) {
  const s = getSite(siteId);
  return s?.boards.find(b => b.id === boardId);
}
function getCategoryMeta(id)    { return categories.find(c => c.id === id) || { id, title: id, icon: '📋' }; }

// ── Site tabs (top) ──
const siteTabsEl = $('siteTabs'), siteMetaEl = $('siteMeta');

function buildSiteTabs() {
  siteTabsEl.innerHTML = '';
  for (const s of sites) {
    const tab = document.createElement('button');
    tab.className = 'site-tab' + (s.id === activeSite ? ' active' : '');
    tab.dataset.id = s.id;
    tab.innerHTML = `
      <span class="site-flag">${s.flag}</span>
      <span class="site-name">${s.name}</span>
      <span class="site-lang">${s.lang}</span>`;
    tab.onclick = () => switchSite(s.id);
    siteTabsEl.appendChild(tab);
  }
  updateSiteMeta();
}
function updateSiteMeta() {
  const s = getSite(activeSite);
  if (!s) { siteMetaEl.textContent = ''; return; }
  siteMetaEl.innerHTML = `<span class="site-meta-num">${s.boards.length}</span> boards · <em>${s.lang}</em>`;
}

// ── Sidebar nav (boards by category) ──
const navEl = $('nav');
const mobileBoardEl = $('mobileBoard');
const boardFilterEl = $('boardFilter');

function buildNav() {
  navEl.innerHTML = '';
  mobileBoardEl.innerHTML = '';

  const site = getSite(activeSite);
  if (!site) return;

  // Group boards by category
  const groups = new Map();
  for (const b of site.boards) {
    const cat = b.category || 'misc';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(b);
  }

  // Render categories in CATEGORIES order, then leftover
  const ordered = [];
  for (const c of categories) if (groups.has(c.id)) ordered.push(c.id);
  for (const k of groups.keys()) if (!ordered.includes(k)) ordered.push(k);

  const flt = boardFilter.toLowerCase();

  for (const catId of ordered) {
    const boards = groups.get(catId).filter(b =>
      !flt || b.id.toLowerCase().includes(flt) || b.title.toLowerCase().includes(flt)
    );
    if (!boards.length) continue;

    const meta = getCategoryMeta(catId);
    const wrap = document.createElement('div');
    wrap.className = 'nav-cat';
    wrap.innerHTML = `<div class="nav-cat-head"><span>${meta.icon}</span><span>${meta.title}</span><span class="nav-cat-count">${boards.length}</span></div>`;

    const list = document.createElement('div');
    list.className = 'nav-cat-list';

    for (const b of boards) {
      const btn = document.createElement('button');
      btn.className = 'nav-item' + (b.id === activeBoard ? ' active' : '');
      btn.dataset.id = b.id;
      btn.innerHTML = `
        <span class="nav-icon">${b.icon || '📋'}</span>
        <span class="nav-name">/${b.id}/</span>
        <span class="nav-title">${b.title}</span>
        <div class="nav-progress"></div>`;
      btn.onclick = () => switchBoard(b.id);
      list.appendChild(btn);

      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `/${b.id}/ · ${b.title}`;
      mobileBoardEl.appendChild(opt);
    }
    wrap.appendChild(list);
    navEl.appendChild(wrap);
  }

  if (mobileBoardEl.value !== activeBoard) mobileBoardEl.value = activeBoard;
}

function navSetLoading(boardId, on) {
  const btn = navEl.querySelector(`.nav-item[data-id="${boardId}"]`);
  if (!btn) return;
  btn.classList.toggle('loading', on);
}

mobileBoardEl.onchange = () => {
  if (mobileBoardEl.value && mobileBoardEl.value !== activeBoard) switchBoard(mobileBoardEl.value);
};

boardFilterEl.addEventListener('input', () => {
  boardFilter = boardFilterEl.value.trim();
  buildNav();
});

// ── Topbar ──
const topBoard = $('topBoard'), topInfo = $('topInfo');
function updateTop(msg) {
  const meta = getBoardMeta(activeSite, activeBoard);
  const site = getSite(activeSite);
  topBoard.innerHTML = `<em>/${activeBoard}/</em> ${meta ? meta.title : ''} <span class="top-sep">·</span> <span class="top-site">${site?.name || ''}</span>`;
  if (msg !== undefined) topInfo.textContent = msg;
}

// ── Filters ──
$('fExt').onchange  = () => { filterExt  = $('fExt').value;  rerender(); };
$('fSort').onchange = () => { filterSort = $('fSort').value; rerender(); };

function rerender() {
  rendered = 0;
  grid.innerHTML = '';
  if (!videos.length) {
    grid.innerHTML = '<div class="empty"><div class="ico">🎬</div><b>Empty for now</b><p>Hit «Refresh» or pick another board</p></div>';
    return;
  }
  renderChunk();
}

// ── Lazy poster observer ──
// For sites that publish thumbs (most) we use a regular <img>.
// For sites with no thumbs (lainchan webm) we mount a muted <video preload=metadata>
// and seek to t=0.1 so the browser paints the first frame as a poster.
const posterIO = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    posterIO.unobserve(e.target);
    const idx = Number(e.target.dataset.vidIdx);
    const list = filteredVideos();
    const v = list[idx];
    if (!v) continue;
    const poster = e.target.querySelector('.card-poster');

    if (v.thumb) {
      const img = new Image();
      img.onload = () => {
        poster.style.backgroundImage = `url("${proxy(v.thumb)}")`;
        poster.classList.add('has-thumb');
        poster.classList.remove('placeholder');
      };
      img.src = proxy(v.thumb);
      continue;
    }

    // Fallback: first-frame snapshot via <video>.
    const vid = document.createElement('video');
    vid.className = 'card-frame-poster';
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    vid.src = proxy(v.url) + '#t=0.1';
    vid.onloadeddata = () => {
      poster.classList.add('has-thumb');
      poster.classList.remove('placeholder');
    };
    poster.appendChild(vid);
  }
}, { rootMargin: '700px 0px' });

// ── Card factory ──
function createCard(v, vidIdx) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.vidIdx = vidIdx;
  card.innerHTML = `
    <div class="card-thumb">
      <div class="card-poster placeholder"></div>
      <video class="preview" muted loop playsinline preload="none"></video>
      <div class="play-btn"><div class="play-icon"></div></div>
      <div class="card-ext">${v.ext || 'mp4'}</div>
      ${v.size ? `<div class="card-size">${fmtSize(v.size)}</div>` : ''}
    </div>
    <div class="card-info">
      <div class="card-meta"><em>/${v.board}/</em> · ${v.site}</div>
      <div class="card-thread">#${v.thread}</div>
    </div>`;

  const thumb = card.querySelector('.card-thumb');
  const prev  = card.querySelector('video.preview');
  let timer;
  thumb.addEventListener('mouseenter', () => {
    timer = setTimeout(() => {
      if (!prev.src) prev.src = proxy(v.url);
      prev.play().catch(() => {});
    }, 450);
  });
  thumb.addEventListener('mouseleave', () => { clearTimeout(timer); prev.pause(); });

  card.addEventListener('click', () => openModal(vidIdx));
  return card;
}

// ── Grid render ──
const grid = $('grid'), hint = $('hint');
function renderChunk() {
  const list  = filteredVideos();
  const start = rendered;
  const end   = Math.min(start + CHUNK, list.length);
  if (start >= end) {
    hint.textContent = list.length ? `All shown · ${list.length} videos` : '';
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(createCard(list[i], i));
  grid.appendChild(frag);

  Array.from(grid.querySelectorAll('.card')).slice(start).forEach(c => posterIO.observe(c));
  rendered = end;

  hint.textContent = rendered < list.length
    ? `Showing ${rendered} of ${list.length} · scroll ↓`
    : `All shown · ${list.length} videos`;
}

// ── Infinite scroll ──
const scrollIO = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    if (rendered < filteredVideos().length) renderChunk();
  }
}, { rootMargin: '900px 0px' });
scrollIO.observe($('sentinel'));

// ── Fetch ── (always fresh, no client cache)
async function loadBoard(siteId, boardId) {
  navSetLoading(boardId, true);
  setStatus('loading', 'loading…');
  updateTop('Loading…');
  showSkeletons(12);

  const t0 = performance.now();
  try {
    const url = `/api/snapshot?site=${encodeURIComponent(siteId)}&board=${encodeURIComponent(boardId)}&_=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'fetch error');

    // If user navigated away mid-fetch, drop the result.
    if (siteId !== activeSite || boardId !== activeBoard) return;

    videos = data.videos || [];
    rendered = 0;
    grid.innerHTML = '';

    if (!videos.length) {
      grid.innerHTML = '<div class="empty"><div class="ico">🎬</div><b>No videos found</b><p>No mp4/webm on this board right now</p></div>';
    } else {
      renderChunk();
    }

    updateCount();
    const ms = Math.round(performance.now() - t0);
    updateTop(`${videos.length} videos · loaded in ${ms}ms`);
    setStatus('ok', 'ok');
  } catch (e) {
    if (siteId !== activeSite || boardId !== activeBoard) return;
    grid.innerHTML = `<div class="empty err"><div class="ico">⚠️</div><b>Loading error</b><p>${e.message}</p></div>`;
    setStatus('error', 'error');
    updateTop('Error: ' + e.message);
  } finally {
    navSetLoading(boardId, false);
  }
}

function switchBoard(boardId) {
  if (boardId === activeBoard) {
    // Same board click — always refresh (no client cache)
    return refresh();
  }
  activeBoard = boardId;
  videos = [];
  rendered = 0;
  currentIdx = -1;
  buildNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadBoard(activeSite, activeBoard);
}

function switchSite(siteId) {
  if (siteId === activeSite) return;
  activeSite = siteId;
  // Pick first board of new site
  const s = getSite(siteId);
  activeBoard = s?.boards[0]?.id || 'b';
  videos = [];
  rendered = 0;
  currentIdx = -1;
  buildSiteTabs();
  buildNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadBoard(activeSite, activeBoard);
}

function refresh() {
  videos = [];
  rendered = 0;
  loadBoard(activeSite, activeBoard);
}

function showSkeletons(n) {
  grid.innerHTML = '';
  for (let i = 0; i < n; i++) grid.insertAdjacentHTML('beforeend',
    `<div class="skeleton"><div class="sk-thumb"></div><div class="sk-info"><div class="sk-line" style="width:55%"></div><div class="sk-line" style="width:30%"></div></div></div>`);
}

// ── Modal ──
const modal = $('modal'), mVid = $('mVid'), sheetTitle = $('sheetTitle');

// Volume persistence (across videos and reloads)
const VOLUME_KEY = 'vw_volume';
const MUTED_KEY  = 'vw_muted';
function applyVolumePrefs() {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    const m = localStorage.getItem(MUTED_KEY) === '1';
    if (Number.isFinite(v) && v >= 0 && v <= 1) mVid.volume = v;
    mVid.muted = m;
  } catch {}
}
mVid.addEventListener('volumechange', () => {
  try {
    localStorage.setItem(VOLUME_KEY, String(mVid.volume));
    localStorage.setItem(MUTED_KEY,  mVid.muted ? '1' : '0');
  } catch {}
});

function currentVideo() { return filteredVideos()[currentIdx]; }

function openModal(idx) {
  const list = filteredVideos();
  if (idx < 0 || idx >= list.length) return;
  currentIdx = idx;
  const v = list[idx];

  mVid.pause();
  mVid.innerHTML = '';
  mVid.removeAttribute('src');
  mVid.load();

  const src = document.createElement('source');
  src.src  = proxy(v.url);
  src.type = v.ext === 'webm' ? 'video/webm' : 'video/mp4';
  mVid.appendChild(src);
  mVid.load();
  applyVolumePrefs();
  mVid.addEventListener('canplay', () => mVid.play().catch(() => {}), { once: true });

  sheetTitle.textContent = `${v.site} · /${v.board}/ · #${v.thread} · ${v.url.split('/').pop()}`;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  stopSlideshow();
  modal.classList.remove('open');
  document.body.style.overflow = '';
  mVid.pause();
  mVid.innerHTML = '';
  mVid.removeAttribute('src');
  mVid.load();
  currentIdx = -1;
}

$('closeBtn').onclick = closeModal;
$('prevBtn').onclick  = () => { const n = filteredVideos().length; openModal((currentIdx - 1 + n) % n); };
$('nextBtn').onclick  = () => { const n = filteredVideos().length; openModal((currentIdx + 1) % n); };
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

$('copyBtn').onclick = () => {
  const v = currentVideo();
  if (!v) return;
  navigator.clipboard.writeText(v.url).then(() => showToast('🔗 Link copied'));
};
$('dlBtn').onclick = () => {
  const v = currentVideo();
  if (!v) return;
  const a = document.createElement('a');
  a.href = proxy(v.url, true);
  a.download = v.url.split('/').pop();
  a.click();
};

// ── Keyboard ──
window.addEventListener('keydown', e => {
  if (!modal.classList.contains('open')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;

  if (e.key === 'Escape')      { closeModal(); return; }
  if (e.key === 'ArrowRight')  { $('nextBtn').click(); return; }
  if (e.key === 'ArrowLeft')   { $('prevBtn').click(); return; }
  if (e.key === ' ')           { e.preventDefault(); mVid.paused ? mVid.play().catch(()=>{}) : mVid.pause(); return; }
  if (e.key === 'f' || e.key === 'F') { mVid.requestFullscreen?.().catch(()=>{}); return; }
  if (e.key === 'm' || e.key === 'M') { mVid.muted = !mVid.muted; return; }
});

// ── Slideshow ──
let ssRaf = null;
const ssBar = $('ssBar'), ssBarFill = $('ssBarFill'), ssBtn = $('ssBtn');

function startSlideshow() {
  const list = filteredVideos();
  if (!list.length) return;
  if (currentIdx < 0) openModal(0);
  ssBar.classList.add('active');
  ssBtn.classList.add('btn-active');
  ssBtn.querySelector('.btn-ic').textContent = '⏹';
  ssBtn.childNodes[1].textContent = ' Stop';

  const DURATION = 8000;
  let elapsed = 0;
  let last = performance.now();

  function tick(now) {
    if (!ssRaf) return;
    const dt = now - last; last = now;
    elapsed += dt;
    const pct = Math.min(elapsed / DURATION * 100, 100);
    ssBarFill.style.width = pct + '%';
    ssBarFill.style.transition = 'none';
    if (elapsed >= DURATION) {
      elapsed = 0;
      ssBarFill.style.width = '0%';
      const n = filteredVideos().length;
      openModal((currentIdx + 1) % n);
    }
    ssRaf = requestAnimationFrame(tick);
  }
  ssRaf = requestAnimationFrame(tick);
}

function stopSlideshow() {
  if (ssRaf) { cancelAnimationFrame(ssRaf); ssRaf = null; }
  ssBar.classList.remove('active');
  ssBtn.classList.remove('btn-active');
  ssBtn.querySelector('.btn-ic').textContent = '▶';
  ssBtn.childNodes[1].textContent = ' Slideshow';
  ssBarFill.style.width = '0%';
}

ssBtn.onclick = () => {
  if (ssRaf) { stopSlideshow(); return; }
  if (!modal.classList.contains('open')) {
    if (filteredVideos().length) openModal(0);
    else { showToast('No videos'); return; }
  }
  startSlideshow();
};

// ── FAB ──
const fab = $('fab');
fab.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
window.addEventListener('scroll', () => {
  fab.classList.toggle('show', window.scrollY > 500);
}, { passive: true });

// ── Refresh ──
$('refreshBtn').onclick = refresh;

// ── Density toggle ──
$('densityBtn').onclick = () => {
  const cur = document.documentElement.dataset.density === 'compact' ? 'comfy' : 'compact';
  applyDensity(cur);
};

// ── Init ──
async function init() {
  buildThemeSwitcher();
  applyDensity(document.documentElement.dataset.density);
  setStatus('loading', 'initializing…');
  try {
    const r = await fetch('/api/sites', { cache: 'no-store' });
    const data = await r.json();
    sites      = data.sites || [];
    categories = data.categories || [];
  } catch {
    sites = [];
    categories = [];
  }

  if (!sites.length) {
    grid.innerHTML = '<div class="empty err"><div class="ico">⚠️</div><b>Failed to load site list</b></div>';
    setStatus('error', 'no sites');
    return;
  }

  // Defaults: first site, its first board
  activeSite  = sites[0].id;
  activeBoard = sites[0].boards[0]?.id || 'b';

  buildSiteTabs();
  buildNav();
  await loadBoard(activeSite, activeBoard);
}

init();
