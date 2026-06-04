import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Readable, pipeline } from "node:stream";
import { fetch, Agent, setGlobalDispatcher } from "undici";
import pLimit from "p-limit";

// ─── Agent ───────────────────────────────────────────────────────────────────
const globalAgent = new Agent({
  bodyTimeout: 0,
  headersTimeout: 60_000,
  connectTimeout: 60_000,
  keepAliveTimeout: 30_000,
});
setGlobalDispatcher(globalAgent);

// ─── Config ───────────────────────────────────────────────────────────────────
const app  = express();
const PORT = Number(process.env.PORT || 3000);
const DEBUG = process.env.DEBUG === "true";
const RATE_WINDOW = 60_000;
const RATE_LIMIT  = 60;
const MAX_THREADS = 100;
const MAX_VIDEOS  = 1500;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts  = () => new Date().toISOString().slice(11, 19);
const logI = (...a) => console.log(`[${ts()}] [INFO]`, ...a);
const logW = (...a) => console.warn(`[${ts()}] [WARN]`, ...a);
const logE = (...a) => console.error(`[${ts()}] [ERR ]`, ...a);

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: "random",    title: "Random",     icon: "🎲" },
  { id: "tech",      title: "Tech",       icon: "💻" },
  { id: "games",     title: "Games",      icon: "🎮" },
  { id: "anime",     title: "Anime",      icon: "🎌" },
  { id: "media",     title: "Media",      icon: "🎬" },
  { id: "lifestyle", title: "Lifestyle",  icon: "🌿" },
  { id: "adult",     title: "NSFW",       icon: "🔞" },
];

