// Spawns web/server.mjs in front of a stub agent and checks login, auth, proxying and hardening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer } from './helpers.mjs';
import { base32Encode, hotp, STEP } from '../web/totp.mjs';

const TOKEN = 'a'.repeat(40), PASSWORD = 'correct horse battery staple', SECRET = 's'.repeat(40);
let web, agent, base, seen = [];
const env = extra => ({
  PORT: '0', DASHCALL_PASSWORD: PASSWORD, DASHCALL_SECRET: SECRET,
  DASHCALL_AGENT_URL: `http://127.0.0.1:${agent.address().port}`, DASHCALL_AGENT_TOKEN: TOKEN, DASHCALL_TRUST_PROXY: '1', ...extra,
});
// A second web app with other settings, for tests that need a fresh rate limit or another configuration.
async function withWeb(extra, fn) {
  const w = await startServer('web/server.mjs', env(extra));
  try { return await fn(`http://127.0.0.1:${w.port}`); } finally { w.kill(); }
}

before(async () => {
  agent = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise(r => agent.listen(0, '127.0.0.1', r));
  web = await startServer('web/server.mjs', env());
  base = `http://127.0.0.1:${web.port}`;
});
after(() => { web?.kill(); agent?.close(); });

const postLogin = (b, body, ip) => fetch(b + '/login', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
});
const login = (password, ip = '10.0.0.1') => postLogin(base, { password }, ip);
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
const health = (b, cookie) => fetch(b + '/api/health', { headers: { cookie } });
// Mirrors the session token of web/server.mjs, `<issued>.<expires>.<signature>`, to fake old and expired logins.
const hmac = v => createHmac('sha256', SECRET).update(v).digest('base64url');
function tokenCookie(iat, exp, { epoch = '0' } = {}) {
  const creds = hmac(`pw:${PASSWORD}\0totp:\0epoch:${epoch}`);
  return `dashcall=${iat}.${exp}.${hmac(`${iat}.${exp}.${creds}`)}`;
}
const now = () => Math.floor(Date.now() / 1000), DAY = 86400;
async function assertError(r, status, code, what) {
  assert.equal(r.status, status, what);
  const d = await r.json();
  assert.equal(d.code, code, what);
  assert.equal(typeof d.error, 'string');
}

test('unauthenticated users get the login page and a 401 from the API', async () => {
  assert.match(await (await fetch(base + '/')).text(), /type="password"/);
  await assertError(await fetch(base + '/api/health'), 401, 'login_required');
});

test('the login page can load its scripts, styles and translations', async () => {
  for (const f of ['/login.js', '/i18n.js', '/style.css', '/icon.svg']) {
    const r = await fetch(base + f);
    assert.equal(r.status, 200, f);
    assert.doesNotMatch(await r.text(), /type="password"/, f);
  }
  assert.match((await fetch(base + '/i18n.js')).headers.get('content-type'), /javascript/);
  assert.match(await (await fetch(base + '/app.js')).text(), /type="password"/, 'the app itself needs a login');
});

test('the PWA manifest and its icons are public, so "add to home screen" works', async () => {
  const r = await fetch(base + '/manifest.webmanifest'); // browsers fetch it without cookies
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.start_url, '/'); assert.equal(m.display, 'standalone'); assert.equal(m.short_name, 'Dashcall');
  assert.ok(m.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable'), 'a maskable icon for Android');
  for (const icon of [...m.icons, { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]) {
    const res = await fetch(base + icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), icon.type, icon.src);
    const buf = Buffer.from(await res.arrayBuffer());
    if (icon.type === 'image/png') assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, icon.sizes, icon.src); // IHDR width x height
  }
  const cookie = cookieOf(await login(PASSWORD));
  for (const page of [await fetch(base + '/'), await fetch(base + '/', { headers: { cookie } })]) {
    const html = await page.text();
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  }
});

