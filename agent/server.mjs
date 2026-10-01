// Agent: HTTP API on the Mac that runs the Claude Code sessions; the web app proxies to it (e.g. over Tailscale).
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as L from './lib.mjs';
import * as B from './brain.mjs';
import * as S from './store.mjs';
import { config, ROOT } from './config.mjs';
import { httpError, errorBody } from './errors.mjs';
import { pickLang, pickVoice } from './lang.mjs';
import * as P from './prompts.mjs';
import * as D from './dispatch.mjs';

const pexec = promisify(execFile);
const TOKEN = config.token;
if (!TOKEN) { console.error('DASHCALL_TOKEN missing (see .env.example)'); process.exit(1); }
if (TOKEN.length < 32) console.warn('warning: DASHCALL_TOKEN is shorter than 32 characters');
// launchd starts us with a minimal PATH; make sure Homebrew-installed tools are found.
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter);

const log = (...a) => console.log(new Date().toISOString(), ...a);

function authed(req) {
  const h = req.headers.authorization || '';
  const a = Buffer.from(h), b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'too_large', 'request body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function json(req) {
  const b = await body(req, 1e6);
  if (!b.length) return {};
  let d; try { d = JSON.parse(b); } catch { throw httpError(400, 'invalid_json', 'invalid JSON'); }
  return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
}
const requireText = t => { if (typeof t !== 'string' || !t.trim()) throw httpError(400, 'text_required', 'text required'); return t.trim(); };

function send(res, status, data, type = 'application/json') {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(type === 'application/json' ? JSON.stringify(data) : String(data));
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length });
  res.end(buf);
}

// ---------- dispatcher jobs ----------
const jobs = new Map(); // id -> {status, queued, reply, conversationId, error, detail, requestId, started}
const enqueue = D.conversationQueue();
if (config.dispatchUnrestricted) console.warn('warning: DASHCALL_DISPATCH_UNRESTRICTED=1: the dispatcher runs with --dangerously-skip-permissions');

// meta: { kind: 'answer' | 'task', title, q, requestId } — every finished job is stored as a notification,
// so an answer is never lost if the page was closed; the client marks it read once it has delivered it.
// Jobs of one conversation run one at a time; a job waiting its turn is 'running' with queued: true.
function runDispatcher(text, conversationId, lang, meta = {}) {
  const id = randomUUID();
  const job = { id, status: 'running', queued: true, started: Date.now(), text, lang, kind: meta.kind || 'answer', requestId: meta.requestId };
  jobs.set(id, job);
  enqueue(conversationId, (sid, done) => startDispatcher(job, sid, meta, done));
  return job;
}

