// Demo agent: the whole agent HTTP API with realistic fake data, so the web app can be tried without a Mac,
// herdr or Claude Code. Everything lives in memory. Started by `npm run demo` (scripts/demo.mjs).
import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { httpError, errorBody } from '../agent/errors.mjs';
import { pickLang } from '../agent/lang.mjs';

const TOKEN = process.env.DASHCALL_TOKEN;
if (!TOKEN) { console.error('DASHCALL_TOKEN missing'); process.exit(1); }
const PORT = Number(process.env.DASHCALL_PORT || 7420), BIND = process.env.DASHCALL_BIND || '127.0.0.1';
const SOUND = process.env.DASHCALL_DEMO_SOUND === '1';
const LANG = pickLang(process.env.DASHCALL_DEFAULT_LANGUAGE, 'en'); // language of the seeded notifications and brain
const HOME = '/Users/demo', CODE = `${HOME}/code`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
const id = () => randomBytes(4).toString('hex');
const L10N = (en, tr) => (LANG === 'tr' ? tr : en);

// ---------- fake terminal screens (what `herdr agent read` returns) ----------
const header = cwd => `╭────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code!                      │
│                                                │
│   /help for help, /status for your setup       │
│                                                │
│   cwd: ${cwd.padEnd(40)}│
╰────────────────────────────────────────────────╯
`;
const inputBox = `
╭────────────────────────────────────────────────╮
│ >                                              │
╰────────────────────────────────────────────────╯
  ⏵⏵ accept edits on (shift+tab to cycle)`;

const SCREENS = {
  api: `${header(`${CODE}/api-server`)}
> Add rate limiting to the public API: 100 requests per minute per API key,
  backed by Redis. Return 429 with a Retry-After header.

⏺ I'll look at how requests flow through the middleware first.

⏺ Read(src/app.ts)
  ⎿  Read 84 lines

⏺ Search(pattern: "redis", path: "src")
  ⎿  Found 3 files

⏺ There's already a Redis client in src/lib/redis.ts, so I'll build a
  sliding-window limiter on top of it.

⏺ Write(src/middleware/rateLimit.ts)
  ⎿  Wrote 58 lines to src/middleware/rateLimit.ts
     import type { Request, Response, NextFunction } from 'express';
     import { redis } from '../lib/redis';

     export function rateLimit({ limit, windowMs }: Options) {
     … +52 lines (ctrl+r to expand)

⏺ Update(src/app.ts)
  ⎿  Updated src/app.ts with 1 addition
       11    app.use(express.json());
       12 +  app.use('/v1', rateLimit({ limit: 100, windowMs: 60_000 }));
       13    app.use('/v1', router);

⏺ Bash(npm test -- rateLimit)
  ⎿  Running…

✻ Running tests… (38s · ↓ 1.2k tokens · esc to interrupt)
${inputBox}`,

  mobile: `${header(`${CODE}/mobile-app`)}
> The app crashes right after login on Android 14. The stack trace is in
  crash.log. Find and fix it.

⏺ Read(crash.log)
  ⎿  Read 41 lines

⏺ Search(pattern: "SecureStore.get", path: "src")
  ⎿  Found 2 files

⏺ Found it: on Android 14 the keystore returns null for a token that was
  never written, and LoginScreen calls .length on it right after login.

⏺ Update(src/screens/LoginScreen.tsx)

╭──────────────────────────────────────────────────────────────╮
│ Edit file                                                    │
│                                                              │
│  src/screens/LoginScreen.tsx                                 │
│  47 -  const token = await SecureStore.get(TOKEN_KEY);       │
│  48 -  if (token.length > 0) navigation.replace('Home');     │
│  47 +  const token = await SecureStore.get(TOKEN_KEY);       │
│  48 +  if (token?.length) navigation.replace('Home');        │
│                                                              │
│ Do you want to make this edit to LoginScreen.tsx?            │
│ ❯ 1. Yes                                                     │
│   2. Yes, allow all edits during this session (shift+tab)    │
│   3. No, and tell Claude what to do differently (esc)        │
╰──────────────────────────────────────────────────────────────╯`,

  docs: `${header(`${CODE}/docs-site`)}
> Update the getting-started guide for the v2 CLI and fix any broken links.

⏺ Read(docs/getting-started.md)
  ⎿  Read 212 lines

⏺ Bash(npx linkinator ./build --recurse)
  ⎿  7 broken links found

⏺ Update(docs/getting-started.md)
  ⎿  Updated docs/getting-started.md with 38 additions and 41 removals

⏺ Bash(npm run build)
  ⎿  ✔ Built 64 pages in 3.2s

⏺ Done. Summary:
  - Rewrote the getting-started guide for the v2 CLI (new \`init\` flow,
    config file instead of flags)
  - Fixed 7 broken links (3 moved pages, 4 typos)
  - \`npm run build\` passes with no warnings
${inputBox}`,
};

