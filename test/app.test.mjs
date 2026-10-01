// Runs the real single-page app (web/public/app.js) in a small fake browser: a DOM built from index.html, a fake
// fetch, a fake microphone and a speech stub. Nothing touches the network or makes a sound, and time runs FAST times
// faster than the wall clock so the app's own waits (polling, retries, timeouts) stay short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const SRC = { html: read('web/public/index.html'), i18n: read('web/public/i18n.js'), app: read('web/public/app.js') };
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

function boot({ routes = {}, crypto = globalThis.crypto } = {}) {
  const dom = { all: new Set(), byId: new Map(), toasts: [] };
  for (const m of SRC.html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
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
  const start = Date.now(), now = () => start + (Date.now() - start) * FAST;
  const later = (fn, ms) => {
    if (closed) return 0;
    const h = setTimeout(() => { timers.delete(h); fn(); }, Math.max(0, ms || 0) / FAST);
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
  const spoken = [];
  const speechSynthesis = { speak: u => { spoken.push(u.text); later(() => u.onend?.(), 0); }, cancel() {}, getVoices: () => [] };
  class SpeechSynthesisUtterance { constructor(text) { this.text = text; } }
  class Audio { play() { return Promise.resolve(); } pause() {} load() {} }
  class FakeURL extends URL { static createObjectURL() { return 'blob:fake'; } static revokeObjectURL() {} }
  const storage = new Map();

  const ctx = {
    document, navigator, console, crypto, location: { href: '/' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    setTimeout: (fn, ms, ...a) => later(() => fn(...a), ms), clearTimeout: cancel,
    setInterval: (fn, ms) => { if (closed) return 0; const h = setInterval(fn, Math.max(1, ms / FAST)); timers.add(h); return h; }, clearInterval: cancel,
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
  vm.runInContext(SRC.i18n, ctx, { filename: 'web/public/i18n.js' });
  vm.runInContext(SRC.app, ctx, { filename: 'web/public/app.js' });

  const $ = id => dom.byId.get(id);
  return {
    $, mic, spoken, now,
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
