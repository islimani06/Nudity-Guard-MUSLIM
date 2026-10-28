// Nudity Guard — Stremio addon (no dependencies, Node 18+)
// Source: Common Sense Media "Sex, Romance & Nudity" rating (0-5 + short description).
// Title lookup: Stremio's Cinemeta (IMDb id -> name/year).
// Shows the warning as the first entry in the stream list for any movie/series.

const http = require('http');

const PORT = Number(process.env.PORT || 7000);
const CSM_BASE = process.env.CSM_BASE || 'https://www.commonsensemedia.org';
const CINEMETA_BASE = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const cache = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

const manifest = {
  id: 'community.nudity.guard',
  version: '2.0.0',
  name: 'Nudity Guard',
  description: 'تحذير قبل المشاهدة: مستوى "الجنس والعري" (من Common Sense Media) كأول عنصر في قائمة المصادر.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false },
};

// ---------- helpers ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
}
function stripTags(s) { return decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

function slugify(name) {
  return String(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function levelFor(score) {
  if (score <= 0) return { icon: '🟢', ar: 'لا يوجد', warn: false };
  if (score <= 2) return { icon: '🟡', ar: 'خفيف', warn: false };
  if (score === 3) return { icon: '🟠', ar: 'متوسط', warn: true };
  return { icon: '🔴', ar: 'شديد', warn: true };
}

// Parse Common Sense Media page: score = number of active circles in the sex/nudity block.
function parseCsm(html) {
  const i = html.indexOf('id="content-grid-item-sex"');
  if (i < 0) return null;
  const chunk = html.slice(i, i + 4000);
  const sc = chunk.match(/rating__score[\s\S]*?<\/span>/);
  if (!sc) return null;
  const score = (sc[0].match(/icon-circle-solid active/g) || []).length;
  const tz = chunk.match(/rating__teaser">\s*<p>([\s\S]*?)<\/p>/);
  let text = tz ? stripTags(tz[1]) : null;
  if (!text) {
    const before = html.slice(Math.max(0, i - 800), i).match(/data-text="([^"]*)"/g);
    if (before) text = stripTags(before[before.length - 1].replace(/^data-text="|"$/g, ''));
  }
  return { score, text };
}

async function fetchText(url, ms) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(ms) });
  if (!r.ok) return null;
  return r.text();
}

async function lookup(type, imdbId) {
  const key = type + ':' + imdbId;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const metaRes = await fetchText(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`, 4000);
  const meta = metaRes ? JSON.parse(metaRes).meta : null;
  if (!meta || !meta.name) return { found: false, name: null };

  const slug = slugify(meta.name);
  const year = String(meta.year || meta.releaseInfo || '').match(/\d{4}/);
  const kind = type === 'series' ? 'tv-reviews' : 'movie-reviews';
  const candidates = [slug];
  if (year) candidates.push(`${slug}-${year[0]}`);
  if (slug.startsWith('the-')) candidates.push(slug.slice(4));

  const pages = await Promise.all(candidates.map(async (c) => {
    try { return await fetchText(`${CSM_BASE}/${kind}/${c}`, 5000); } catch (_) { return null; }
  }));
  for (let k = 0; k < pages.length; k++) {
    const p = pages[k] && parseCsm(pages[k]);
    if (p) {
      const data = { found: true, name: meta.name, score: p.score, text: p.text, url: `${CSM_BASE}/${kind}/${candidates[k]}` };
      cache.set(key, { at: Date.now(), data });
      return data;
    }
  }
  return { found: false, name: meta.name };
}

// ---------- Stremio protocol ----------
function buildStream(d) {
  if (!d.found) {
    const q = encodeURIComponent(d.name || '');
    const t = '⚪ الجنس والعري: غير متوفر لهذا العمل في Common Sense Media';
    return { name: 'Nudity Guard', title: t, description: t, externalUrl: `${CSM_BASE}/search/${q}` };
  }
  const L = levelFor(d.score);
  const lines = [`${L.warn ? '⚠️ ' : ''}الجنس والعري: ${L.icon} ${L.ar} (${d.score}/5)`];
  if (d.text) lines.push(d.text.slice(0, 220));
  return { name: 'Nudity Guard', title: lines.join('\n'), description: lines.join('\n'), externalUrl: d.url };
}

async function handleStream(type, rawId) {
  const imdbId = decodeURIComponent(rawId).replace(/\.json$/, '').split(':')[0];
  if (!/^tt\d+$/.test(imdbId) || (type !== 'movie' && type !== 'series')) return { streams: [] };
  try {
    const d = await lookup(type, imdbId);
    return { streams: [buildStream(d)], cacheMaxAge: d.found ? 3600 : 600 };
  } catch (e) {
    return {
      streams: [{
        name: 'Nudity Guard',
        title: '⚪ تعذر جلب التحذير الآن',
        externalUrl: `${CSM_BASE}/search/`,
      }],
      cacheMaxAge: 60,
    };
  }
}

async function handler(req, res) {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, '');
  const u = new URL(req.url, 'http://x');
  let path = u.pathname;
  // On Vercel, requests are rewritten to /api/index?path=<original path>
  const qp = u.searchParams.get('path');
  if (qp !== null) path = '/' + qp.replace(/^\/+/, '');

  if (path === '/manifest.json') return send(200, manifest);
  const m = path.match(/^\/stream\/([^/]+)\/(.+)$/);
  if (m) return send(200, await handleStream(m[1], m[2]));
  if (path === '/') {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    return send(200,
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem" dir="rtl">
<h1>Nudity Guard</h1><p>${manifest.description}</p>
<p><a href="stremio://${host}/manifest.json">تثبيت في Stremio</a></p>
<p dir="ltr"><code>https://${host}/manifest.json</code></p></body>`, 'text/html; charset=utf-8');
  }
  send(404, { error: 'not found' });
}

const server = http.createServer(handler);
if (require.main === module) {
  server.listen(PORT, () => console.log(`Nudity Guard: http://127.0.0.1:${PORT}/manifest.json`));
}

// Vercel requires the default export to be a function.
module.exports = handler;
module.exports.handler = handler;
module.exports.parseCsm = parseCsm;
module.exports.slugify = slugify;
module.exports.server = server;
