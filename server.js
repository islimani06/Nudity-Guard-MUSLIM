// Nudity Guard — Stremio addon (no dependencies, Node 18+)
// Shows the IMDb Parents Guide "Sex & Nudity" severity as the FIRST stream entry
// for any movie/series, so you see a warning before choosing a source.
//
// Run:  node server.js        (default port 7000)
// Install in Stremio: http://127.0.0.1:7000/manifest.json

const http = require('http');

const PORT = Number(process.env.PORT || 7000);
const IMDB_BASE = process.env.IMDB_BASE || 'https://www.imdb.com';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const cache = new Map(); // imdbId -> { at, data }

const manifest = {
  id: 'community.nudity.guard',
  version: '1.0.0',
  name: 'Nudity Guard',
  description:
    'تحذير قبل المشاهدة: يعرض مستوى "الجنس والعري" (من IMDb Parents Guide) كأول عنصر في قائمة المصادر لأي فيلم أو مسلسل.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false },
};

const LEVELS = {
  none: { icon: '🟢', ar: 'لا يوجد', rank: 0 },
  mild: { icon: '🟡', ar: 'خفيف', rank: 1 },
  moderate: { icon: '🟠', ar: 'متوسط', rank: 2 },
  severe: { icon: '🔴', ar: 'شديد', rank: 3 },
  unknown: { icon: '⚪', ar: 'غير معروف (لا توجد بيانات)', rank: -1 },
};

// ---------- IMDb parsing ----------
function findNudityCategory(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findNudityCategory(x); if (r) return r; }
    return null;
  }
  const cat = node.category;
  if (cat && typeof cat === 'object' && String(cat.id).toUpperCase() === 'NUDITY') return node;
  for (const k of Object.keys(node)) {
    const r = findNudityCategory(node[k]);
    if (r) return r;
  }
  return null;
}

function normalizeLevel(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('none')) return 'none';
  if (t.includes('mild')) return 'mild';
  if (t.includes('moderate')) return 'moderate';
  if (t.includes('severe')) return 'severe';
  return 'unknown';
}

function parseParentsGuide(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const cat = findNudityCategory(JSON.parse(m[1]));
      if (cat) {
        const level = normalizeLevel(cat.severity && (cat.severity.text || cat.severity.id));
        const votes = Array.isArray(cat.severityBreakdown) ? cat.severityBreakdown : [];
        const total = votes.reduce((s, v) => s + (v.voteCount || 0), 0);
        const items = (cat.guideItems && cat.guideItems.edges) || [];
        const sample = items.map(e => e.node && e.node.text && e.node.text.plaidHtml)
          .filter(Boolean)[0];
        return {
          level,
          votes: total,
          sample: sample ? sample.replace(/<[^>]+>/g, '').slice(0, 220) : null,
        };
      }
    } catch (_) { /* fall through to HTML heuristic */ }
  }
  // Fallback: look for the severity word near "Sex & Nudity"
  const idx = html.search(/Sex\s*&(amp;)?\s*Nudity/i);
  if (idx >= 0) {
    const chunk = html.slice(idx, idx + 1500);
    const w = chunk.match(/\b(None|Mild|Moderate|Severe)\b/);
    if (w) return { level: normalizeLevel(w[1]), votes: 0, sample: null };
  }
  return { level: 'unknown', votes: 0, sample: null };
}

async function getGuide(imdbId) {
  const hit = cache.get(imdbId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const res = await fetch(`${IMDB_BASE}/title/${imdbId}/parentalguide`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`IMDb responded ${res.status}`);
  const data = parseParentsGuide(await res.text());
  if (data.level !== 'unknown') cache.set(imdbId, { at: Date.now(), data });
  return data;
}

// ---------- Stremio protocol ----------
function buildStream(imdbId, g) {
  const L = LEVELS[g.level] || LEVELS.unknown;
  const warn = L.rank >= 2 ? '⚠️ ' : '';
  const lines = [`${warn}الجنس والعري: ${L.icon} ${L.ar}`];
  if (g.votes) lines.push(`(${g.votes} تصويت على IMDb)`);
  if (g.sample) lines.push(g.sample);
  return {
    name: 'Nudity Guard',
    title: lines.join('\n'),
    description: lines.join('\n'),
    externalUrl: `https://www.imdb.com/title/${imdbId}/parentalguide`,
  };
}

async function handleStream(type, rawId) {
  const imdbId = decodeURIComponent(rawId).replace(/\.json$/, '').split(':')[0];
  if (!/^tt\d+$/.test(imdbId)) return { streams: [] };
  try {
    return { streams: [buildStream(imdbId, await getGuide(imdbId))], cacheMaxAge: 3600 };
  } catch (e) {
    return {
      streams: [{
        name: 'Nudity Guard',
        title: '⚪ تعذر جلب التحذير الآن — اضغط للتحقق يدوياً',
        externalUrl: `https://www.imdb.com/title/${imdbId}/parentalguide`,
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

  const dbg = path.match(/^\/debug\/(tt\d+)$/);
  if (dbg) {
    try {
      const r = await fetch(`${IMDB_BASE}/title/${dbg[1]}/parentalguide`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.text();
      const i = body.search(/NUDITY|Sex\s*&(amp;)?\s*Nudity/i);
      return send(200, {
        status: r.status,
        length: body.length,
        hasNextData: body.includes('__NEXT_DATA__'),
        title: (body.match(/<title>([^<]*)<\/title>/) || [])[1] || null,
        start: body.slice(0, 300),
        aroundNudity: i >= 0 ? body.slice(Math.max(0, i - 200), i + 600) : null,
        parsed: parseParentsGuide(body),
      });
    } catch (e) {
      return send(200, { error: String(e) });
    }
  }
  if (path === '/manifest.json') return send(200, manifest);
  let m = path.match(/^\/stream\/([^/]+)\/(.+)$/);
  if (m) return send(200, await handleStream(m[1], m[2]));
  if (path === '/') {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    return send(200,
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem" dir="rtl">
<h1>Nudity Guard</h1><p>${manifest.description}</p>
<p><a href="stremio://${host}/manifest.json">تثبيت في Stremio</a></p>
<p dir="ltr"><code>http://${host}/manifest.json</code></p></body>`, 'text/html; charset=utf-8');
  }
  send(404, { error: 'not found' });
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Nudity Guard: http://127.0.0.1:${PORT}/manifest.json`));
}
// Export the request handler itself as the default export: Vercel (and similar hosts)
// require the default export to be a function.
module.exports = handler;
module.exports.handler = handler;
module.exports.parseParentsGuide = parseParentsGuide;
module.exports.buildStream = buildStream;
module.exports.server = server;
