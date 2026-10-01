// Shared helpers: herdr control + Claude transcript reading.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as brain from './brain.mjs';
import { config, ROOT, HOME } from './config.mjs';
import { httpError } from './errors.mjs';

const pexec = promisify(execFile);
export { ROOT, HOME };
export const HERDR = config.bin.herdr;
const PROJECTS = path.join(HOME, '.claude/projects');
// The dispatcher's own headless sessions run here; they are hidden from session lists.
export const DISPATCHER_DIR = path.join(ROOT, 'dispatcher');
export const isDispatcher = s => !!s?.cwd && (s.cwd === DISPATCHER_DIR || s.cwd.startsWith(DISPATCHER_DIR + path.sep));
export const SESSION_COMMAND = config.sessionCommand;
export const WORKSPACE_ROOT = config.workspaceRoot;

// Run herdr outside of any pane context so it never targets "current" pane implicitly.
export async function herdr(args, { timeout = 30000 } = {}) {
  const env = { ...process.env };
  for (const k of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']) delete env[k];
  try {
    const { stdout } = await pexec(HERDR, args, { env, timeout, maxBuffer: 20 * 1024 * 1024 });
    const out = stdout.trim();
    try { return JSON.parse(out); } catch { return out; }
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim();
    let parsed; try { parsed = JSON.parse(msg); } catch {}
    const err = new Error(parsed?.error?.message || msg || 'herdr failed');
    err.code = parsed?.error?.code;
    throw err;
  }
}

// ---------- transcripts ----------
// The Sessions tab polls every 15 s, so lookups and summaries are cached; both maps drop their oldest entry when full.
const CACHE_MAX = 200;
const fileCache = new Map(); // sessionId -> transcript path
const summaries = new Map(); // transcript path -> { mtimeMs, size, summary }
const cachePut = (map, k, v) => { map.delete(k); map.set(k, v); if (map.size > CACHE_MAX) map.delete(map.keys().next().value); };
const statOrNull = f => stat(f).catch(e => { if (e.code === 'ENOENT') return null; throw e; });

async function findTranscript(sessionId) {
  if (fileCache.has(sessionId)) return fileCache.get(sessionId);
  const dirs = await readdir(PROJECTS).catch(() => []);
  for (const d of dirs) {
    const p = path.join(PROJECTS, d, `${sessionId}.jsonl`);
    try { await stat(p); cachePut(fileCache, sessionId, p); return p; } catch {}
  }
  return null;
}

async function readTail(file, bytes = 400_000) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally { await fh.close(); }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

const isNoise = t => !t || /^<(command|local-command|system-reminder|task-notification)/.test(t.trim()) || t.startsWith('[Request interrupted');

// Summarize a transcript: title, last user prompt, last assistant text, timestamps.
export async function transcriptSummary(sessionId, file) {
  let st;
  if (file) st = await statOrNull(file);
  else {
    file = await findTranscript(sessionId);
    st = file && await statOrNull(file);
    // the cached path is gone (transcript deleted or moved): forget it and search once more
    if (file && !st) { fileCache.delete(sessionId); summaries.delete(file); file = await findTranscript(sessionId); st = file && await statOrNull(file); }
  }
  return st ? summarize(sessionId, file, st) : null;
}

// st is stat()ed before reading: if the file grows meanwhile, the next call sees a newer mtime or size and reads
// again, so a cached summary is never older than the (mtimeMs, size) it is stored under.
async function summarize(sessionId, file, st) {
  const prev = summaries.get(file);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) { cachePut(summaries, file, prev); return prev.summary; }
  const lines = await readTail(file);
  let title = null, lastUser = null, lastAssistant = null, lastTs = null, cwd = null;
  for (const l of lines) {
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.type === 'ai-title' && d.title) title = d.title;
    if (d.cwd) cwd = d.cwd;
    if (d.timestamp) lastTs = d.timestamp;
    if (d.isSidechain) continue;
    if (d.type === 'user' && d.message) {
      const t = textOf(d.message.content);
      if (!isNoise(t) && !d.isMeta) lastUser = { text: t, ts: d.timestamp };
    }
    if (d.type === 'assistant' && d.message) {
      const t = textOf(d.message.content);
      if (t.trim()) lastAssistant = { text: t, ts: d.timestamp };
    }
  }
  // Only the last 400 KB is read, so the title (or cwd) of a long transcript can scroll out of that window.
  // Transcripts only grow: keep what an earlier read of the same file found.
  if (prev && st.size >= prev.size) { title ??= prev.summary.title; cwd ??= prev.summary.cwd; }
  const summary = { sessionId, title, cwd, lastUser, lastAssistant, lastTs, mtime: st.mtime.toISOString() };
  cachePut(summaries, file, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}

