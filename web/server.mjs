// Dashcall web: password login + static SPA + authenticated proxy to the agent on the Mac (e.g. over Tailscale).
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base32Decode, totpStep } from './totp.mjs';

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
// A login lasts this many days after the device's last visit (sliding): active devices get a fresh cookie once a day.
const SESSION_DAYS = Number(process.env.DASHCALL_SESSION_DAYS || 30);
// Part of every signed session token: change it (0 -> 1 -> 2 ...) to sign out every device ("sign out everywhere").
const SESSION_EPOCH = process.env.DASHCALL_SESSION_EPOCH || '0';
// Optional second factor: the base32 secret of an authenticator app (RFC 6238). `node scripts/totp-secret.mjs` makes one.
const TOTP_SECRET = process.env.DASHCALL_TOTP_SECRET;
const missing = ['DASHCALL_PASSWORD', 'DASHCALL_SECRET', 'DASHCALL_AGENT_URL', 'DASHCALL_AGENT_TOKEN'].filter(k => !process.env[k]);
if (missing.length) { console.error('missing env:', missing.join(', '), '(see web/.env.example)'); process.exit(1); }
// Browsers cap cookie lifetimes at 400 days.
if (!(SESSION_DAYS > 0 && SESSION_DAYS <= 400)) { console.error('DASHCALL_SESSION_DAYS must be a number of days, more than 0 and at most 400'); process.exit(1); }
const TOTP_KEY = TOTP_SECRET ? base32Decode(TOTP_SECRET) : null;
// Refuse to start rather than silently run without the second factor the owner asked for.
if (TOTP_SECRET && !(TOTP_KEY?.length >= 10)) { console.error('DASHCALL_TOTP_SECRET must be a base32 secret of at least 16 characters (node scripts/totp-secret.mjs makes one)'); process.exit(1); }
if (PASSWORD.length < 12) console.warn('warning: DASHCALL_PASSWORD is short; anyone who guesses it can run commands on your Mac');
if (SECRET.length < 32) console.warn('warning: DASHCALL_SECRET should be at least 32 random characters');

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'dashcall';
const MAX_AGE = Math.round(SESSION_DAYS * 86400); // seconds
const REFRESH_AFTER = Math.min(86400, MAX_AGE / 2);
const log = (...a) => console.log(new Date().toISOString(), ...a);

const sign = v => createHmac('sha256', SECRET).update(v).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// Session token: `<issued>.<expires>.<signature>` (Unix seconds). The signature also covers the password, the TOTP
// secret and DASHCALL_SESSION_EPOCH, so changing any of them signs out every device. Tokens from before sliding
// sessions (`<expires>.<signature>`, valid for a year) are no longer accepted: those devices log in once more.
const CREDS = sign(`pw:${PASSWORD}\0totp:${TOTP_KEY?.toString('hex') || ''}\0epoch:${SESSION_EPOCH}`);
const tokenSig = (iat, exp) => sign(`${iat}.${exp}.${CREDS}`);
function makeToken() { const iat = Math.floor(Date.now() / 1000), exp = iat + MAX_AGE; return `${iat}.${exp}.${tokenSig(iat, exp)}`; }
// The token's issue time in seconds, or null if it is forged, expired or older than DASHCALL_SESSION_DAYS allows now
// (so lowering the setting also shortens existing logins).
function tokenIssued(t) {
  const m = /^(\d{1,12})\.(\d{1,12})\.([\w-]{43})$/.exec(String(t || ''));
  if (!m || !eq(m[3], tokenSig(m[1], m[2]))) return null;
  const iat = Number(m[1]), now = Date.now() / 1000;
  return Number(m[2]) > now && iat + MAX_AGE > now ? iat : null;
}
const sessionCookie = (token, maxAge = MAX_AGE) => `${COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly;${COOKIE_SECURE ? ' Secure;' : ''} SameSite=Lax`;
const safeDecode = v => { try { return decodeURIComponent(v); } catch { return ''; } };
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, safeDecode(v.join('='))]));
}
function clientIp(req) {
  const xff = TRUST_PROXY && req.headers['x-forwarded-for'];
  // the rightmost entry is the one our own proxy added; everything left of it is client-supplied
  return (xff ? xff.split(',').pop() : req.socket.remoteAddress || '').trim();
}