// ---------- state ----------
const sessions = [
  { pane: 'w1:p1', name: null, agent: 'claude', status: 'working', cwd: `${CODE}/api-server`, workspace: 'api-server', title: 'Add rate limiting to the public API',
    sessionId: '3f2b8c1e-5a47-4d0e-9b6a-1c8e7f2d4a90', screen: SCREENS.api, lastTs: ago(8),
    lastUser: 'Add rate limiting to the public API: 100 requests per minute per API key, backed by Redis. Return 429 with a Retry-After header.',
    lastAssistant: "There's already a Redis client in src/lib/redis.ts, so I'll build a sliding-window limiter on top of it." },
  { pane: 'w2:p1', name: null, agent: 'claude', status: 'blocked', cwd: `${CODE}/mobile-app`, workspace: 'mobile-app', title: 'Fix login crash on Android 14',
    sessionId: '9a6d0e72-1b3c-4f58-a2e4-6d7c8b9f0e13', screen: SCREENS.mobile, lastTs: ago(95),
    lastUser: 'The app crashes right after login on Android 14. The stack trace is in crash.log. Find and fix it.',
    lastAssistant: 'Found it: on Android 14 the keystore returns null for a token that was never written, and LoginScreen calls .length on it right after login.' },
  { pane: 'w3:p1', name: null, agent: 'claude', status: 'done', cwd: `${CODE}/docs-site`, workspace: 'docs-site', title: 'Update the getting-started guide',
    sessionId: 'c47e1a95-8f2d-4b6c-b0a3-2e9d5f7a1c68', screen: SCREENS.docs, lastTs: ago(14 * 60),
    lastUser: 'Update the getting-started guide for the v2 CLI and fix any broken links.',
    lastAssistant: 'Done. Summary:\n- Rewrote the getting-started guide for the v2 CLI (new `init` flow, config file instead of flags)\n- Fixed 7 broken links (3 moved pages, 4 typos)\n- `npm run build` passes with no warnings' },
];
const recentOnly = [
  { sessionId: '5e8a2f10-7c3d-4a9b-8e61-0f4b2d7c9a35', title: 'Run the full test suite', cwd: `${CODE}/billing-service`, lastTs: ago(3 * 3600),
    lastUser: 'Run the full test suite and tell me what fails.',
    lastAssistant: '412 passed, 2 failed. Both failures are in currency rounding (tests/invoice.rounding.test.ts): amounts in JPY are rounded to 2 decimals instead of 0.' },
  { sessionId: 'b1d94c27-3e6f-4852-a7c0-8d2e5b1f6a04', title: 'Bump Terraform providers', cwd: `${CODE}/infra`, lastTs: ago(26 * 3600),
    lastUser: 'Bump the AWS and Cloudflare Terraform providers and check the plan.',
    lastAssistant: 'Bumped aws to 5.62 and cloudflare to 4.39. `terraform plan` shows no changes to existing resources.' },
];
const dirs = ['api-server', 'mobile-app', 'docs-site', 'billing-service', 'infra', 'design-system', 'playground']
  .map((name, i) => ({ name, path: `${CODE}/${name}`, mtime: Date.now() - i * 5400e3 }));