// ─── Sites ────────────────────────────────────────────────────────────────────
// Each site has its own fetcher and board list. Easy to extend.
const SITES = {
  "2ch": {
    id: "2ch",
    name: "2ch.hk",
    lang: "Russian",
    flag: "🇷🇺",
    // 2ch.hk currently redirects to 2ch.org; 2ch.life returns 403 — these two are alive.
    bases: ["https://2ch.hk", "https://2ch.org"],
    fetcher: "dvach",
    boards: [
      { id: "b",   title: "Random",      icon: "🎲", category: "random" },
      { id: "rf",  title: "Refuge",      icon: "🗣️", category: "random" },
      { id: "po",  title: "Politics",    icon: "🗳️", category: "random" },
      { id: "vg",  title: "Game Generals", icon: "🎮", category: "games" },
      { id: "v",   title: "Video Games", icon: "🕹️", category: "games" },
      { id: "wp",  title: "Wallpapers",  icon: "🖼️", category: "media" },
      { id: "mu",  title: "Music",       icon: "🎵", category: "media" },
      { id: "mov", title: "Movies",      icon: "🎬", category: "media" },
      { id: "tv",  title: "TV",          icon: "📺", category: "media" },
      { id: "a",   title: "Anime",       icon: "🎌", category: "anime" },
      { id: "ja",  title: "Japan",       icon: "🗾", category: "anime" },
      { id: "spc", title: "Sports",      icon: "⚽", category: "lifestyle" },
      { id: "fiz", title: "Fitness",     icon: "🏋️", category: "lifestyle" },
      { id: "au",  title: "Auto",        icon: "🚗", category: "lifestyle" },
      { id: "fa",  title: "Fashion",     icon: "👗", category: "lifestyle" },
      { id: "ne",  title: "Nature",      icon: "🌲", category: "lifestyle" },
      { id: "hw",  title: "Hardware",    icon: "💻", category: "tech" },
      { id: "s",   title: "Software",    icon: "🖥️", category: "tech" },
      { id: "pr",  title: "Programming", icon: "👨‍💻", category: "tech" },
      { id: "cg",  title: "3D/CG",       icon: "🎨", category: "tech" },
      { id: "sex", title: "Sex",         icon: "🔞", category: "adult" },
      { id: "gg",  title: "Girls",       icon: "🔞", category: "adult" },
      { id: "fet", title: "Fetishes",    icon: "🔞", category: "adult" },
    ],
  },

  "4chan": {
    id: "4chan",
    name: "4chan",
    lang: "English",
    flag: "🇺🇸",
    bases: ["https://a.4cdn.org"],
    mediaBase: "https://i.4cdn.org",
    fetcher: "4chan",
    boards: [
      { id: "wsg", title: "Worksafe GIF", icon: "🎞️", category: "random" },
      { id: "gif", title: "Adult GIF",    icon: "🔞", category: "adult" },
      { id: "b",   title: "Random",       icon: "🎲", category: "random" },
      { id: "pol", title: "Politics",     icon: "🗳️", category: "random" },
      { id: "int", title: "International",icon: "🌐", category: "random" },
      { id: "g",   title: "Technology",   icon: "💻", category: "tech" },
      { id: "diy", title: "DIY",          icon: "🔧", category: "tech" },
      { id: "sci", title: "Science",      icon: "🧪", category: "tech" },
      { id: "v",   title: "Video Games",  icon: "🎮", category: "games" },
      { id: "vg",  title: "Game Generals",icon: "🎮", category: "games" },
      { id: "vp",  title: "Pokémon",      icon: "🐉", category: "games" },
      { id: "vr",  title: "Retro Games",  icon: "👾", category: "games" },
      { id: "vt",  title: "VTubers",      icon: "🦊", category: "games" },
      { id: "a",   title: "Anime/Manga",  icon: "🎌", category: "anime" },
      { id: "c",   title: "Cute Anime",   icon: "🌸", category: "anime" },
      { id: "jp",  title: "Otaku Culture",icon: "🗾", category: "anime" },
      { id: "w",   title: "Wallpapers",   icon: "🖼️", category: "anime" },
      { id: "mu",  title: "Music",        icon: "🎵", category: "media" },
      { id: "tv",  title: "Television",   icon: "📺", category: "media" },
      { id: "co",  title: "Cartoons",     icon: "🎨", category: "media" },
      { id: "lit", title: "Literature",   icon: "📚", category: "media" },
      { id: "p",   title: "Photography",  icon: "📷", category: "media" },
      { id: "sp",  title: "Sports",       icon: "⚽", category: "lifestyle" },
      { id: "fit", title: "Fitness",      icon: "💪", category: "lifestyle" },
      { id: "k",   title: "Weapons",      icon: "🔫", category: "lifestyle" },
      { id: "o",   title: "Auto",         icon: "🚗", category: "lifestyle" },
      { id: "ck",  title: "Food/Cooking", icon: "🍳", category: "lifestyle" },
      { id: "out", title: "Outdoors",     icon: "🌲", category: "lifestyle" },
      { id: "trv", title: "Travel",       icon: "✈️", category: "lifestyle" },
      { id: "h",   title: "Hentai",       icon: "🔞", category: "adult" },
      { id: "d",   title: "Hentai/Alt",   icon: "🔞", category: "adult" },
      { id: "s",   title: "Beautiful Girls", icon: "🔞", category: "adult" },
      { id: "hc",  title: "Hardcore",     icon: "🔞", category: "adult" },
      { id: "u",   title: "Yuri",         icon: "🔞", category: "adult" },
      { id: "y",   title: "Yaoi",         icon: "🔞", category: "adult" },
    ],
  },

  "lainchan": {
    id: "lainchan",
    name: "Lainchan",
    lang: "English · tech",
    flag: "🌐",
    bases: ["https://lainchan.org"],
    fetcher: "vichan",
    noVideoThumbs: true,    // lainchan не генерирует thumbs для webm/mp4
    boards: [
      { id: "λ",     title: "Programming",  icon: "💾", category: "tech" },
      { id: "tech",  title: "Technology",   icon: "💻", category: "tech" },
      { id: "sec",   title: "Security",     icon: "🔐", category: "tech" },
      { id: "Ω",     title: "Sciences",     icon: "🧪", category: "tech" },
      { id: "inter", title: "Internet",     icon: "🌐", category: "tech" },
      { id: "music", title: "Music",        icon: "🎵", category: "media" },
      { id: "vis",   title: "Visual Arts",  icon: "🎨", category: "media" },
      { id: "lit",   title: "Literature",   icon: "📚", category: "media" },
      { id: "diy",   title: "DIY",          icon: "🔧", category: "tech" },
      { id: "culture", title: "Culture",    icon: "🌐", category: "media" },
      { id: "r",     title: "Random",       icon: "🎲", category: "random" },
    ],
  },

  "kohlchan": {
    id: "kohlchan",
    name: "Kohlchan",
    lang: "Deutsch",
    flag: "🇩🇪",
    // kohlchan.net лёг весной 2026, переехали на krautchan.org. Старый
    // домен оставлен на случай возвращения; .org → 301 на krautchan.
    bases: ["https://krautchan.org", "https://kohlchan.net"],
    fetcher: "lynxchan",
    boards: [
      { id: "b",    title: "Bernd",         icon: "🎲", category: "random" },
      { id: "int",  title: "International", icon: "🌐", category: "random" },
      { id: "ru",   title: "Russian",       icon: "🇷🇺", category: "random" },
      { id: "a",    title: "Anime",         icon: "🎌", category: "anime" },
      { id: "jp",   title: "Japan",         icon: "🗾", category: "anime" },
      { id: "n",    title: "Nachrichten",   icon: "📰", category: "media" },
      { id: "m",    title: "Musik",         icon: "🎵", category: "media" },
      { id: "w",    title: "Wallpaper",     icon: "🖼️", category: "media" },
      { id: "e",    title: "Edel",          icon: "✨", category: "adult" },
    ],
  },

  "kissu": {
    id: "kissu",
    name: "Kissu",
    lang: "日本語 · otaku",
    flag: "🗾",
    bases: ["https://kissu.moe"],
    fetcher: "vichan",
    boards: [
      { id: "qa",   title: "Question/Answer",  icon: "❓", category: "random" },
      { id: "jp",   title: "Otaku Culture",    icon: "🎌", category: "anime" },
      { id: "ec",   title: "Ecchi",            icon: "🔞", category: "adult" },
      { id: "spg",  title: "Sportsball",       icon: "⚽", category: "lifestyle" },
      { id: "test", title: "Test",             icon: "🧪", category: "tech" },
    ],
  },

  "wizchan": {
    id: "wizchan",
    name: "Wizchan",
    lang: "English",
    flag: "🧙",
    bases: ["https://wizchan.org"],
    fetcher: "vichan",
    boards: [
      { id: "wiz",  title: "Wizardry",      icon: "🪄", category: "random" },
      { id: "dep",  title: "Depression",    icon: "🌧️", category: "random" },
      { id: "hob",  title: "Hobbies",       icon: "🎯", category: "lifestyle" },
      { id: "lounge", title: "Lounge",      icon: "🛋️", category: "random" },
      { id: "jp",   title: "Otaku",         icon: "🎌", category: "anime" },
      { id: "games",title: "Games",         icon: "🎮", category: "games" },
      { id: "music",title: "Music",         icon: "🎵", category: "media" },
    ],
  },

  "uboachan": {
    id: "uboachan",
    name: "Uboachan",
    lang: "English",
    flag: "UB",
    bases: ["https://uboachan.net"],
    fetcher: "vichan",
    boards: [
      { id: "yume", title: "Yume Nikki", icon: "YN", category: "games" },
      { id: "yn",   title: "Yume 2kki",  icon: "YN", category: "games" },
      { id: "fg",   title: "Fangames",   icon: "FG", category: "games" },
      { id: "og",   title: "Other Games",icon: "OG", category: "games" },
      { id: "rec",  title: "Recovery",   icon: "RC", category: "random" },
      { id: "o",    title: "Oekaki",     icon: "OK", category: "media" },
      { id: "lit",  title: "Literature", icon: "LT", category: "media" },
      { id: "ot",   title: "Off-topic",  icon: "OT", category: "random" },
    ],
  },

  "smuglo": {
    id: "smuglo",
    name: "Smuglo",
    lang: "English",
    flag: "SM",
    bases: ["https://smuglo.li"],
    fetcher: "vichan",
    boards: [
      { id: "a",    title: "Anime", icon: "A", category: "anime" },
      { id: "kohi", title: "Kohi",  icon: "K", category: "random" },
    ],
  },

  "arisuchan": {
    id: "arisuchan",
    name: "Arisuchan",
    lang: "English · tech",
    flag: "AR",
    bases: ["https://arisuchan.moe"],
    fetcher: "vichan",
    noVideoThumbs: true,
    boards: [
      { id: "λ", title: "Programming", icon: "L", category: "tech" },
      { id: "r", title: "Random",      icon: "R", category: "random" },
    ],
  },

  "endchan": {
    id: "endchan",
    name: "Endchan",
    lang: "English",
    flag: "EN",
    bases: ["https://endchan.org"],
    fetcher: "endchan",
    boards: [
      { id: "b",       title: "Random",     icon: "B",  category: "random" },
      { id: "pol",     title: "Politics",   icon: "P",  category: "random" },
      { id: "tech",    title: "Technology", icon: "T",  category: "tech" },
      { id: "v",       title: "Games",      icon: "V",  category: "games" },
      { id: "a",       title: "Anime",      icon: "A",  category: "anime" },
      { id: "am",      title: "Alt-media",  icon: "AM", category: "media" },
      { id: "operate", title: "Operate",    icon: "OP", category: "tech" },
    ],
  },

};

