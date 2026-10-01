// Runs the real single-page app (web/public/app.js) in a small fake browser: a DOM built from index.html, a fake
// fetch, a fake microphone and a speech stub. Nothing touches the network or makes a sound, and time runs FAST times
// faster than the wall clock (or `fast` times, for tests that wait many virtual minutes) so the app's own waits
// (polling, retries, timeouts) stay short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const HTML = read('web/public/index.html');
// The page's own scripts, in document order, so the harness keeps up when scripts are added or split.
const SCRIPTS = [...HTML.matchAll(/<script\b[^>]*\bsrc="\/([\w.-]+\.js)"/g)].map(m => 'web/public/' + m[1]).map(f => [f, read(f)]);
if (!SCRIPTS.some(([f]) => f === 'web/public/app.js')) throw new Error('index.html no longer loads /app.js');
const FAST = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONV_A = '11111111-1111-4111-8111-111111111111', CONV_N = '22222222-2222-4222-8222-222222222222';
const http = (status, body) => ({ __http: status, body }); // a route's non-200 answer

class El {
  constructor(dom, tag, attrs = {}) {
    Object.assign(this, { dom, tagName: tag.toUpperCase(), attrs: { ...attrs }, hidden: 'hidden' in attrs, disabled: 'disabled' in attrs,
      value: attrs.value ?? '', style: {}, dataset: {}, _text: '', _html: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase())] = v;
    this.classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => c.forEach(x => this.classes.add(x)), remove: (...c) => c.forEach(x => this.classes.delete(x)),
      contains: c => this.classes.has(c), toggle: (c, on = !this.classes.has(c)) => { if (on) this.classes.add(c); else this.classes.delete(c); return on; },
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this._html = ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = this._html.replace(/<[^>]*>/g, ''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  remove() { this.dom.all.delete(this); }
  querySelectorAll() { return []; } querySelector() { return null; } closest() { return null; } contains() { return false; }
  addEventListener() {} removeEventListener() {} focus() {} blur() {} click() { this.onclick?.(); } scrollIntoView() {} insertAdjacentHTML() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}

function boot({ routes = {}, crypto = globalThis.crypto, fast = FAST } = {}) {
  const dom = { all: new Set(), byId: new Map(), toasts: [] };
  for (const m of HTML.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(a => [a[1], a[2] ?? '']));
    const el = new El(dom, m[1], attrs);
    dom.all.add(el); if (attrs.id) dom.byId.set(attrs.id, el);
  }
  // simple selectors only (.class, [attr]); anything more complex matches nothing
  const select = sel => !/^(\.[\w-]+|\[[\w-]+\])$/.test(sel) ? []
    : [...dom.all].filter(el => sel[0] === '.' ? el.classes.has(sel.slice(1)) : sel.slice(1, -1) in el.attrs);
  const document = {
    getElementById: id => dom.byId.get(id) ?? null, querySelectorAll: select, querySelector: sel => select(sel)[0] ?? null,
    createElement: tag => new El(dom, tag),
    body: { appendChild: el => { dom.all.add(el); if (el.classes.has('toast')) dom.toasts.push(el.textContent); return el; } },
    documentElement: {}, visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };

  // virtual time
  const timers = new Set(); let closed = false;
  const start = Date.now(), now = () => start + (Date.now() - start) * fast;
  const later = (fn, ms) => {
    if (closed) return 0;
    const h = setTimeout(() => { timers.delete(h); fn(); }, Math.max(0, ms || 0) / fast);
    timers.add(h); return h;
  };
  const cancel = h => { clearTimeout(h); clearInterval(h); timers.delete(h); };

  // network
  const calls = [];
  const DEFAULTS = {
    'GET /health': () => ({ ok: true }),
    'GET /notifications': () => ({ items: [], unread: 0 }),
    'POST /notifications/read': () => ({ ok: true }),
    'POST /speak': () => http(501, { error: 'no neural voice here', code: 'internal' }), // → the (stubbed) browser voice
    'GET /sessions': () => ({ sessions: [] }), 'GET /recent': () => ({ sessions: [] }),
    'GET /dirs': () => ({ dirs: [{ name: 'api', path: '/Users/you/api', mtime: 0 }] }),
    'GET /brain': () => ({ memory: [], notes: [], muted: [] }),
  };
  function fetch(url, opts = {}) {
    let body = opts.body;
    if (typeof body === 'string') try { body = JSON.parse(body); } catch {}
    const call = { method: opts.method || 'GET', path: String(url).replace(/^\/api/, '').split('?')[0], body };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`] ?? DEFAULTS[`${call.method} ${call.path}`] ?? (() => http(404, { error: 'not found', code: 'not_found' }));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (opts.signal?.aborted) return abort();
      opts.signal?.addEventListener('abort', abort);
      Promise.resolve().then(() => route(call)).then(r => {
        const [status, data] = r?.__http ? [r.__http, r.body] : [200, r];
        resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }));
      }, () => reject(new TypeError('Failed to fetch')));
    });
  }

  // microphone and speech
  const mic = { deny: false, failStart: false, tracksStopped: 0, recorders: [] };
  const navigator = {
    language: 'en-US',
    mediaDevices: {
      async getUserMedia() {
        if (mic.deny) throw new DOMException('Permission denied', 'NotAllowedError');
        return { getTracks: () => [{ stop: () => mic.tracksStopped++ }] };
      },
    },
  };
  class MediaRecorder {
    static isTypeSupported(m) { return m === 'audio/webm'; }
    constructor(stream, opts) { this.mimeType = opts?.mimeType || 'audio/webm'; this.state = 'inactive'; mic.recorders.push(this); }
    start() { if (mic.failStart) throw new DOMException('cannot record', 'NotSupportedError'); this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      later(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array(4000)], { type: this.mimeType }) }); this.onstop?.(); }, 0);
    }
  }
  const spoken = [], spokenLangs = [];
  const speechSynthesis = { speak: u => { spoken.push(u.text); spokenLangs.push(u.lang); later(() => u.onend?.(), 0); }, cancel() {}, getVoices: () => [] };
  class SpeechSynthesisUtterance { constructor(text) { this.text = text; } }
  class Audio { play() { return Promise.resolve(); } pause() {} load() {} }
  class FakeURL extends URL { static createObjectURL() { return 'blob:fake'; } static revokeObjectURL() {} }
  const storage = new Map();

  const ctx = {
    document, navigator, console, crypto, location: { href: '/' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    setTimeout: (fn, ms, ...a) => later(() => fn(...a), ms), clearTimeout: cancel,
    setInterval: (fn, ms) => { if (closed) return 0; const h = setInterval(fn, Math.max(1, ms / fast)); timers.add(h); return h; }, clearInterval: cancel,
    requestAnimationFrame: fn => later(() => fn(now() - start), 16), cancelAnimationFrame: cancel,
    performance: { now: () => now() - start },
    fetch, AbortController, Blob, URL: FakeURL, atob, btoa, DOMException,
    Audio, MediaRecorder, speechSynthesis, SpeechSynthesisUtterance,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, Event: class {},
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    __now: now,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('Date.now = __now;', ctx);
  for (const [filename, src] of SCRIPTS) vm.runInContext(src, ctx, { filename });

  const $ = id => dom.byId.get(id);
  return {
    $, mic, spoken, spokenLangs, now,
    get: expr => vm.runInContext(expr, ctx), // reads the app's top-level state, e.g. get('driveState')
    calls: key => calls.filter(c => `${c.method} ${c.path}` === key),
    lastToast: () => dom.toasts.at(-1) ?? '',
    mics: () => select('[data-mic]'),
    recording: () => mic.recorders.at(-1)?.state === 'recording',
    tab: view => select('.tab').find(el => el.dataset.view === view).onclick(),
    typeQuestion(text) { $('typein').value = text; $('typeform').onsubmit({ preventDefault() {} }); },
    startJob(prompt) {
      this.tab('new');
      $('n-custom').value = '~/api'; $('n-prompt').value = prompt;
      $('newform').onsubmit({ preventDefault() {} });
    },
    async until(cond, what, ms = 3000) {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what);
        await new Promise(r => setTimeout(r, 2));
      }
    },
    close() { closed = true; for (const h of timers) cancel(h); },
  };
}

test('a job the agent lost (it restarted) ends the wait at once, with a clear message', async () => {
  const h = boot({ routes: {
    'POST /ask': () => ({ id: 'job-1', status: 'running' }),
    'GET /ask/job-1': () => http(404, { error: 'unknown job', code: 'unknown_job' }),
  } });
  try {
    const t0 = h.now();
    h.typeQuestion('what is going on?');
    await h.until(() => h.spoken.length, 'the problem to be spoken');
    assert.match(h.spoken[0], /restarted and lost this question\. Please ask again/);
    assert.ok(h.now() - t0 < 150e3, 'long before the 5-minute limit');
    assert.equal(h.calls('GET /ask/job-1').length, 1, 'stops polling at the first unknown_job');
    await h.until(() => h.get('driveState') === 'idle', 'drive mode to be idle again');
  } finally { h.close(); }
});

// A job that waits behind an earlier one of its conversation (agents that serialize them say `queued: true`): its
// 5 minutes start when it runs, and the app says what it is waiting for.
const MIN = 60e3;
function stagedJob(stages, done) { // stages: [[virtual ms, job fields], …] from the POST on; then `done`
  let h, t0;
  const job = () => {
    const at = h.now() - t0;
    for (const [until, fields] of stages) if (at < until) return { id: 'job-q', status: 'running', ...fields };
    return { id: 'job-q', ...done };
  };
  return {
    attach: x => { h = x; },
    routes: { 'POST /ask': () => { t0 = h.now(); return job(); }, 'GET /ask/job-q': job },
  };
}

test('a queued question waits for its turn without timing out, and says so', async () => {
  const s = stagedJob([[6 * MIN, { queued: true }], [8 * MIN, {}]], { status: 'done', reply: 'Queued answer.', conversationId: CONV_A });
  const h = boot({ routes: s.routes, fast: 1000 }); s.attach(h);
  try {
    h.typeQuestion('and the tests?');
    await h.until(() => /Waiting for the previous answer/.test(h.$('state').textContent), 'the queued state');
    await h.until(() => /Looking into it|Still looking/.test(h.$('state').textContent), 'the job to run', 10000);
    await h.until(() => h.spoken.length, 'the answer', 10000);
    assert.deepEqual(h.spoken, ['Queued answer.'], '8 minutes after the POST, but only 2 of them running');
    await h.until(() => h.get('driveState') === 'idle', 'drive mode to be idle again');
  } finally { h.close(); }
});

test('the 5-minute limit counts from when the job runs, with a 15-minute cap, and agents without queues work as before', async () => {
  const cases = [
    ['queued, then running for too long', [[6 * MIN, { queued: true }], [Infinity, {}]], 11 * MIN],
    ['queued for ever', [[Infinity, { queued: true }]], 15 * MIN],
    ['an agent that never says queued', [[Infinity, {}]], 5 * MIN],
  ];
  for (const [what, stages, limit] of cases) {
    const s = stagedJob(stages);
    const h = boot({ routes: s.routes, fast: 1000 }); s.attach(h);
    try {
      const t0 = h.now();
      h.typeQuestion('anything');
      await h.until(() => h.spoken.length, `${what}: the give-up`, 10000);
      const took = h.now() - t0;
      assert.match(h.spoken[0], /Something went wrong: Timed out/, what);
      assert.ok(took >= limit && took < limit + 0.5 * MIN, `${what}: gave up after ${(took / MIN).toFixed(2)} min`);
    } finally { h.close(); }
  }
});

test("an agent's friendly error is spoken as is, in the question's language; other errors keep the prefix", async () => {
  const friendly = '[[Claude|klod]] kullanım limitine ulaşıldı, 14:00’te sıfırlanıyor.';
  let h = boot({ routes: {
    'POST /ask': () => ({ id: 'j', status: 'running' }),
    'GET /ask/j': () => ({ id: 'j', status: 'error', lang: 'tr', error: friendly, detail: "You've hit your session limit · resets 2pm", notificationId: 'n-err' }),
  } });
  try {
    h.get("setLang('tr')");
    h.typeQuestion('işler ne durumda?');
    h.get("setLang('en')"); // switching meanwhile doesn't change the language of the answer
    await h.until(() => h.spoken.length, 'the error');
    assert.deepEqual(h.spoken, ['klod kullanım limitine ulaşıldı, 14:00’te sıfırlanıyor.']);
    assert.deepEqual(h.spokenLangs, ['tr-TR']);
    // heard here, so its notification is read: it must not pop up again when the app is next opened
    assert.deepEqual(h.calls('POST /notifications/read').map(c => c.body.ids), [['n-err']]);
  } finally { h.close(); }

  h = boot({ routes: { 'POST /ask': () => ({ id: 'j', status: 'running' }), 'GET /ask/j': () => ({ id: 'j', status: 'error', error: 'exit 1' }) } });
  try {
    h.typeQuestion('hi');
    await h.until(() => h.spoken.length, 'the error');
    assert.deepEqual(h.spoken, ['Something went wrong: exit 1']);
  } finally { h.close(); }
});

test('every question carries one requestId, reused when its POST is retried', async () => {
  let posts = 0;
  const h = boot({ routes: {
    'POST /ask': () => { if (++posts === 1) throw new Error('connection dropped'); return { id: 'job-' + posts, status: 'running' }; },
    'GET /ask/job-2': () => ({ id: 'job-2', status: 'done', reply: 'First answer.', conversationId: CONV_A }),
    'GET /ask/job-3': () => ({ id: 'job-3', status: 'done', reply: 'Second answer.', conversationId: CONV_A }),
  } });
  try {
    h.typeQuestion('first');
    await h.until(() => h.spoken.includes('First answer.') && h.get('driveState') === 'idle', 'the first answer');
    h.typeQuestion('second');
    await h.until(() => h.spoken.includes('Second answer.'), 'the second answer');
    const ids = h.calls('POST /ask').map(c => c.body.requestId);
    assert.equal(ids.length, 3);
    assert.match(ids[0], UUID);
    assert.equal(ids[1], ids[0], 'the retry is the same question');
    assert.notEqual(ids[2], ids[0], 'a new question gets a new id');
  } finally { h.close(); }
});

test('requestId works without crypto.randomUUID (older Chromium, or not HTTPS)', async () => {
  const cases = [
    [{ getRandomValues: a => a.fill(0xab) }, id => assert.equal(id, 'abababab-abab-4bab-abab-abababababab')],
    [undefined, id => assert.match(id, UUID)],
  ];
  for (const [crypto, check] of cases) {
    const h = boot({ crypto, routes: { 'POST /ask': () => ({ id: 'j', status: 'running' }), 'GET /ask/j': () => ({ id: 'j', status: 'done', reply: 'ok' }) } });
    try {
      h.typeQuestion('hi');
      await h.until(() => h.calls('POST /ask').length, 'the question');
      check(h.calls('POST /ask')[0].body.requestId);
    } finally { h.close(); }
  }
});

test('a new job may take a minute to start, and a timeout points to Sessions instead of inviting a retry', async () => {
  // shell start-up, Claude Code and the trust prompt: about 60 s is normal
  let h = boot({ routes: { 'POST /sessions/new': () => new Promise(r => setTimeout(() => r({ pane: 'w9:p1', cwd: '/Users/you/api' }), 60e3 / FAST)) } });
  try {
    h.startJob('add a health endpoint');
    await h.until(() => /Started: api/.test(h.lastToast()), 'the started toast');
    assert.equal(h.get('current'), 'sessions');
    assert.equal(h.$('n-prompt').value, '');
  } finally { h.close(); }

  // the agent never answers; like the real web proxy, this one gives up at 120 s, so the app must give up first
  const proxyGivesUp = () => new Promise(r => setTimeout(() => r(http(502, { error: 'agent did not answer', code: 'agent_unreachable' })), 120e3 / FAST));
  h = boot({ routes: { 'POST /sessions/new': proxyGivesUp } });
  try {
    const t0 = h.now();
    h.startJob('add a health endpoint');
    h.$('newform').onsubmit({ preventDefault() {} }); // a second submit while waiting is ignored
    await h.until(() => !h.$('n-go').disabled, 'the start to give up', 5000);
    assert.ok(h.now() - t0 >= 90e3, `gave up after only ${h.now() - t0} ms`);
    assert.equal(h.calls('POST /sessions/new').length, 1, 'no automatic or double retry');
    assert.match(h.lastToast(), /may still be starting/);
    assert.match(h.$('n-err').textContent, /Check Sessions before starting it again/);
    assert.equal(h.get('current'), 'sessions');
    assert.equal(h.$('n-prompt').value, 'add a health endpoint', 'the task is kept in case it never started');
  } finally { h.close(); }
});

test('dictation stays out of drive mode: failures are toasts, and one voice input runs at a time', async () => {
  let sttOk = false;
  const h = boot({ routes: { 'POST /stt': () => sttOk ? { text: 'hello there' } : http(500, { error: 'whisper failed', code: 'internal' }) } });
  try {
    const mic = h.mics()[0], field = h.$(mic.dataset.mic);
    mic.onclick();
    await h.until(h.recording, 'the dictation to record');
    h.$('talk').onclick();
    assert.equal(h.get('driveState'), 'idle', 'drive mode does not start while dictating');
    assert.match(h.lastToast(), /Voice input is busy/);

    mic.onclick(); // stop: the upload fails (and is retried once)
    await h.until(() => !mic.classList.contains('on'), 'the dictation to end');
    assert.match(h.lastToast(), /send the audio/);
    assert.equal(h.calls('POST /stt').length, 2);
    assert.equal(h.$('resend').hidden, true, 'a failed dictation is not offered as a drive-mode Resend');
    assert.equal(h.get('inflight'), null);

    h.$('talk').onclick(); // drive mode: a failed recording is kept for Resend
    await h.until(h.recording, 'drive mode to record');
    mic.onclick();
    assert.ok(!mic.classList.contains('on'), 'dictation does not start while drive mode listens');
    assert.match(h.lastToast(), /Voice input is busy/);
    h.$('talk').onclick();
    await h.until(() => h.get('driveState') === 'idle' && !h.$('resend').hidden, 'the drive-mode failure');
    assert.match(h.$('state').textContent, /send the audio/);

    sttOk = true; // and a working dictation fills its field
    field.value = 'note:';
    mic.onclick();
    await h.until(h.recording, 'the second dictation');
    mic.onclick();
    await h.until(() => !mic.classList.contains('on'), 'the transcript');
    assert.equal(field.value, 'note: hello there');
    assert.equal(h.$('resend').hidden, false, "the drive recording is still there to resend");
  } finally { h.close(); }
});

test("a dictation's upload can be cancelled from its button, so it can't hold drive mode up", async () => {
  const h = boot({ routes: { 'POST /stt': () => new Promise(() => {}) } }); // whisper never answers
  try {
    const mic = h.mics()[0];
    mic.onclick();
    await h.until(h.recording, 'the dictation to record');
    mic.onclick(); // send
    await h.until(() => h.calls('POST /stt').length === 1, 'the upload');
    h.$('talk').onclick();
    assert.match(h.lastToast(), /Voice input is busy/);
    mic.onclick(); // still lit: cancel the upload
    await h.until(() => !mic.classList.contains('on'), 'the dictation to stop');
    assert.equal(h.lastToast(), 'Cancelled');
    assert.equal(h.calls('POST /stt').length, 1, 'a cancelled upload is not retried');
    assert.equal(h.get('dictCtl'), null);
    h.$('talk').onclick(); // drive mode is free again
    await h.until(h.recording, 'drive mode to record');
    assert.equal(h.get('driveState'), 'listening');
  } finally { h.close(); }
});

test('a notification does not hijack a question in progress', async () => {
  let answered = false;
  const note = { id: 'n1', ts: new Date().toISOString(), read: false, kind: 'answer', lang: 'en', q: 'Earlier question', text: 'Earlier answer.', conversationId: CONV_N };
  const h = boot({ routes: {
    'GET /notifications': () => ({ items: [note], unread: note.read ? 0 : 1 }),
    'POST /notifications/read': ({ body }) => { if (body.ids === 'all' || body.ids.includes('n1')) note.read = true; return { ok: true }; },
    'POST /ask': () => ({ id: 'job-1', status: 'running' }),
    'GET /ask/job-1': () => answered ? { id: 'job-1', status: 'done', reply: 'Current answer.', conversationId: CONV_A } : { id: 'job-1', status: 'running' },
  } });
  try {
    await h.until(() => !h.$('npop').hidden, 'the unread notification to pop up');
    h.typeQuestion('what now?');
    h.$('npop-open').onclick(); // "Listen" while the question is still being answered
    assert.match(h.lastToast(), /Busy right now/);
    assert.equal(h.get('conversationId'), null);
    answered = true;
    await h.until(() => h.spoken.includes('Current answer.') && h.get('driveState') === 'idle', 'the answer');
    assert.equal(h.get('conversationId'), CONV_A);
    assert.equal(note.read, false, 'the notification stays unread');
    assert.ok(!h.get('history').some(x => x.a === 'Earlier answer.'));

    h.$('npop-open').onclick(); // once idle it opens as before: read aloud, marked read, its conversation continues
    await h.until(() => h.spoken.includes('Earlier answer.') && note.read, 'the notification to be read');
    assert.equal(h.get('conversationId'), CONV_N);
  } finally { h.close(); }
});

test('a microphone that fails to start leaves nothing behind', async () => {
  const h = boot();
  try {
    h.mic.deny = true;
    h.$('talk').onclick();
    await h.until(() => h.get('driveState') === 'idle' && /microphone permission/.test(h.$('state').textContent), 'the permission error');
    assert.equal(h.get('activeListen'), null);

    const mic = h.mics()[0];
    mic.onclick(); // dictation gets the same localized message
    await h.until(() => !mic.classList.contains('on'), 'the dictation to fail');
    assert.match(h.lastToast(), /No microphone permission/);
    assert.equal(h.get('activeListen'), null);

    h.mic.deny = false; h.mic.failStart = true; // the mic opens but recording can't start: release it again
    h.$('talk').onclick();
    await h.until(() => h.get('driveState') === 'idle' && /cannot record/.test(h.$('state').textContent), 'the recorder error');
    assert.equal(h.mic.tracksStopped, 1);
    assert.equal(h.get('activeListen'), null);
  } finally { h.close(); }
});