test('the CSP allows no inline scripts or styles, and no page needs them', async () => {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /style-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-/);
  // style="…" (also inside innerHTML templates), inline <script> and on…="…" handlers would all be blocked
  const dir = new URL('../web/public/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => /\.(html|js)$/.test(f))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /\sstyle=/, f);
    assert.doesNotMatch(src, /\son[a-z]+=["']/, f);
    assert.doesNotMatch(src, /<script(?![^>]*\ssrc=)[^>]*>/, f);
  }
});

test('login sets a secure cookie that unlocks the proxied API', async () => {
  await assertError(await login('wrong'), 401, 'bad_password');
  const r = await login(PASSWORD);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const api = await fetch(base + '/api/health', { headers: { cookie: cookieOf(r) } });
  assert.equal(api.status, 200);
  assert.equal(seen.at(-1).auth, `Bearer ${TOKEN}`);
});

test('tampered cookies are rejected', async () => {
  const c = cookieOf(await login(PASSWORD)).replace(/.$/, ch => (ch === 'A' ? 'B' : 'A'));
  assert.equal((await fetch(base + '/api/health', { headers: { cookie: c } })).status, 401);
});

test('a malformed cookie does not crash the server', async () => {
  assert.equal((await fetch(base + '/', { headers: { cookie: 'dashcall=%' } })).status, 200);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('cross-site API writes are refused', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  const r = await fetch(base + '/api/ask', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' }, body: '{}' });
  await assertError(r, 403, 'cross_origin');
  const l = await fetch(base + '/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  await assertError(l, 403, 'cross_origin');
});

test('static files cannot escape public/', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  const r = await fetch(base + '/..%2fserver.mjs', { headers: { cookie } });
  assert.equal(r.status, 404);
});

// The rate-limit tests get their own web app: failures on `base` would eat into its global budget (30 per 15 minutes)
// and make unrelated tests fail with 429 depending on their order.
test('login is rate limited per client IP', async () => {
  await withWeb({}, async b => {
    for (let i = 0; i < 10; i++) await postLogin(b, { password: 'wrong' }, '10.9.9.9');
    await assertError(await postLogin(b, { password: PASSWORD }, '10.9.9.9'), 429, 'rate_limited');
    assert.equal((await postLogin(b, { password: PASSWORD }, '10.9.9.8')).status, 200);
  });
});

test('oversized API requests are refused', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  // announce a huge body without sending it: the server must answer from the header alone
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/stt', { method: 'POST', headers: { cookie, 'content-length': String(26 * 1024 * 1024) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject);
    req.write('x');
  });
  assert.equal(status, 413);
  assert.equal(body.code, 'too_large');
});