// Sessions whose transcripts changed within `hours` (includes ones no longer running).
export async function recentTranscripts(hours = 48, limit = 20) {
  const since = Date.now() - hours * 3600e3;
  const dirs = await readdir(PROJECTS).catch(() => []);
  const found = (await Promise.all(dirs.map(async d => {
    const dir = path.join(PROJECTS, d);
    const files = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.jsonl'));
    return Promise.all(files.map(async f => {
      const p = path.join(dir, f), st = await stat(p).catch(() => null);
      return st?.mtimeMs > since ? { p, st, id: f.slice(0, -6) } : null;
    }));
  }))).flat().filter(Boolean).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit);
  const b = brain.load();
  const res = await Promise.all(found.map(async o => {
    cachePut(fileCache, o.id, o.p);
    const s = await summarize(o.id, o.p, o.st).catch(() => null);
    return s && (s.lastUser || s.lastAssistant) ? { ...s, ...mutedFields(brain.isMuted(s, b)) } : null;
  }));
  return res.filter(Boolean);
}

// ---------- sessions ----------
export async function listSessions() {
  const r = await herdr(['agent', 'list']);
  const agents = r?.result?.agents || [];
  const ws = await herdr(['workspace', 'list']).catch(() => null);
  const labels = Object.fromEntries((ws?.result?.workspaces || []).map(w => [w.workspace_id, w.label]));
  const b = brain.load();
  return Promise.all(agents.map(async a => {
    const sid = a.agent_session?.value || null;
    const t = sid ? await transcriptSummary(sid).catch(() => null) : null;
    return {
      pane: a.pane_id,
      name: a.name || null,
      agent: a.agent,
      status: a.agent_status,
      cwd: a.foreground_cwd || a.cwd,
      workspace: labels[a.workspace_id] || a.workspace_id,
      title: a.terminal_title_stripped || t?.title || null,
      sessionId: sid,
      lastUser: t?.lastUser ? clip(t.lastUser.text, 600) : null,
      lastAssistant: t?.lastAssistant ? clip(t.lastAssistant.text, 1500) : null,
      lastTs: t?.lastTs || null,
      ...mutedFields(brain.isMuted({ sessionId: sid, cwd: a.foreground_cwd || a.cwd }, b)),
    };
  }));
}

// mutedBy is the key of the matching mute (a session id or a folder): forgetting that key unmutes the session.
const mutedFields = m => ({ muted: !!m, mutedBy: m?.key ?? null });

export const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);

export async function readScreen(pane, lines = 150) {
  // While an agent is working its alternate-screen history can't be scrolled; fall back to the visible screen.
  const r = await herdr(['agent', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)])
    .catch(() => herdr(['agent', 'read', pane, '--source', 'visible']));
  return typeof r === 'string' ? r : (r?.result?.read?.text ?? r?.result?.text ?? JSON.stringify(r));
}

// A leading space keeps text that starts with "-" from being parsed as a CLI option.
export const asPositional = t => (String(t).startsWith('-') ? ' ' + t : String(t));

export async function promptSession(pane, text) {
  const r = await herdr(['agent', 'prompt', pane, asPositional(text)], { timeout: 20000 });
  // talking to a muted session again means the user cares about it again
  const p = await herdr(['pane', 'get', pane]).catch(() => null);
  brain.unmuteSession(p?.result?.pane?.agent_session?.value);
  return r;
}