const brain = {
  memory: [
    { id: id(), text: L10N('Prefers short spoken answers while driving', 'Araç kullanırken kısa, sesli cevapları tercih ediyor'), ts: ago(9 * 86400) },
    { id: id(), text: L10N('Main projects: api-server, mobile-app and docs-site', 'Ana projeler: api-server, mobile-app ve docs-site'), ts: ago(6 * 86400) },
  ],
  notes: [ // oldest first, like the real brain file (the app shows the newest on top)
    { id: id(), text: L10N('Renew the staging TLS certificate', 'Staging TLS sertifikasını yenile'), ts: ago(3 * 86400), done: true, doneTs: ago(2 * 86400) },
    { id: id(), text: L10N('Ask the design team about the new onboarding screens', 'Tasarım ekibine yeni onboarding ekranlarını sor'), ts: ago(28 * 3600), done: false },
    { id: id(), text: L10N("Review the rate-limit PR before Friday's release", 'Cuma sürümünden önce rate-limit PR\'ını incele'), ts: ago(2 * 3600), done: false },
  ],
  muted: [{ id: id(), key: 'legacy-dashboard', label: 'legacy-dashboard', reason: L10N('archived project', 'arşivlenmiş proje'), ts: ago(12 * 86400) }],
};
const isMuted = s => brain.muted.some(m => m.key === s.sessionId || (s.cwd && s.cwd.toLowerCase().includes(m.key.toLowerCase())));

const notifications = [ // oldest first (the API returns them newest first)
  { id: id(), ts: ago(3 * 3600), read: false, kind: 'task', lang: LANG, conversationId: null,
    title: L10N('Run the full test suite on billing-service', "billing-service'te tüm testleri çalıştır"),
    q: L10N('Run the full test suite on billing-service', "billing-service'te tüm testleri çalıştır"),
    text: L10N('The billing-service tests finished: 412 passed and 2 failed, both in currency rounding: yen amounts get two decimals. Want me to go into detail?',
      "billing-service testleri bitti: 412 test geçti, 2'si kaldı; ikisi de para birimi yuvarlamasında, yen tutarları iki ondalıkla yuvarlanıyor. İstersen detayını anlatayım.") },
  { id: id(), ts: ago(40 * 60), read: true, kind: 'answer', lang: LANG, conversationId: null,
    q: L10N('Is the docs site done?', 'Doküman sitesi bitti mi?'),
    text: L10N('Yes. The getting-started guide is updated for the v2 CLI, 7 broken links are fixed and the build passes.',
      'Evet. Başlangıç rehberi v2 CLI için güncellendi, 7 kırık link düzeltildi ve build geçiyor.') },
];
const watches = [
  { id: id(), created: ago(6 * 60), state: 'waiting', pane: 'w1:p1', cwd: `${CODE}/api-server`, label: 'Add rate limiting to the public API',
    sessionId: sessions[0].sessionId, sawWorking: true, idlePolls: 0, lang: LANG },
];

