// Dashcall web: password login + static SPA + authenticated proxy to the agent on the Mac (e.g. over Tailscale).
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
// Loopback by default; the Docker image sets HOST=0.0.0.0 (compose still publishes it on 127.0.0.1 only).
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.DASHCALL_PASSWORD;
const SECRET = process.env.DASHCALL_SECRET;
const AGENT_URL = process.env.DASHCALL_AGENT_URL?.replace(/\/+$/, ''); // e.g. http://100.x.y.z:7420 (the Mac's Tailscale address)
const AGENT_TOKEN = process.env.DASHCALL_AGENT_TOKEN;
// Behind a reverse proxy that appends X-Forwarded-For (Caddy, nginx), set DASHCALL_TRUST_PROXY=1 so the login
// rate limit sees the real client IP. Without a proxy leave it unset: the header would be client-controlled.
const TRUST_PROXY = process.env.DASHCALL_TRUST_PROXY === '1';
// Session cookies are Secure (HTTPS only) unless DASHCALL_COOKIE_SECURE=0, e.g. for local development over http.
const COOKIE_SECURE = process.env.DASHCALL_COOKIE_SECURE !== '0';
const missing = ['DASHCALL_PASSWORD', 'DASHCALL_SECRET', 'DASHCALL_AGENT_URL', 'DASHCALL_AGENT_TOKEN'].filter(k => !process.env[k]);
if (missing.length) { console.error('missing env:', missing.join(', '), '(see web/.env.example)'); process.exit(1); }
if (PASSWORD.length < 12) console.warn('warning: DASHCALL_PASSWORD is short; anyone who guesses it can run commands on your Mac');
if (SECRET.length < 32) console.warn('warning: DASHCALL_SECRET should be at least 32 random characters');

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'dashcall';
const YEAR = 365 * 24 * 3600;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const sign = v => createHmac('sha256', SECRET).update(v).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// The password is part of the signed payload, so changing it signs out every existing session.
const tokenSig = exp => sign(`${exp}.${sign('pw:' + PASSWORD)}`);
function makeToken() { const exp = String(Math.floor(Date.now() / 1000) + YEAR); return `${exp}.${tokenSig(exp)}`; }
function validToken(t) {
  const [exp, sig] = String(t || '').split('.');
  return !!exp && !!sig && eq(sig, tokenSig(exp)) && Number(exp) > Date.now() / 1000;
}
const safeDecode = v => { try { return decodeURIComponent(v); } catch { return ''; } };
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, safeDecode(v.join('='))]));
}
function clientIp(req) {
  const xff = TRUST_PROXY && req.headers['x-forwarded-for'];
  // the rightmost entry is the one our own proxy added; everything left of it is client-supplied
  return (xff ? xff.split(',').pop() : req.socket.remoteAddress || '').trim();
}

// login rate limit: 10 attempts / 15 min per IP
const WINDOW = 15 * 60e3;
const attempts = new Map();
function limited(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < WINDOW);
  attempts.set(ip, a);
  return a.length >= 10;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (!a.some(t => now - t < WINDOW)) attempts.delete(ip);
}, 60e3).unref();

// State-changing API calls must come from our own page (defence in depth on top of SameSite cookies).
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const PUBLIC_FILES = new Set(['/login.js', '/i18n.js', '/style.css', '/icon.svg']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SEC = {
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'permissions-policy': 'microphone=(self)',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// Every error response is JSON {error: <English message>, code: <snake_case>}.
function fail(res, status, code, error, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ error, code }));
}

async function serveStatic(res, name) {
  const file = path.join(PUB, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(404); return res.end(); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SEC });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('request body too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function proxy(req, res, url) {
  const t0 = Date.now();
  const MAX = 25 * 1024 * 1024;
  if (Number(req.headers['content-length']) > MAX) return fail(res, 413, 'too_large', 'request body too large', { connection: 'close' });
  let body;
  try {
    body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req, MAX);
  } catch (e) {
    if (e.status !== 413) return res.destroy(); // client went away mid-upload
    return fail(res, 413, 'too_large', 'request body too large');
  }
  try {
    const r = await fetch(AGENT_URL + url.pathname + url.search, {
      method: req.method, body,
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'content-type': req.headers['content-type'] || 'application/json' },
      signal: AbortSignal.timeout(120000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!/^\/api\/(health|ask\/)/.test(url.pathname)) log(req.method, url.pathname, r.status, `${Date.now() - t0}ms`, `in=${body?.length || 0}`, `out=${buf.length}`);
    // the agent rejecting our token is a server misconfiguration, not a logged-out user
    if (r.status === 401) { log('agent rejected DASHCALL_AGENT_TOKEN'); return fail(res, 502, 'agent_auth', 'the agent rejected DASHCALL_AGENT_TOKEN'); }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
    res.end(buf);
  } catch (e) {
    log('proxy error', req.method, url.pathname, `${Date.now() - t0}ms`, `in=${body?.length || 0}`, e.message);
    fail(res, 502, 'agent_unreachable', 'cannot reach the agent on your Mac');
  }
}

const server = http.createServer((req, res) => handle(req, res).catch(e => {
  log('error', req.method, req.url, e.message);
  if (!res.headersSent) fail(res, 500, 'internal', 'internal error'); else res.destroy();
}));
server.on('error', e => { console.error(`cannot listen on ${HOST}:${PORT}: ${e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => log(`dashcall web on ${HOST}:${server.address().port}`));

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  const authed = validToken(cookies(req)[COOKIE]);

  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

  if (url.pathname === '/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return fail(res, 403, 'cross_origin', 'cross-origin request refused');
    if (limited(ip)) return fail(res, 429, 'rate_limited', 'too many attempts, try again in 15 minutes');
    // count the attempt before awaiting the body, so parallel requests can't all pass the limit check
    const stamp = Date.now(), tries = attempts.get(ip) || [];
    tries.push(stamp); attempts.set(ip, tries);
    let pw = '';
    try { pw = JSON.parse(await readBody(req, 10000)).password || ''; } catch {}
    if (!eq(sign('pw:' + pw), sign('pw:' + PASSWORD))) {
      log('login failed', ip);
      return fail(res, 401, 'bad_password', 'wrong password');
    }
    tries.splice(tries.indexOf(stamp), 1);
    log('login ok', ip);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${COOKIE}=${makeToken()}; Max-Age=${YEAR}; Path=/; HttpOnly;${COOKIE_SECURE ? ' Secure;' : ''} SameSite=Lax` });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return fail(res, 403, 'cross_origin', 'cross-origin request refused');
    res.writeHead(204, { 'set-cookie': `${COOKIE}=; Max-Age=0; Path=/; HttpOnly;${COOKIE_SECURE ? ' Secure;' : ''} SameSite=Lax` }); return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    if (!authed) return fail(res, 401, 'login_required', 'login required');
    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return fail(res, 403, 'cross_origin', 'cross-origin request refused');
    return proxy(req, res, url);
  }

  // Signed out, only the login page and what it needs are served.
  if (!authed) return serveStatic(res, PUBLIC_FILES.has(url.pathname) ? url.pathname.slice(1) : 'login.html');
  return serveStatic(res, url.pathname === '/' ? 'index.html' : url.pathname);
}