// Login rate limits: at most 10 failed attempts per client IP and 30 across all IPs in 15 minutes. The global cap
// stops guesses spread over many IPs (a botnet); the price is that during such an attack nobody can log in until
// the window passes, while devices that are already logged in keep working. Successful logins don't count.
const WINDOW = 15 * 60e3, MAX_PER_IP = 10, MAX_TOTAL = 30;
const attempts = new Map(), allAttempts = []; // timestamps of failed and still running attempts
// Prunes in place rather than replacing the array, so a running attempt still finds its stamp to un-count it.
function prune(a) { const now = Date.now(); a.splice(0, a.length, ...a.filter(t => now - t < WINDOW)); return a; }
// Counts an attempt before the request body is awaited, so parallel requests can't all pass the check. Returns null
// when a limit is reached, otherwise a function that un-counts the attempt (for a successful login).
function countAttempt(ip) {
  const mine = prune(attempts.get(ip) || []);
  if (mine.length >= MAX_PER_IP || prune(allAttempts).length >= MAX_TOTAL) return null;
  const stamp = Date.now();
  mine.push(stamp); allAttempts.push(stamp); attempts.set(ip, mine);
  return () => { for (const a of [mine, allAttempts]) { const i = a.indexOf(stamp); if (i >= 0) a.splice(i, 1); } };
}
setInterval(() => { for (const [ip, a] of attempts) if (!prune(a).length) attempts.delete(ip); }, 60e3).unref();
// The newest time step whose one-time code was used: RFC 6238 says a code must not be accepted twice.
let lastTotpStep = -1;

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
  const issued = tokenIssued(cookies(req)[COOKIE]), authed = issued !== null;

  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  // Sliding session: renew a cookie older than a day on whatever response this request gets (API, page or error),
  // so a phone or car that is used now and then stays logged in. writeHead() merges this header in.
  if (authed && Date.now() / 1000 - issued > REFRESH_AFTER) res.setHeader('set-cookie', sessionCookie(makeToken()));

  if (url.pathname === '/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return fail(res, 403, 'cross_origin', 'cross-origin request refused');
    const release = countAttempt(ip);
    if (!release) return fail(res, 429, 'rate_limited', 'too many attempts, try again in 15 minutes');
    let pw = '', code = '';
    try { ({ password: pw = '', code = '' } = JSON.parse(await readBody(req, 10000))); } catch {}
    const pwOk = eq(sign('pw:' + pw), sign('pw:' + PASSWORD));
    if (TOTP_KEY) {
      // One answer for a wrong password and a wrong code, so the password can't be guessed without the code. A reused
      // code is reported whatever the password was, so that answer gives nothing away either.
      // Apps and password managers show codes as "123 456" or "123-456": only the digits matter.
      const step = totpStep(TOTP_KEY, String(code).replace(/\D/g, ''));
      if (step >= 0 && step <= lastTotpStep) {
        log('login failed (one-time code reused)', ip);
        return fail(res, 401, 'code_used', 'this code was already used, wait for the next one');
      }
      if (!pwOk || step < 0) {
        log(pwOk ? 'login failed (right password, wrong code)' : 'login failed', ip);
        return fail(res, 401, 'bad_login', 'wrong password or code');
      }
      lastTotpStep = step;
    } else if (!pwOk) {
      log('login failed', ip);
      return fail(res, 401, 'bad_password', 'wrong password');
    }
    release();
    log('login ok', ip);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(makeToken()) });
    return res.end('{"ok":true}');
  }
  // Public, so the login page knows whether to ask for a one-time code.
  if (url.pathname === '/login/config' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ totp: !!TOTP_KEY }));
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return fail(res, 403, 'cross_origin', 'cross-origin request refused');
    res.writeHead(204, { 'set-cookie': sessionCookie('', 0) }); return res.end();
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