// ─── Allowed media domains for proxy ──────────────────────────────────────────
const ALLOWED_DOMAINS = [
  "2ch.hk", "2ch.org", "2ch.pm",
  "m2ch.hk", "m2ch.lib", "m2ch.cf",
  "4cdn.org", "i.4cdn.org",
  "lainchan.org",
  "kohlchan.net", "krautchan.org",
  "wizchan.org",
  "kissu.moe",
  "uboachan.net",
  "smuglo.li",
  "arisuchan.moe",
  "endchan.org",
];

// ─── Network constants ────────────────────────────────────────────────────────
const COMMON_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control":   "no-cache",
};

function siteHeaders(site) {
  // Site-specific Referer/Origin keeps imageboards happy.
  const base = site.bases[0];
  return {
    ...COMMON_HEADERS,
    "Referer": base + "/",
    "Origin":  base,
  };
}

// host → referer (longest match wins)
const REFERER_MAP = [
  ["4cdn.org",      "https://boards.4chan.org/"],
  ["lainchan.org",  "https://lainchan.org/"],
  ["kohlchan.net",  "https://kohlchan.net/"],
  ["krautchan.org", "https://krautchan.org/"],
  ["wizchan.org",   "https://wizchan.org/"],
  ["kissu.moe",     "https://kissu.moe/"],
  ["uboachan.net",   "https://uboachan.net/"],
  ["smuglo.li",      "https://smuglo.li/"],
  ["arisuchan.moe",  "https://arisuchan.moe/"],
  ["endchan.org",    "https://endchan.org/"],
];

