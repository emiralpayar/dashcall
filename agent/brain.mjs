// Persistent "brain" for the dispatcher: long-term memory, notes, muted sessions/projects.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config, HOME } from './config.mjs';
import { readJson, updateJson } from './jsonfile.mjs';
import { httpError } from './errors.mjs';

const FILE = config.brainFile;

const empty = () => ({ memory: [], notes: [], muted: [] });
export const load = () => ({ ...empty(), ...readJson(FILE, empty) });
const id = () => randomBytes(3).toString('hex');
const now = () => new Date().toISOString();
// Read-modify-write (locked, shared with the CLI).
const mutate = fn => updateJson(FILE, empty, b => { Object.assign(b, { ...empty(), ...b }); return fn(b); });

export const remember = text => mutate(b => { const m = { id: id(), text, ts: now() }; b.memory.push(m); return m; });
export const addNote = text => mutate(b => { const n = { id: id(), text, ts: now(), done: false }; b.notes.push(n); return n; });
export const noteDone = nid => mutate(b => { const n = b.notes.find(x => x.id === nid); if (!n) throw httpError(404, 'not_found', 'no such note'); n.done = true; n.doneTs = now(); return n; });

// Remove any item (memory, note or mute) by id or mute key.
export const forget = key => mutate(b => {
  if (!key) throw httpError(400, 'key_required', 'key required');
  let hit = null;
  for (const k of ['memory', 'notes', 'muted']) {
    const i = b[k].findIndex(x => x.id === key || (k === 'muted' && sameKey(x.key, key)));
    if (i >= 0) { hit = b[k].splice(i, 1)[0]; break; }
  }
  if (!hit) throw httpError(404, 'not_found', 'not found: ' + key);
  return hit;
});

// key: a Claude session id (exact), a folder name ("my-api", "code/my-api") or a folder path ("~/code/my-api").
export const mute = (key, label, reason) => mutate(b => {
  const existing = b.muted.find(m => sameKey(m.key, key));
  if (existing) return existing;
  const m = { id: id(), key, label: label || key, reason: reason || '', ts: now() };
  b.muted.push(m); return m;
});

const isSessionId = k => /^[0-9a-f-]{36}$/.test(k);
// Folder keys compare case-insensitively (like the macOS file system), without a trailing slash; ~ is the home folder.
const folderKey = k => {
  const n = path.posix.normalize(String(k).trim().replace(/^~(?=$|\/)/, HOME));
  return (n.length > 1 ? n.replace(/\/$/, '') : n).toLowerCase();
};
const sameKey = (a, b) => a === b || (typeof a === 'string' && !isSessionId(a) && !isSessionId(b) && folderKey(a) === folderKey(b));
// Whole path segments only, never substrings ("api" must not mute ~/rapid-x or ~/capital): a path key matches that
// folder and everything inside it; a name key matches where it appears as complete segments of the cwd.
function folderMatches(key, cwd) {
  const k = folderKey(key), c = folderKey(cwd);
  if (k.startsWith('/')) return c === k || c.startsWith(k === '/' ? k : k + '/');
  return k !== '.' && `/${c}/`.includes(`/${k}/`);
}

// The mute that silences session s ({sessionId, cwd}) or null. A session-id mute wins over a folder mute, so
// unmuting a session from the app removes the mute the app itself created first.
export function isMuted(s, brain = load()) {
  const keyed = brain.muted.filter(m => typeof m?.key === 'string' && m.key);
  return (s.sessionId && keyed.find(m => m.key === s.sessionId))
    || (s.cwd && keyed.find(m => !isSessionId(m.key) && folderMatches(m.key, s.cwd)))
    || null;
}

// Unmute session-id mutes for a session (called when the user talks to it again). Checked first so that every
// prompt doesn't rewrite the brain file.
export const unmuteSession = sessionId => sessionId && load().muted.some(m => m.key === sessionId)
  && mutate(b => { b.muted = b.muted.filter(m => m.key !== sessionId); });

// Compact text injected into the dispatcher's system prompt each turn.
export function asPrompt() {
  const b = load();
  const open = b.notes.filter(n => !n.done);
  const lines = ['# Your brain (persistent, managed with the `dashcall` CLI)'];
  lines.push('## Memory', ...(b.memory.length ? b.memory.map(m => `- [${m.id}] ${m.text}`) : ['(empty)']));
  lines.push('## Open notes', ...(open.length ? open.map(n => `- [${n.id}] (${n.ts.slice(0, 10)}) ${n.text}`) : ['(none)']));
  lines.push('## Muted (never mention unless the user asks about them explicitly)', ...(b.muted.length ? b.muted.map(m => `- [${m.key}] ${m.label}${m.reason ? ' — ' + m.reason : ''}`) : ['(none)']));
  return lines.join('\n');
}
