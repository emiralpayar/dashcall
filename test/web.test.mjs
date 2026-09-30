// Spawns web/server.mjs in front of a stub agent and checks login, auth, proxying and hardening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers.mjs';

const TOKEN = 'a'.repeat(40), PASSWORD = 'correct horse battery staple';
let web, agent, base, seen = [];

before(async () => {
  agent = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise(r => agent.listen(0, '127.0.0.1', r));
  web = await startServer('web/server.mjs', {
    PORT: '0', DASHCALL_PASSWORD: PASSWORD, DASHCALL_SECRET: 's'.repeat(40),
    DASHCALL_AGENT_URL: `http://127.0.0.1:${agent.address().port}`, DASHCALL_AGENT_TOKEN: TOKEN, DASHCALL_TRUST_PROXY: '1',
  });
  base = `http://127.0.0.1:${web.port}`;
});
after(() => { web?.kill(); agent?.close(); });

const login = (password, ip = '10.0.0.1') => fetch(base + '/login', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ password }),
});
const cookieOf = r => r.headers.get('set-cookie').split(';')[0];
async function assertError(r, status, code) {
  assert.equal(r.status, status);
  const d = await r.json();
  assert.equal(d.code, code);
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

test('login is rate limited per client IP', async () => {
  for (let i = 0; i < 10; i++) await login('wrong', '10.9.9.9');
  await assertError(await login(PASSWORD, '10.9.9.9'), 429, 'rate_limited');
  assert.equal((await login(PASSWORD, '10.9.9.8')).status, 200);
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
  const results = await Promise.all(Array.from({ length: 30 }, () => login('wrong', '10.7.7.7')));
  const statuses = results.map(r => r.status);
  assert.equal(statuses.filter(s => s === 401).length, 10);
  assert.equal(statuses.filter(s => s === 429).length, 20);
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