// ---------- canned dispatcher replies ----------
const REPLIES = [
  { re: /\b(approve|yes|go ahead)\b|onayla|evet|devam et/i, act: () => approve(sessions[1]),
    en: "Done, I approved the edit in mobile-app. It's applying the login fix and running the tests now; I'll let you know when it's finished.",
    tr: "Tamam, mobile-app'teki düzenlemeyi onayladım. Şimdi giriş düzeltmesini uygulayıp testleri çalıştırıyor; bitince haber veririm." },
  { re: /remind|note|not al|hatırlat/i, act: lang => brain.notes.push({ id: id(), text: lang === 'tr' ? 'API ekibiyle rate-limit sayılarını konuş' : 'Check the rate-limit numbers with the API team', ts: new Date().toISOString(), done: false }),
    en: "Noted. I'll remind you to check the rate-limit numbers with the API team.",
    tr: 'Not aldım. API ekibiyle rate-limit sayılarını konuşmanı hatırlatacağım.' },
  { re: /\btests?\b|billing|testler/i,
    en: 'billing-service finished its test run: 412 passed and 2 failed, both in currency rounding. Yen amounts get two decimals instead of none. Want me to start a session to fix it?',
    tr: "billing-service testleri bitti: 412 geçti, 2'si kaldı; ikisi de para birimi yuvarlamasında. Yen tutarları sıfır yerine iki ondalıkla yuvarlanıyor. Düzeltmesi için bir oturum başlatayım mı?" },
  { re: /./,
    en: 'You have three sessions. api-server is adding rate limiting and is running its tests right now. mobile-app is waiting for you: it wants approval for an edit that fixes the Android 14 login crash. docs-site is done; the guide is updated and the build passes.',
    tr: "Üç oturumun var. api-server rate limiting ekliyor, şu an testleri çalıştırıyor. mobile-app seni bekliyor: Android 14'teki giriş çökmesini düzelten bir düzenleme için onay istiyor. docs-site bitti; rehber güncellendi ve build geçiyor." },
];
const TRANSCRIPTS = { en: 'What are my sessions doing right now?', tr: 'Oturumlarım şu an ne yapıyor?' };

function approve(s) {
  if (s.status !== 'blocked') return;
  s.screen = s.screen.replace(/\n╭─+╮\n│ Edit file[\s\S]*$/, '') + '\n  ⎿  Updated src/screens/LoginScreen.tsx with 1 addition and 1 removal\n\n⏺ Bash(npm test -- login)\n  ⎿  Running…\n\n✻ Running tests… (esc to interrupt)\n' + inputBox;
  work(s, 'Fixed: LoginScreen now handles a missing token. All 38 login tests pass.');
}
// The session "works" for a few seconds, then finishes with the given reply.
function work(s, reply) {
  Object.assign(s, { status: 'working', lastTs: new Date().toISOString() });
  setTimeout(() => {
    s.screen = s.screen.replace(/\n✻ [^\n]*\n/, '\n').replace(inputBox, '') + `\n⏺ ${reply}\n${inputBox}`;
    Object.assign(s, { status: 'done', lastAssistant: reply, lastTs: new Date().toISOString() });
  }, 6000).unref();
}

const jobs = new Map();
function ask(text, conversationId, lang) {
  const job = { id: randomUUID(), status: 'running', started: Date.now(), lang };
  jobs.set(job.id, job);
  setTimeout(() => {
    const r = REPLIES.find(x => x.re.test(text));
    r.act?.(lang);
    Object.assign(job, { status: 'done', reply: r[lang], conversationId: conversationId || randomUUID() });
    const n = { id: id(), ts: new Date().toISOString(), read: false, jobId: job.id, kind: 'answer', lang, title: null, q: text, text: job.reply, error: false, conversationId: job.conversationId };
    notifications.push(n); job.notificationId = n.id;
  }, 1500).unref();
  return job;
}

// ---------- HTTP ----------
async function json(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 25e6) throw httpError(413, 'too_large', 'request body too large'); chunks.push(c); }
  const b = Buffer.concat(chunks);
  if (req.headers['content-type']?.startsWith('audio/')) return b;
  if (!b.length) return {};
  try { const d = JSON.parse(b); return d && typeof d === 'object' ? d : {}; } catch { throw httpError(400, 'invalid_json', 'invalid JSON'); }
}
const requireText = t => { if (typeof t !== 'string' || !t.trim()) throw httpError(400, 'text_required', 'text required'); return t.trim(); };
const session = pane => sessions.find(s => s.pane === pane) || (() => { throw httpError(500, 'internal', `pane ${pane} not found`); })();
const pub = s => { const { screen, ...rest } = s; return { ...rest, muted: isMuted(s) }; };
const KEYS = new Set(['esc', 'enter', 'ctrl+c', 'up', 'down', 'tab', 'shift+tab', '1', '2', '3']);