// sid: the session to resume, i.e. the conversation's latest session id once the jobs ahead of this one have finished.
function startDispatcher(job, sid, meta, done) {
  const { id, text, lang } = job;
  delete job.queued;
  const args = D.dispatcherArgs({ text: L.asPositional(text), conversationId: sid, model: config.dispatchModel, systemPrompt: P.systemPrompt(lang), root: ROOT, unrestricted: config.dispatchUnrestricted });
  const env = { ...process.env, PATH: `${path.join(ROOT, 'agent/bin')}${path.delimiter}${process.env.PATH}`, DASHCALL_JOB_ID: id, DASHCALL_CONVERSATION_ID: sid || '', DASHCALL_LANGUAGE: lang };
  for (const k of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'CLAUDECODE']) delete env[k];
  let out = '', err = '', finished = false, p, kill;
  // spawn throws synchronously on e.g. a NUL byte in the text; report that as a failed job like any other
  try { p = spawn(config.bin.claude, args, { cwd: L.DISPATCHER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { err = e.message; return finish(null); }
  // decode as a stream so multi-byte characters (ş, ğ, ı…) split across chunks survive
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  kill = setTimeout(() => { p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 5000).unref(); }, 5 * 60e3);
  // e.g. ENOENT when the claude binary is missing; without this handler the whole agent would crash
  p.on('error', e => { err += e.message; finish(null); });
  p.on('close', code => finish(code));
  function finish(code) {
    if (finished) return; finished = true;
    clearTimeout(kill);
    try {
      const r = JSON.parse(out);
      job.reply = r.result; job.conversationId = r.session_id;
      job.status = r.is_error ? 'error' : 'done';
      if (r.is_error) job.error = String(r.result || r.subtype || 'error');
    } catch {
      job.status = 'error'; job.error = (err || out || `exit ${code}`).slice(-2000);
    }
    job.ms = Date.now() - job.started;
    log(job.kind === 'task' ? 'task-summary' : 'ask', job.status, job.ms + 'ms', config.logContent ? JSON.stringify(meta.q || text).slice(0, 120) : '');
    if (job.status === 'error') {
      log('dispatcher error', JSON.stringify(job.error.slice(-300)));
      // a usage limit, logged-out Claude or overload: say so in the user's language, keep Claude's words in `detail`
      const f = D.friendlyError(job.error, lang);
      if (f) { job.detail = job.error; job.error = f.text; }
    }
    // background tasks started during this job now know which conversation to report back into
    try {
      if (job.conversationId) S.update('watches', l => { for (const w of l) if (w.jobId === id && !w.conversationId) w.conversationId = job.conversationId; });
      const n = S.notify({
      jobId: id, kind: job.kind, lang, title: meta.title || null, q: meta.q ?? text,
      text: job.status === 'done' ? job.reply : job.detail ? job.error : `${FAILED[lang]}: ${String(job.error || '').slice(0, 300)}`,
      error: job.status !== 'done', detail: job.detail, conversationId: job.conversationId || sid || null,
      });
      job.notificationId = n.id;
    } catch (e) { log('state write failed', e.message); } // e.g. disk full: keep serving, the reply is still pollable
    done(job.conversationId); // the next job of this conversation resumes the session this one ended in
  }
}
const FAILED = { en: 'Something went wrong', tr: 'Bir sorun oldu' };
setInterval(() => { for (const [k, j] of jobs) if (Date.now() - j.started > 3600e3) jobs.delete(k); }, 600e3).unref();

// ---------- speech ----------
async function stt(buf, lang) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dashcall-stt-'));
  try {
    const inp = path.join(dir, 'in'), wav = path.join(dir, 'a.wav');
    await writeFile(inp, buf);
    await pexec(config.bin.ffmpeg, ['-y', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', inp, '-ar', '16000', '-ac', '1', wav], { timeout: 30000 });
    const { stdout } = await pexec(config.bin.whisper, ['-m', config.whisperModel, '-l', lang, '-nt', '-np', '-f', wav], { timeout: 60000, maxBuffer: 5e6 });
    return stdout.replace(/\s+/g, ' ').trim();
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function tts(text, lang) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dashcall-tts-'));
  try {
    const txt = path.join(dir, 't.txt'), aiff = path.join(dir, 'o.aiff'), mp3 = path.join(dir, 'o.mp3');
    await writeFile(txt, text.slice(0, 4000));
    await pexec('/usr/bin/say', ['-v', config.sayVoices[lang], '-r', '190', '-o', aiff, '-f', txt], { timeout: 60000 });
    await pexec(config.bin.ffmpeg, ['-y', '-loglevel', 'error', '-i', aiff, '-codec:a', 'libmp3lame', '-b:a', '64k', mp3], { timeout: 60000 });
    return await readFile(mp3);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// Neural voice (Microsoft Edge TTS) with word timings; falls back to local `say` without timings.
async function speak(text, voice, rate, lang) {
  text = text.slice(0, 4000);
  const v = pickVoice(lang, voice);
  if (v !== 'local') {
    try {
      const r = /^[+-]\d{1,2}%$/.test(rate || '') ? rate : '+0%';
      const py = spawn(config.bin.python, [path.join(ROOT, 'tts/speak.py'), v, r]);
      let out = '', err = '';
      py.stdout.on('data', d => out += d); py.stderr.on('data', d => err += d);
      py.stdin.on('error', () => {}); // EPIPE if python exits early; reported via the exit code
      py.stdin.end(text);
      const code = await new Promise(res => {
        const k = setTimeout(() => py.kill(), 30000);
        py.on('error', e => { clearTimeout(k); err += e.message; res(-1); }); // e.g. venv not installed
        py.on('close', c => { clearTimeout(k); res(c); });
      });
      if (code !== 0) throw new Error(err.slice(-300) || 'edge-tts exit ' + code);
      const d = JSON.parse(out);
      if (!d.audio) throw new Error('no audio');
      return { engine: 'neural', voice: v, mime: 'audio/mpeg', ...d };
    } catch (e) { log('neural tts failed, falling back to say:', e.message); }
  }
  return { engine: 'local', mime: 'audio/mpeg', audio: (await tts(text, lang)).toString('base64'), words: [] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[\w-]{1,64}$/;
// Only accept the containers browsers record (WebM, Ogg, MP4, WAV) so ffmpeg never parses playlists etc.
function isAudio(b) {
  if (b.length < 12) return false;
  return b.readUInt32BE(0) === 0x1a45dfa3 // WebM / Matroska
    || b.toString('latin1', 0, 4) === 'OggS'
    || b.toString('latin1', 4, 8) === 'ftyp' // MP4 / M4A
    || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE');
}

// ---------- routes ----------
const routes = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true })],
  ['GET', /^\/api\/sessions$/, async () => ({ sessions: (await L.listSessions()).filter(s => !L.isDispatcher(s)) })],
  ['GET', /^\/api\/recent$/, async (req, url) => ({
    sessions: (await L.recentTranscripts(Number(url.searchParams.get('hours')) || 48, 30))
      .filter(s => !L.isDispatcher(s))
      .map(s => ({ ...s, lastUser: s.lastUser && L.clip(s.lastUser.text, 500), lastAssistant: s.lastAssistant && L.clip(s.lastAssistant.text, 1500) })),
  })],
  ['GET', /^\/api\/sessions\/([\w:]+)\/screen$/, async (req, url, m) => ({ text: await L.readScreen(m[1], Number(url.searchParams.get('lines')) || 200) })],
  ['POST', /^\/api\/sessions\/([\w:]+)\/prompt$/, async (req, url, m) => {
    const { text } = await json(req);
    await L.promptSession(m[1], requireText(text)); return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w:]+)\/keys$/, async (req, url, m) => {
    const { keys } = await json(req);
    if (!Array.isArray(keys) || !keys.every(k => L.ALLOWED_KEYS.has(k))) throw httpError(400, 'bad_keys', 'bad keys');
    await L.sendKeys(m[1], keys); return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/new$/, async req => {
    const { cwd, prompt, label } = await json(req);
    if (typeof cwd !== 'string' || !cwd) throw httpError(400, 'folder_not_found', 'cwd required');
    return L.startSession(cwd, typeof prompt === 'string' ? prompt : '', typeof label === 'string' ? label : undefined);
  }],
  ['GET', /^\/api\/dirs$/, async () => ({ dirs: await L.listDirs() })],
  ['POST', /^\/api\/ask$/, async req => {
    const { text, conversationId, lang, requestId } = await json(req);
    const t = requireText(text);
    if (conversationId != null && !UUID.test(conversationId)) throw httpError(400, 'bad_conversation_id', 'bad conversationId');
    if (requestId != null && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) throw httpError(400, 'bad_request_id', 'bad requestId');
    // the client retries the POST after a network error, but the first attempt may already have started the job
    const j = (requestId && [...jobs.values()].find(x => x.requestId === requestId)) || runDispatcher(t, conversationId, pickLang(lang), { requestId });
    return { id: j.id, status: j.status, queued: j.queued };
  }],
  ['GET', /^\/api\/ask\/([\w-]+)$/, async (req, url, m) => {
    const j = jobs.get(m[1]);
    if (!j) throw httpError(404, 'unknown_job', 'unknown job');
    return { id: j.id, status: j.status, queued: j.queued, lang: j.lang, reply: j.reply, conversationId: j.conversationId, error: j.error, detail: j.detail, notificationId: j.notificationId, elapsed: Date.now() - j.started };
  }],
  ['POST', /^\/api\/speak$/, async req => { const { text, voice, rate, lang } = await json(req); return speak(String(text ?? ''), voice, rate, pickLang(lang)); }],
  ['GET', /^\/api\/notifications$/, async () => {
    const all = S.read('notifications');
    return { items: all.slice(-100).reverse(), unread: all.filter(n => !n.read).length };
  }],
  ['POST', /^\/api\/notifications\/read$/, async req => {
    const { ids } = await json(req);
    S.markRead(ids === 'all' ? 'all' : Array.isArray(ids) ? ids : []); return { ok: true };
  }],
  ['GET', /^\/api\/watches$/, async () => ({ watches: S.read('watches').filter(w => w.state === 'waiting') })],
  ['GET', /^\/api\/brain$/, async () => B.load()],
  ['POST', /^\/api\/brain\/(note|memory)$/, async (req, url, m) => {
    const { text } = await json(req);
    return m[1] === 'note' ? B.addNote(requireText(text)) : B.remember(requireText(text));
  }],
  ['POST', /^\/api\/brain\/mute$/, async req => {
    const { key, label } = await json(req);
    if (typeof key !== 'string' || !key) throw httpError(400, 'key_required', 'key required');
    return B.mute(key, typeof label === 'string' ? label : undefined);
  }],
  ['POST', /^\/api\/brain\/done\/(\w+)$/, async (req, url, m) => B.noteDone(m[1])],
  ['POST', /^\/api\/brain\/forget$/, async req => {
    const { key } = await json(req);
    if (typeof key !== 'string' || !key) throw httpError(400, 'key_required', 'key required');
    return B.forget(key);
  }],
  ['POST', /^\/api\/stt$/, async (req, url) => {
    const t0 = Date.now(), buf = await body(req), lang = pickLang(url.searchParams.get('lang'));
    if (!isAudio(buf)) throw httpError(415, 'unsupported_audio', 'unsupported audio format');
    const text = await stt(buf, lang);
    log('stt', lang, `${Date.now() - t0}ms`, `${buf.length}B`, req.headers['content-type'], config.logContent ? JSON.stringify(text) : '');
    return { text };
  }],
];

// ---------- background task watcher ----------
// A watch waits for a herdr session to finish (seen working, then idle for 2 polls), then asks the dispatcher
// to summarize the session's final answer; that summary lands in notifications within the original conversation.
let checking = false; // a slow herdr call must not let two checks fire the same watch
async function checkWatches() {
  if (checking) return;
  checking = true;
  try { await checkWatchesOnce(); } finally { checking = false; }
}
async function checkWatchesOnce() {
  const waiting = S.read('watches').filter(w => w.state === 'waiting');
  if (!waiting.length) return;
  const r = await L.herdr(['pane', 'list']).catch(() => null);
  if (!r) return;
  const panes = Object.fromEntries((r.result?.panes || []).map(p => [p.pane_id, p]));
  for (const w of waiting) {
    const p = panes[w.pane], age = Date.now() - new Date(w.created);
    const patch = {}; let fire = null;
    if (!p || p.agent !== 'claude') fire = 'closed';
    else if (p.agent_status === 'working') { patch.sawWorking = true; patch.idlePolls = 0; patch.blockedPolls = 0; }
    else if (p.agent_status === 'blocked') { patch.blockedPolls = (w.blockedPolls || 0) + 1; if (patch.blockedPolls >= 2) fire = 'blocked'; }
    else if (p.agent_status === 'idle' || p.agent_status === 'done') {
      patch.idlePolls = (w.idlePolls || 0) + 1;
      if (patch.idlePolls >= 2 && (w.sawWorking || age > 90e3)) fire = 'done';
    }
    if (!fire && age > 8 * 3600e3) fire = 'timeout';
    if (fire) { patch.state = 'fired'; patch.fired = new Date().toISOString(); patch.reason = fire; }
    // re-check under the lock: the watch may have been cancelled (dashcall unwatch) since we read it
    const still = S.update('watches', l => { const x = l.find(y => y.id === w.id); if (x?.state !== 'waiting') return false; Object.assign(x, patch); return true; });
    if (!fire || !still) continue;
    const sid = p?.agent_session?.value || w.sessionId;
    const t = sid ? await L.transcriptSummary(sid).catch(() => null) : null;
    const last = L.clip(t?.lastAssistant?.text || '(could not read a reply from the session)', 8000);
    log('watch fired', w.id, fire, w.label);
    const lang = pickLang(w.lang);
    runDispatcher(P.watchPrompt(w, fire, last, lang), w.conversationId || null, lang, { kind: 'task', title: w.label, q: w.label });
  }
}
setInterval(() => checkWatches().catch(e => log('watch error', e.message)), 10000);

const server = http.createServer(async (req, res) => {
  let url;
  try {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized', code: 'unauthorized' });
    // inside the try: a malformed request line must not crash the server
    try { url = new URL(req.url, 'http://x'); } catch { throw httpError(400, 'bad_path', 'bad path'); }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'bad_path', 'bad path'); }
    for (const [method, re, fn] of routes) {
      const m = pathname.match(re);
      if (m && req.method === method) return send(res, 200, await fn(req, url, m));
    }
    throw httpError(404, 'not_found', 'not found');
  } catch (e) {
    log('error', req.method, url?.pathname ?? req.url, e.message);
    const [status, data] = errorBody(e);
    if (!res.headersSent) send(res, status, data); else res.destroy();
  }
});
process.on('unhandledRejection', e => log('unhandled rejection', e?.message || e)); // keep serving
server.on('error', e => { console.error(`cannot listen on ${config.bind}:${config.port}: ${e.message}`); process.exit(1); });
server.listen(config.port, config.bind, () => log(`dashcall agent on ${config.bind}:${server.address().port}`));
