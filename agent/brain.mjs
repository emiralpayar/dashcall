// Persistent "brain" for the dispatcher: long-term memory, notes, muted sessions/projects.
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
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
    const i = b[k].findIndex(x => x.id === key || (k === 'muted' && x.key === key));
    if (i >= 0) { hit = b[k].splice(i, 1)[0]; break; }
  }
  if (!hit) throw httpError(404, 'not_found', 'not found: ' + key);
  return hit;
});

// key: a Claude session id (exact) or a folder path/name fragment (matches cwd).
export const mute = (key, label, reason) => mutate(b => {
  const existing = b.muted.find(m => m.key === key);
  if (existing) return existing;
  const m = { id: id(), key, label: label || key, reason: reason || '', ts: now() };
  b.muted.push(m); return m;
});

export function isMuted(s, brain = load()) {
  return brain.muted.find(m => m.key === s.sessionId || (s.cwd && !/^[0-9a-f-]{36}$/.test(m.key) && s.cwd.toLowerCase().includes(m.key.toLowerCase()))) || null;
}

// Unmute session-id mutes for a session (called when the user talks to it again).
export const unmuteSession = sessionId => sessionId && mutate(b => { b.muted = b.muted.filter(m => m.key !== sessionId); });

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