// Keys a remote user may send to a session: enough to interrupt, confirm and pick menu options.
export const ALLOWED_KEYS = new Set(['esc', 'enter', 'ctrl+c', 'up', 'down', 'tab', 'shift+tab', '1', '2', '3']);

export async function sendKeys(pane, keys) {
  return herdr(['agent', 'send-keys', pane, ...keys], { timeout: 10000 });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const expandHome = p => String(p).replace(/^~(?=$|\/)/, HOME);

// New job: fresh herdr workspace in cwd → type SESSION_COMMAND into its shell → wait for agent → prompt.
export async function startSession(cwd, prompt, label) {
  cwd = path.resolve(expandHome(cwd));
  const st = await stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw httpError(400, 'folder_not_found', `Folder not found: ${cwd}`);
  // compare real paths so a symlink inside the root can't point outside it
  const real = await realpath(cwd);
  // "..foo" is an ordinary folder name: only ".." itself or a "../" prefix leaves the root
  const inside = async root => { const rel = path.relative(await realpath(root).catch(() => root), real); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  // the repo's research/ folder (used by the dispatcher for background research) is always allowed
  if (!(await inside(WORKSPACE_ROOT)) && !(await inside(path.join(ROOT, 'research')))) throw httpError(400, 'folder_outside_root', `Folder must be inside ${WORKSPACE_ROOT}: ${cwd}`);
  const args = ['workspace', 'create', '--cwd', cwd, '--no-focus'];
  if (label) args.push('--label', label);
  const w = await herdr(args);
  const pane = w?.result?.root_pane?.pane_id;
  if (!pane) throw httpError(500, 'session_start_failed', 'herdr workspace create returned no pane: ' + JSON.stringify(w).slice(0, 200));
  await sleep(1200); // let zsh finish loading its rc before typing
  await herdr(['pane', 'run', pane, SESSION_COMMAND]);
  // wait for herdr to detect claude in the pane and become ready
  let ready = false, trusted = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(1000);
    const p = await herdr(['pane', 'get', pane]).catch(() => null);
    const s = p?.result?.pane;
    if (s?.agent === 'claude' && (s.agent_status === 'idle' || s.agent_status === 'done')) { ready = true; break; }
    // First run in a new folder shows "trust this folder?" whose default is "No, exit": pick option 2 explicitly.
    const screen = await herdr(['pane', 'read', pane, '--source', 'visible']).catch(() => '');
    if (!trusted && /Yes, I trust this folder/.test(String(screen))) {
      await herdr(['pane', 'send-keys', pane, 'down']);
      await sleep(200);
      await herdr(['pane', 'send-keys', pane, 'enter']);
      trusted = true;
    }
  }
  if (!ready) throw httpError(500, 'session_start_failed', `${SESSION_COMMAND} did not start within 60 s (pane ${pane})`);
  if (prompt) await promptSession(pane, prompt);
  return { pane, cwd };
}

// Project folders under WORKSPACE_ROOT (the only place new sessions may start), newest first. A folder that holds
// only folders (e.g. ~/development) is a container: its subfolders are listed too, as "development/agent-arena".
export async function listDirs() {
  const skip = new Set(['Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public']);
  const visible = e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && !e.name.endsWith('.app');
  const ents = await readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const found = [];
  await Promise.all(ents.filter(e => visible(e) && !skip.has(e.name)).map(async e => {
    found.push(e.name);
    const inner = await readdir(path.join(WORKSPACE_ROOT, e.name), { withFileTypes: true }).catch(() => []);
    const shown = inner.filter(x => !x.name.startsWith('.'));
    if (shown.length && shown.every(x => x.isDirectory())) for (const x of shown.filter(visible)) found.push(path.join(e.name, x.name));
  }));
  const withTime = await Promise.all(found.map(async name => {
    const p = path.join(WORKSPACE_ROOT, name);
    const s = await stat(p);
    return { name, path: p, mtime: s.mtimeMs };
  }));
  return withTime.sort((a, b) => b.mtime - a.mtime);
}