const routes = [
  // Demo/development is silent: the app shows timed subtitles and plays no audio at all (DASHCALL_DEMO_SOUND=1 opts in).
  ['GET', /^\/api\/health$/, () => ({ ok: true, silent: !SOUND })],
  ['GET', /^\/api\/sessions$/, () => ({ sessions: sessions.map(pub) })],
  ['GET', /^\/api\/recent$/, () => ({ sessions: [...sessions.map(pub), ...recentOnly.map(s => ({ ...s, mtime: s.lastTs, muted: isMuted(s) }))] })],
  ['GET', /^\/api\/sessions\/([\w:]+)\/screen$/, (req, b, m) => ({ text: session(m[1]).screen })],
  ['POST', /^\/api\/sessions\/([\w:]+)\/prompt$/, (req, b, m) => {
    const s = session(m[1]), text = requireText(b.text);
    s.screen = s.screen.replace(inputBox, '') + `\n> ${text}\n\n✻ Thinking… (esc to interrupt)\n${inputBox}`;
    s.lastUser = text;
    work(s, 'Done. I made the change and the tests pass.');
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w:]+)\/keys$/, (req, b, m) => {
    if (!Array.isArray(b.keys) || !b.keys.every(k => KEYS.has(k))) throw httpError(400, 'bad_keys', 'bad keys');
    const s = session(m[1]);
    if (s.status === 'blocked' && ['1', '2', 'enter'].includes(b.keys[0])) approve(s);
    else if (s.status === 'working' && ['esc', 'ctrl+c'].includes(b.keys[0])) {
      s.screen = s.screen.replace(/\n✻ [^\n]*\n/, '\n  ⎿  Interrupted by user\n');
      s.status = 'idle';
    }
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/new$/, (req, b) => {
    if (typeof b.cwd !== 'string' || !b.cwd) throw httpError(400, 'folder_not_found', 'cwd required');
    const cwd = b.cwd.replace(/^~(?=$|\/)/, HOME).replace(/\/+$/, '');
    if (!cwd.startsWith(HOME + '/')) throw httpError(400, 'folder_outside_root', `Folder must be inside ${HOME}: ${cwd}`);
    const n = sessions.length + 1, name = cwd.split('/').pop(), prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
    const s = { pane: `w${n}:p1`, name: null, agent: 'claude', status: 'idle', cwd, workspace: b.label || name, title: prompt ? prompt.slice(0, 60) : null,
      sessionId: randomUUID(), screen: header(cwd) + inputBox, lastTs: new Date().toISOString(), lastUser: prompt || null, lastAssistant: null };
    sessions.push(s);
    if (prompt) { s.screen = header(cwd) + `\n> ${prompt}\n\n✻ Thinking… (esc to interrupt)\n${inputBox}`; work(s, 'Done. Here is what I changed: …'); }
    return { pane: s.pane, cwd };
  }],
  ['GET', /^\/api\/dirs$/, () => ({ dirs })],
  ['POST', /^\/api\/ask$/, (req, b) => {
    const text = requireText(b.text);
    if (b.conversationId != null && !/^[0-9a-f-]{36}$/i.test(b.conversationId)) throw httpError(400, 'bad_conversation_id', 'bad conversationId');
    const j = ask(text, b.conversationId, pickLang(b.lang, LANG));
    return { id: j.id, status: j.status };
  }],
  ['GET', /^\/api\/ask\/([\w-]+)$/, (req, b, m) => {
    const j = jobs.get(m[1]);
    if (!j) throw httpError(404, 'unknown_job', 'unknown job');
    return { id: j.id, status: j.status, lang: j.lang, reply: j.reply, conversationId: j.conversationId, notificationId: j.notificationId, elapsed: Date.now() - j.started };
  }],
  // No neural voices in the demo: the app falls back to the browser's own speech synthesis.
  ['POST', /^\/api\/speak$/, () => {
    if (SOUND) throw httpError(501, 'internal', 'no neural voices in demo mode: the browser voice is used');
    return { engine: 'silent', mime: null, audio: null, words: [] };
  }],
  ['POST', /^\/api\/stt$/, (req, b, m, url) => {
    if (!Buffer.isBuffer(b) || b.length < 12) throw httpError(415, 'unsupported_audio', 'unsupported audio format');
    return { text: TRANSCRIPTS[pickLang(url.searchParams.get('lang'), LANG)] };
  }],
  ['GET', /^\/api\/notifications$/, () => ({ items: notifications.slice(-100).reverse(), unread: notifications.filter(n => !n.read).length })],
  ['POST', /^\/api\/notifications\/read$/, (req, b) => {
    for (const n of notifications) if (b.ids === 'all' || (Array.isArray(b.ids) && b.ids.includes(n.id))) n.read = true;
    return { ok: true };
  }],
  ['GET', /^\/api\/watches$/, () => ({ watches: watches.filter(w => w.state === 'waiting') })],
  ['GET', /^\/api\/brain$/, () => brain],
  ['POST', /^\/api\/brain\/(note|memory)$/, (req, b, m) => {
    const item = { id: id(), text: requireText(b.text), ts: new Date().toISOString(), ...(m[1] === 'note' && { done: false }) };
    brain[m[1] === 'note' ? 'notes' : 'memory'].push(item); return item;
  }],
  ['POST', /^\/api\/brain\/mute$/, (req, b) => {
    if (typeof b.key !== 'string' || !b.key) throw httpError(400, 'key_required', 'key required');
    let m = brain.muted.find(x => x.key === b.key);
    if (!m) brain.muted.push(m = { id: id(), key: b.key, label: b.label || b.key, reason: '', ts: new Date().toISOString() });
    return m;
  }],
  ['POST', /^\/api\/brain\/done\/(\w+)$/, (req, b, m) => {
    const n = brain.notes.find(x => x.id === m[1]);
    if (!n) throw httpError(404, 'not_found', 'no such note');
    Object.assign(n, { done: true, doneTs: new Date().toISOString() }); return n;
  }],
  ['POST', /^\/api\/brain\/forget$/, (req, b) => {
    if (typeof b.key !== 'string' || !b.key) throw httpError(400, 'key_required', 'key required');
    for (const k of ['memory', 'notes', 'muted']) {
      const i = brain[k].findIndex(x => x.id === b.key || (k === 'muted' && x.key === b.key));
      if (i >= 0) return brain[k].splice(i, 1)[0];
    }
    throw httpError(404, 'not_found', 'not found: ' + b.key);
  }],
];

function authed(req) {
  const a = Buffer.from(req.headers.authorization || ''), b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
function send(res, status, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized', code: 'unauthorized' });
    // inside the try: a malformed request line must not crash the server
    try { url = new URL(req.url, 'http://x'); } catch { throw httpError(400, 'bad_path', 'bad path'); }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'bad_path', 'bad path'); }
    const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
    if (!route) throw httpError(404, 'not_found', 'not found');
    const b = req.method === 'POST' ? await json(req) : {};
    send(res, 200, await route[2](req, b, pathname.match(route[1]), url));
  } catch (e) {
    const [status, data] = errorBody(e);
    if (status >= 500 && status !== 501) log('error', req.method, url?.pathname ?? req.url, e.message);
    send(res, status, data);
  }
});
server.listen(PORT, BIND, () => log(`dashcall mock agent on ${BIND}:${server.address().port}`));