function proxyHeadersFor(url) {
  try {
    const host = new URL(url).hostname;
    for (const [needle, ref] of REFERER_MAP) {
      if (host.includes(needle)) return { ...COMMON_HEADERS, "Referer": ref };
    }
  } catch {}
  // 2ch family default
  return { ...COMMON_HEADERS, "Referer": "https://2ch.hk/", "Origin": "https://2ch.hk" };
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
const metrics = {
  snapshotRequests: 0,
  proxyRequests:    0,
  errors:           0,
  latency:          {},   // host -> [ms,...]
  startedAt:        Date.now(),
};

function recordLatency(host, ms) {
  if (!metrics.latency[host]) metrics.latency[host] = [];
  const arr = metrics.latency[host];
  arr.push(ms);
  if (arr.length > 200) arr.shift();
}
function avgLatency(host) {
  const arr = metrics.latency[host] || [];
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const MEDIA_EXTS = {
  video: new Set(["mp4", "webm"]),
  image: new Set(["jpg", "jpeg", "png", "gif", "webp"]),
};

function normalizeMediaType(value) {
  return value === "image" ? "image" : "video";
}

function getExt(p, mime = "") {
  const pathExt = String(p || "").split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (pathExt) return pathExt;
  const mimeExt = String(mime || "").split("/").pop()?.toLowerCase();
  if (mimeExt === "jpeg") return "jpg";
  if (mimeExt === "svg+xml") return "svg";
  return mimeExt || "";
}

function isMediaExt(ext, mediaType) {
  return MEDIA_EXTS[normalizeMediaType(mediaType)].has(String(ext || "").toLowerCase());
}

function isMediaPath(p, mediaType, mime = "") {
  return isMediaExt(getExt(p, mime), mediaType);
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function vichanThumbUrls(base, boardId, file, ext, mediaType, site) {
  if (!file?.tim || site.noVideoThumbs) return [];
  const stem = `${base}/${encodeURIComponent(boardId)}/thumb/${file.tim}`;
  const media = normalizeMediaType(mediaType);
  if (media === "image") {
    return uniqueUrls([
      `${stem}.jpg`,
      ext && !["jpg", "jpeg"].includes(ext) ? `${stem}.${ext}` : null,
    ]);
  }
  return uniqueUrls([
    `${stem}.jpg`,
    ext ? `${stem}.${ext}` : null,
  ]);
}

function normalizeMediaUrl(maybeUrl, base) {
  try {
    const u = new URL(maybeUrl, base);
    if (!ALLOWED_DOMAINS.some(d => u.hostname.includes(d))) return null;
    return u.toString();
  } catch { return null; }
}

async function fetchJson(url, headers) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    try { recordLatency(new URL(url).hostname, Date.now() - t0); } catch {}
    return json;
  } catch (e) {
    if (DEBUG) logW(`fetch ${url} → ${e.message}`);
    throw e;
  }
}

function dedup(videos) {
  const seen = new Set();
  return videos.filter(v => {
    if (seen.has(v.url)) return false;
    seen.add(v.url);
    return true;
  });
}

function limitMediaList(videos) {
  return dedup(videos).slice(0, MAX_VIDEOS);
}

// ─── 2ch.hk / Makaba fetcher ──────────────────────────────────────────────────
async function fetchDvach(site, boardId, mediaType = "video") {
  const headers = siteHeaders(site);
  const paths = [
    `/${boardId}/threads.json`,
    `/${boardId}/catalog.json`,
    `/${boardId}/index.json`,
  ];

  let active = null;
  outer: for (const base of site.bases) {
    for (const p of paths) {
      try {
        const json = await fetchJson(`${base}${p}`, headers);
        active = { base, json };
        logI(`2ch listing ← ${base}${p}`);
        break outer;
      } catch { /* try next */ }
    }
  }
  if (!active) throw new Error("All 2ch mirrors unavailable");

  const threads = (active.json?.threads || active.json || []).slice(0, MAX_THREADS);
  const nums    = threads.map(t => String(t.num || t.id)).filter(Boolean);
  const limit   = pLimit(6);

  const promises = nums.map(num =>
    limit(async () => {
      try {
        const data  = await fetchJson(`${active.base}/${boardId}/res/${num}.json`, headers);
        const posts = data?.threads?.[0]?.posts || data?.posts || [];
        return posts.flatMap(p =>
          (p.files || []).map(f => {
            const url = normalizeMediaUrl(f.path || f.fullname, active.base);
            const ext = getExt(url);
            if (!url || !isMediaExt(ext, mediaType)) return null;
            return {
              url,
              ext,
              media:  normalizeMediaType(mediaType),
              thumb:  normalizeMediaUrl(f.thumbnail || f.tn_path, active.base),
              size:   f.size || 0,
              thread: num,
              board:  boardId,
              site:   site.id,
            };
          }).filter(Boolean)
        );
      } catch { return []; }
    })
  );

  const results = [];
  for (const p of promises) {
    results.push(...(await p));
    if (results.length >= MAX_VIDEOS) break;
  }
  return limitMediaList(results);
}

// ─── 4chan fetcher ────────────────────────────────────────────────────────────
async function fetch4chan(site, boardId, mediaType = "video") {
  const apiBase   = site.bases[0];
  const mediaBase = site.mediaBase;
  const headers   = siteHeaders(site);

  let nums = [];
  try {
    const pages = await fetchJson(`${apiBase}/${boardId}/threads.json`, headers);
    nums = (Array.isArray(pages) ? pages : []).flatMap(p =>
      (p.threads || []).map(t => String(t.no))
    );
    logI(`4chan ${boardId} threads: ${nums.length}`);
  } catch (e) {
    throw new Error(`4chan threads ${boardId}: ${e.message}`);
  }

  nums = nums.slice(0, MAX_THREADS);
  const limit = pLimit(8);

  const promises = nums.map(num =>
    limit(async () => {
      try {
        const data  = await fetchJson(`${apiBase}/${boardId}/thread/${num}.json`, headers);
        const posts = data?.posts || [];
        return posts.flatMap(p => {
          if (!p.tim || !p.ext) return [];
          const ext = String(p.ext).replace(".", "").toLowerCase();
          if (!isMediaExt(ext, mediaType)) return [];
          return [{
            url:    `${mediaBase}/${boardId}/${p.tim}${p.ext}`,
            ext,
            media:  normalizeMediaType(mediaType),
            thumb:  `${mediaBase}/${boardId}/${p.tim}s.jpg`,
            size:   p.fsize ? Math.round(p.fsize / 1024) : 0,
            thread: num,
            board:  boardId,
            site:   site.id,
          }];
        });
      } catch { return []; }
    })
  );

  const results = [];
  for (const p of promises) {
    results.push(...(await p));
    if (results.length >= MAX_VIDEOS) break;
  }
  return limitMediaList(results);
}

// ─── Vichan / Lainchan fetcher ────────────────────────────────────────────────
async function fetchVichan(site, boardId, mediaType = "video") {
  const base    = site.bases[0];
  const headers = siteHeaders(site);

  let nums = [];
  try {
    const pages = await fetchJson(`${base}/${encodeURIComponent(boardId)}/threads.json`, headers);
    nums = (Array.isArray(pages) ? pages : []).flatMap(p =>
      (p.threads || []).map(t => String(t.no))
    );
    logI(`vichan ${boardId} threads: ${nums.length}`);
  } catch (e) {
    throw new Error(`vichan threads ${boardId}: ${e.message}`);
  }

  nums = nums.slice(0, MAX_THREADS);
  const limit = pLimit(4);

  const promises = nums.map(num =>
    limit(async () => {
      try {
        const data  = await fetchJson(`${base}/${encodeURIComponent(boardId)}/res/${num}.json`, headers);
        const posts = data?.posts || [];
        return posts.flatMap(p => {
          const files = [];
          if (p.tim && p.ext) files.push({ tim: p.tim, ext: p.ext, fsize: p.fsize });
          if (Array.isArray(p.extra_files)) {
            for (const ef of p.extra_files) {
              if (ef.tim && ef.ext) files.push({ tim: ef.tim, ext: ef.ext, fsize: ef.fsize });
            }
          }
          return files.flatMap(f => {
            const ext = String(f.ext).replace(".", "").toLowerCase();
            if (!isMediaExt(ext, mediaType)) return [];
            const thumbs = vichanThumbUrls(base, boardId, f, ext, mediaType, site);
            return [{
              url:    `${base}/${encodeURIComponent(boardId)}/src/${f.tim}${f.ext}`,
              ext,
              media:  normalizeMediaType(mediaType),
              thumb:  thumbs[0] || null,
              thumbs,
              size:   f.fsize ? Math.round(f.fsize / 1024) : 0,
              thread: num,
              board:  boardId,
              site:   site.id,
            }];
          });
        });
      } catch { return []; }
    })
  );

  const results = [];
  for (const p of promises) {
    results.push(...(await p));
    if (results.length >= MAX_VIDEOS) break;
  }
  return limitMediaList(results);
}

// ─── LynxChan fetcher (kohlchan) ────────────────────────────────────
async function fetchLynxchan(site, boardId, mediaType = "video") {
  const headers = siteHeaders(site);

  // Catalog returns array of OP threads; sometimes we get OP files there too.
  // Distinguish "mirror unreachable" (throw) vs "empty board" (return []).
  let active = null;
  let lastError = null;
  for (const base of site.bases) {
    try {
      const json = await fetchJson(`${base}/${boardId}/catalog.json`, headers);
      if (Array.isArray(json)) {
        active = { base, json };
        logI(`lynxchan listing ← ${base}/${boardId}/catalog.json (${json.length})`);
        break;
      }
    } catch (e) { lastError = e; }
  }
  if (!active) throw new Error(`Catalog /${boardId}/ unavailable on ${site.name}${lastError ? ': ' + lastError.message : ''}`);
  if (active.json.length === 0) return [];

  const nums = active.json.map(t => String(t.threadId)).filter(Boolean).slice(0, MAX_THREADS);
  const limit = pLimit(5);

  const collectFiles = (post, num) => {
    const out = [];
    for (const f of (post.files || [])) {
      if (!f.path) continue;
      const ext = getExt(f.path, f.mime);
      if (!isMediaExt(ext, mediaType)) continue;
      out.push({
        url:    new URL(f.path, active.base).toString(),
        ext,
        media:  normalizeMediaType(mediaType),
        thumb:  f.thumb ? new URL(f.thumb, active.base).toString() : null,
        size:   f.size ? Math.round(f.size / 1024) : 0,
        thread: num,
        board:  boardId,
        site:   site.id,
      });
    }
    return out;
  };

  const promises = nums.map(num =>
    limit(async () => {
      try {
        const data = await fetchJson(`${active.base}/${boardId}/res/${num}.json`, headers);
        const all  = [...collectFiles(data, num)];
        for (const p of (data.posts || [])) all.push(...collectFiles(p, num));
        return all;
      } catch { return []; }
    })
  );

  const results = [];
  for (const p of promises) {
    results.push(...(await p));
    if (results.length >= MAX_VIDEOS) break;
  }
  return limitMediaList(results);
}

// ─── Endchan fetcher ──────────────────────────────────────────────────────────
async function fetchEndchan(site, boardId, mediaType = "video") {
  const base = site.bases[0];
  const headers = siteHeaders(site);

  let catalog = [];
  try {
    const json = await fetchJson(`${base}/${boardId}/catalog.json`, headers);
    if (!Array.isArray(json)) throw new Error("bad catalog");
    catalog = json;
    logI(`endchan ${boardId} catalog: ${catalog.length}`);
  } catch (e) {
    throw new Error(`Endchan catalog /${boardId}/ unavailable: ${e.message}`);
  }

  const nums = catalog.map(t => String(t.threadId || t.postId || t.id)).filter(Boolean).slice(0, MAX_THREADS);
  const limit = pLimit(5);

  const collectFiles = (post, num) => {
    const out = [];
    for (const f of (post.files || [])) {
      const rawPath = f.path || f.url || f.href;
      if (!rawPath) continue;
      const ext = getExt(rawPath, f.mime);
      if (!isMediaExt(ext, mediaType)) continue;
      const url = normalizeMediaUrl(rawPath, base);
      if (!url) continue;
      out.push({
        url,
        ext,
        media:  normalizeMediaType(mediaType),
        thumb:  f.thumb ? normalizeMediaUrl(f.thumb, base) : null,
        size:   f.size ? Math.round(f.size / 1024) : 0,
        thread: num,
        board:  boardId,
        site:   site.id,
      });
    }
    return out;
  };

  const promises = nums.map(num =>
    limit(async () => {
      try {
        const data = await fetchJson(`${base}/${boardId}/res/${num}.json`, headers);
        const all = [...collectFiles(data, num)];
        for (const p of (data.posts || [])) all.push(...collectFiles(p, num));
        return all;
      } catch { return []; }
    })
  );

  const results = [];
  for (const p of promises) {
    results.push(...(await p));
    if (results.length >= MAX_VIDEOS) break;
  }
  return limitMediaList(results);
}

const FETCHERS = {
  "dvach":    fetchDvach,
  "4chan":    fetch4chan,
  "vichan":   fetchVichan,
  "lynxchan": fetchLynxchan,
  "endchan":  fetchEndchan,
};

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const rateMap = new Map();

function rateLimit(req, res, next) {
  const ip   = req.ip || req.socket?.remoteAddress || "unknown";
  const now  = Date.now();
  let   rec  = rateMap.get(ip);

  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + RATE_WINDOW };
    rateMap.set(ip, rec);
  }
  rec.count++;
  if (rec.count > RATE_LIMIT) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded" });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateMap) if (now > rec.resetAt) rateMap.delete(ip);
}, 60_000);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(express.json());