test('an unreachable agent is reported as agent_unreachable', async () => {
  const w = await startServer('web/server.mjs', {
    PORT: '0', DASHCALL_PASSWORD: PASSWORD, DASHCALL_SECRET: 's'.repeat(40),
    DASHCALL_AGENT_URL: 'http://127.0.0.1:1', DASHCALL_AGENT_TOKEN: TOKEN,
  });
  try {
    const b = `http://127.0.0.1:${w.port}`;
    const cookie = cookieOf(await fetch(b + '/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) }));
    await assertError(await fetch(b + '/api/health', { headers: { cookie } }), 502, 'agent_unreachable');
  } finally { w.kill(); }
});

test('parallel login attempts cannot get around the rate limit', async () => {
  await withWeb({}, async b => {
    const results = await Promise.all(Array.from({ length: 30 }, () => postLogin(b, { password: 'wrong' }, '10.7.7.7')));
    const statuses = results.map(r => r.status);
    assert.equal(statuses.filter(s => s === 401).length, 10);
    assert.equal(statuses.filter(s => s === 429).length, 20);
  });
});

test('an agent that rejects our token is a 502 agent_auth, not a logout', async () => {
  const bad = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized","code":"unauthorized"}'); });
  await new Promise(r => bad.listen(0, '127.0.0.1', r));
  const w = await startServer('web/server.mjs', {
    PORT: '0', DASHCALL_PASSWORD: PASSWORD, DASHCALL_SECRET: 's'.repeat(40),
    DASHCALL_AGENT_URL: `http://127.0.0.1:${bad.address().port}`, DASHCALL_AGENT_TOKEN: TOKEN,
  });
  try {
    const b = `http://127.0.0.1:${w.port}`;
    const cookie = cookieOf(await fetch(b + '/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) }));
    await assertError(await fetch(b + '/api/health', { headers: { cookie } }), 502, 'agent_auth');
  } finally { w.kill(); bad.close(); }
});

test('logout is a same-origin POST that clears the cookie', async () => {
  assert.equal((await fetch(base + '/logout', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const r = await fetch(base + '/logout', { method: 'POST' });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('set-cookie'), /^dashcall=; Max-Age=0; Path=\/; HttpOnly; Secure; SameSite=Lax/);
});

test('a login lasts 30 days and is renewed at most once a day while the device is used', async () => {
  const r = await login(PASSWORD);
  assert.match(r.headers.get('set-cookie'), /^dashcall=\d+\.\d+\.[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal((await health(base, cookieOf(r))).headers.get('set-cookie'), null, 'a fresh cookie is not renewed');

  const old = tokenCookie(now() - 2 * DAY, now() + 28 * DAY);
  for (const path of ['/api/health', '/']) {
    const res = await fetch(base + path, { headers: { cookie: old } });
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('set-cookie') || '', /^dashcall=\d+\.\d+\.[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/, path);
    const fresh = cookieOf(res);
    assert.ok(Math.abs(Number(fresh.split(/[=.]/)[1]) - now()) < 5, 'the new cookie is issued now');
    assert.equal((await health(base, fresh)).status, 200);
  }
});

test('expired, too old, old-format and revoked session tokens are refused', async () => {
  const refused = {
    expired: tokenCookie(now() - 2 * DAY, now() - 1),
    'older than DASHCALL_SESSION_DAYS': tokenCookie(now() - 31 * DAY, now() + DAY),
    'other epoch': tokenCookie(now(), now() + DAY, { epoch: '1' }),
    // the one-year format from before sliding sessions: `<expires>.<signature>`
    'old format': (exp => `dashcall=${exp}.${hmac(`${exp}.${hmac('pw:' + PASSWORD)}`)}`)(now() + 300 * DAY),
  };
  for (const [what, cookie] of Object.entries(refused)) await assertError(await health(base, cookie), 401, 'login_required', what);
  assert.equal((await health(base, tokenCookie(now() - 29 * DAY, now() + DAY))).status, 200, 'a 29-day-old token is still fine');
});

test('changing DASHCALL_SESSION_EPOCH signs out every device; DASHCALL_SESSION_DAYS shortens existing logins', async () => {
  const before = cookieOf(await login(PASSWORD));
  await withWeb({ DASHCALL_SESSION_EPOCH: '1', DASHCALL_SESSION_DAYS: '7' }, async b => {
    await assertError(await health(b, before), 401, 'login_required');
    const r = await postLogin(b, { password: PASSWORD }, '10.0.0.2');
    assert.match(r.headers.get('set-cookie'), /Max-Age=604800;/);
    assert.equal((await health(b, cookieOf(r))).status, 200);
    await assertError(await health(base, cookieOf(r)), 401, 'login_required');
    await assertError(await health(b, tokenCookie(now() - 8 * DAY, now() + 22 * DAY, { epoch: '1' })), 401, 'login_required');
  });
});

test('invalid session or TOTP settings stop the web app', async () => {
  const bad = { DASHCALL_SESSION_DAYS: ['0', '-1', 'forever', '500'], DASHCALL_TOTP_SECRET: ['not base32!', 'ABCDEFGH'] };
  for (const [key, values] of Object.entries(bad)) {
    for (const v of values) await assert.rejects(startServer('web/server.mjs', env({ [key]: v })), new RegExp(`exited \\(1\\).*${key}`, 's'), `${key}=${v}`);
  }
});

test('failed logins are also limited across all IPs, so many IPs cannot share the guessing', async () => {
  await withWeb({}, async b => {
    for (let i = 0; i < 31; i++) assert.equal((await postLogin(b, { password: PASSWORD }, '10.5.0.1')).status, 200, 'successful logins do not count');
    const cookie = cookieOf(await postLogin(b, { password: PASSWORD }, '10.5.0.1'));
    const statuses = (await Promise.all(Array.from({ length: 40 }, (_, i) => postLogin(b, { password: 'wrong' }, `10.6.0.${i}`)))).map(r => r.status);
    assert.equal(statuses.filter(s => s === 401).length, 30);
    assert.equal(statuses.filter(s => s === 429).length, 10);
    await assertError(await postLogin(b, { password: PASSWORD }, '10.6.1.1'), 429, 'rate_limited');
    assert.equal((await health(b, cookie)).status, 200, 'devices that are logged in keep working');
  });
});

test('with DASHCALL_TOTP_SECRET, login needs a one-time code that works only once', async () => {
  const key = Buffer.from('a 20-byte test key!!'), ip = '10.8.0.1';
  assert.deepEqual(await (await fetch(base + '/login/config')).json(), { totp: false });
  await withWeb({ DASHCALL_TOTP_SECRET: base32Encode(key).toLowerCase() }, async b => {
    assert.deepEqual(await (await fetch(b + '/login/config')).json(), { totp: true });
    const t0 = Math.floor(Date.now() / 1000 / STEP), code = hotp(key, t0);
    // a code that is valid at none of the steps this test can run in
    const valid = [-1, 0, 1, 2].map(d => hotp(key, t0 + d));
    let n = 0; while (valid.includes(String(n).padStart(6, '0'))) n++;
    const wrong = String(n).padStart(6, '0');
    const as = body => postLogin(b, body, ip);

    // the same answer whichever part is wrong, and a wrong password doesn't use up the code
    await assertError(await as({ password: 'wrong', code }), 401, 'bad_login');
    await assertError(await as({ password: PASSWORD }), 401, 'bad_login');
    await assertError(await as({ password: PASSWORD, code: wrong }), 401, 'bad_login');
    const ok = await as({ password: PASSWORD, code });
    assert.equal(ok.status, 200);
    assert.equal((await health(b, cookieOf(ok))).status, 200);

    await assertError(await as({ password: PASSWORD, code }), 401, 'code_used');
    const next = hotp(key, t0 + 1);
    assert.equal((await as({ password: PASSWORD, code: `${next.slice(0, 3)}-${next.slice(3)}` })).status, 200, 'the next code, typed as 123-456');
    await assertError(await as({ password: 'wrong', code: `${code.slice(0, 3)} ${code.slice(3)}` }), 401, 'code_used', 'typed as 123 456');

    await assertError(await health(b, cookieOf(await login(PASSWORD))), 401, 'login_required', 'turning on 2FA signs out older logins');
    // one-time-code failures count toward the rate limit: 5 so far from this IP, 10 allowed
    for (let i = 0; i < 5; i++) await assertError(await as({ password: PASSWORD, code: wrong }), 401, 'bad_login');
    await assertError(await as({ password: PASSWORD, code: hotp(key, t0 + 2) }), 429, 'rate_limited');
  });
});

test('the login page has a hidden one-time-code field for two-factor login', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<input id="code"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"[^>]*hidden>/);
});
