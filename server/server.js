// 별자리 메모보드 서버: 2D 보드 파일을 보여주고, 무료 외부 서비스(microlink, allorigins)가 하던 일을 대신한다.
//   GET /api/meta?url=...   북마크 제목/설명/대표 이미지 (한 번 읽은 건 캐시)
//   GET /api/fetch?url=...  드라이브 보드 파일 중계 (브라우저에서 바로 못 받을 때만 씀)
//   GET /downloads/...      퀘스트 앱 APK와 최신 버전 정보(latest.json). git/이미지 밖의 폴더(DOWNLOADS_DIR)에서
// 외부 패키지 없이 Node 22 기본 기능만 쓴다.
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.resolve(process.env.STATIC_ROOT || path.join(import.meta.dirname, '..'));
const CACHE_FILE = process.env.META_CACHE || path.join(import.meta.dirname, 'data', 'meta-cache.json');
const UA = 'Mozilla/5.0 (compatible; ConstelgridBot/1.0; +https://grid.howeverina.studio)';
const MAX_HTML = 2 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const META_TTL = 7 * 24 * 3600 * 1000;
const DOWNLOADS = path.resolve(process.env.DOWNLOADS_DIR || path.join(import.meta.dirname, '..', 'downloads'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};
// 서버 폴더나 git 파일은 밖에 보이지 않게
const HIDDEN = /^\/(server|\.git|\.github|node_modules)(\/|$)|\/\./;

// --- 북마크 정보 캐시 (파일에 저장해서 재시작해도 유지) ---
let metaCache = {};
try { metaCache = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(metaCache));
    } catch (e) { console.error('cache save failed', e.message); }
  }, 2000);
}

// --- 내부망 주소로는 요청하지 않음 (서버를 통해 집 안 기기에 접근하는 걸 막음) ---
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'bad url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'bad url');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(502, 'unknown host');
  if (addrs.some(a => isPrivate(a.address))) throw new HttpError(403, 'private address');
  return u;
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// 리다이렉트도 한 단계씩 내부망 검사를 하며 따라감
async function safeFetch(raw, accept) {
  let url = raw;
  for (let i = 0; i < 5; i++) {
    const u = await checkUrl(url);
    const res = await fetch(u, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'ko,en;q=0.8' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), u).href;
      continue;
    }
    return { res, finalUrl: u.href };
  }
  throw new HttpError(502, 'too many redirects');
}

async function readLimited(res, max) {
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > max) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// --- /api/meta ---
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
    if (k === 'quot') return '"'; if (k === 'apos' || k === '#39') return "'";
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  }).trim();
}

function parseMeta(html, pageUrl) {
  const head = html.slice(0, 500000);
  const tags = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = n => (m[0].match(new RegExp(`\\b${n}\\s*=\\s*(["'])(.*?)\\1`, 'is')) || [])[2];
    const key = (attr('property') || attr('name') || '').toLowerCase();
    const content = attr('content');
    if (key && content != null && !(key in tags)) tags[key] = decodeEntities(content);
  }
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const abs = v => { try { return v ? new URL(v, pageUrl).href : null; } catch { return null; } };
  const host = new URL(pageUrl).hostname;
  return {
    title: tags['og:title'] || tags['twitter:title'] || (titleTag && decodeEntities(titleTag)) || pageUrl,
    desc: tags['og:description'] || tags['twitter:description'] || tags['description'] || '',
    image: abs(tags['og:image'] || tags['og:image:url'] || tags['twitter:image']),
    publisher: tags['og:site_name'] || host,
  };
}

async function handleMeta(url) {
  const hit = metaCache[url];
  if (hit && Date.now() - hit.at < META_TTL) return hit.meta;
  const { res, finalUrl } = await safeFetch(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
  if (!res.ok) throw new HttpError(502, `upstream ${res.status}`);
  const type = res.headers.get('content-type') || '';
  let meta;
  if (type.startsWith('image/')) {
    meta = { title: url, desc: '', image: finalUrl, publisher: new URL(finalUrl).hostname };
    res.body?.cancel();
  } else {
    const buf = await readLimited(res, MAX_HTML);
    const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(buf); } catch { html = buf.toString('utf8'); }
    meta = parseMeta(html, finalUrl);
  }
  metaCache[url] = { at: Date.now(), meta };
  saveCacheSoon();
  return meta;
}

// --- /api/fetch: 보드 JSON만 중계 ---
async function handleFetch(url, out) {
  const { res } = await safeFetch(url, 'application/json,*/*;q=0.5');
  if (!res.ok) throw new HttpError(502, `upstream ${res.status}`);
  const buf = await readLimited(res, MAX_FILE + 1);
  if (buf.length > MAX_FILE) throw new HttpError(413, 'too large');
  try { JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(415, 'not json'); }
  out.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  out.end(buf);
}

// --- 내려받기: 큰 파일이라 메모리에 올리지 않고 흘려보냄, 끊기면 이어받기(Range) ---
async function serveDownload(req, pathname, out) {
  const name = decodeURIComponent(pathname.slice('/downloads/'.length));
  if (!name || name.includes('/') || name.startsWith('.')) throw new HttpError(404, 'not found');
  const file = path.join(DOWNLOADS, name);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new HttpError(404, 'not found');
  const ext = path.extname(name).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // 버전 정보는 항상 새로, APK는 파일 이름에 버전이 있어서 오래 캐시해도 됨
    'Cache-Control': ext === '.json' ? 'no-cache' : 'public, max-age=86400',
  };
  if (ext === '.apk') headers['Content-Disposition'] = `attachment; filename="${name}"`;
  let start = 0, end = stat.size - 1, status = 200;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else start = Math.max(0, stat.size - Number(range[2]));
    if (start > end) {
      out.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return out.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  out.writeHead(status, headers);
  if (req.method === 'HEAD') return out.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => out.destroy());
  out.on('close', () => stream.destroy());
  stream.pipe(out);
}

// --- 정적 파일 ---
async function serveStatic(pathname, out) {
  let p = decodeURIComponent(pathname);
  if (HIDDEN.test(p)) throw new HttpError(404, 'not found');
  let file = path.join(ROOT, p);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) throw new HttpError(404, 'not found');
  let stat = await fs.stat(file).catch(() => null);
  if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = await fs.stat(file).catch(() => null); }
  if (!stat && !path.extname(file)) { file += '.html'; stat = await fs.stat(file).catch(() => null); }
  if (!stat?.isFile()) throw new HttpError(404, 'not found');
  out.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
  out.end(await fs.readFile(file));
}

function sendJson(out, status, body) {
  out.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  out.end(JSON.stringify(body));
}

http.createServer(async (req, out) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (u.pathname === '/api/health') return sendJson(out, 200, { ok: true });
    if (u.pathname === '/api/meta') {
      const url = u.searchParams.get('url');
      if (!url) throw new HttpError(400, 'url required');
      return sendJson(out, 200, await handleMeta(url));
    }
    if (u.pathname === '/api/fetch') {
      const url = u.searchParams.get('url');
      if (!url) throw new HttpError(400, 'url required');
      return await handleFetch(url, out);
    }
    if (u.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (u.pathname.startsWith('/downloads/')) return await serveDownload(req, u.pathname, out);
    await serveStatic(u.pathname, out);
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 502);
    if (!e.status) console.error(req.url, e.message);
    if (u.pathname.startsWith('/api/')) sendJson(out, status, { error: e.message });
    else { out.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); out.end(status === 404 ? '404' : 'error'); }
  }
}).listen(PORT, () => console.log(`constelgrid server on :${PORT}, serving ${ROOT}`));