// Sites + categories
app.get("/api/sites", (_req, res) => {
  const sites = Object.values(SITES).map(s => ({
    id:     s.id,
    name:   s.name,
    lang:   s.lang,
    flag:   s.flag,
    boards: s.boards,
  }));
  res.set("Cache-Control", "no-store");
  res.json({ sites, categories: CATEGORIES });
});

// Snapshot — always fresh, no cache
app.get("/api/snapshot", rateLimit, async (req, res) => {
  metrics.snapshotRequests++;
  const siteId  = String(req.query.site  || "2ch").replace(/[^a-z0-9]/gi, "");
  const boardId = String(req.query.board || "b").trim();
  const mediaType = normalizeMediaType(req.query.media);

  const site = SITES[siteId];
  if (!site) return res.status(404).json({ ok: false, error: "Unknown site" });
  if (!site.boards.find(b => b.id === boardId))
    return res.status(404).json({ ok: false, error: `No board /${boardId}/ on ${site.name}` });

  const fetcher = FETCHERS[site.fetcher];
  if (!fetcher) return res.status(500).json({ ok: false, error: "Adapter not found" });

  const t0 = Date.now();
  try {
    const videos = await fetcher(site, boardId, mediaType);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      ok:     true,
      site:   site.id,
      board:  boardId,
      media:  mediaType,
      count:  videos.length,
      tookMs: Date.now() - t0,
      videos,
    });
    logI(`snapshot ${site.id}/${boardId}/${mediaType}: ${videos.length} items in ${Date.now()-t0}ms`);
  } catch (e) {
    metrics.errors++;
    logE(`snapshot ${site.id}/${boardId}/${mediaType}: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Metrics
app.get("/api/metrics", (_req, res) => {
  const uptime = Math.round((Date.now() - metrics.startedAt) / 1000);
  const hosts = {};
  for (const [host, arr] of Object.entries(metrics.latency)) {
    hosts[host] = { avgMs: avgLatency(host), samples: arr.length };
  }
  res.set("Cache-Control", "no-store");
  res.json({
    uptime,
    snapshotRequests: metrics.snapshotRequests,
    proxyRequests:    metrics.proxyRequests,
    errors:           metrics.errors,
    hosts,
  });
});

// Media proxy
app.get("/proxy", async (req, res) => {
  metrics.proxyRequests++;
  const src = req.query.src;
  if (!src) return res.status(400).send("Missing ?src=");

  try {
    const u = new URL(src);
    if (!ALLOWED_DOMAINS.some(d => u.hostname.includes(d)))
      return res.status(403).send("Domain not allowed");
  } catch {
    return res.status(400).send("Invalid URL");
  }

  const headers = proxyHeadersFor(src);
  if (req.headers.range) headers["Range"] = req.headers.range;

  if (req.query.dl === "1") {
    const fname = src.split("/").pop() || "video.mp4";
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  }

  try {
    const upstream = await fetch(src, { headers });
    if (!upstream.ok || !upstream.body)
      return res.status(upstream.status || 502).send("Upstream error");

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600");
    for (const h of ["content-length", "accept-ranges", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(upstream.status);
    pipeline(Readable.fromWeb(upstream.body), res, err => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE")
        logE(`Proxy pipeline: ${err.message}`);
    });
  } catch (e) {
    metrics.errors++;
    logE(`Proxy error: ${e.message}`);
    if (!res.headersSent) res.status(500).send("Internal Proxy Error");
  }
});

app.use(express.static(path.join(__dirname, "public")));

// ─── Start ────────────────────────────────────────────────────────────────────
export function startServer(port = PORT) {
  return new Promise(resolve => {
    const srv = app.listen(port, () => {
      logI(`Server → http://localhost:${port}`);
      logI(`Sites: ${Object.keys(SITES).join(", ")}`);
      resolve({ server: srv, port });
    });
  });
}

// Autostart only when run directly via `node server.js`,
// not when imported (e.g. by electron/main.cjs).
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) startServer();

export { app, SITES, PORT };
