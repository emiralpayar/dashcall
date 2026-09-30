// Shared JSON state (notifications + watches), written by both the agent server and the dashcall CLI.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from './config.mjs';
import { readJson, updateJson } from './jsonfile.mjs';

const DIR = config.stateDir;
const file = name => path.join(DIR, name + '.json');

const list = () => [];
export const read = name => readJson(file(name), list);
// Read-modify-write (locked); fn mutates the list and may return a value.
export const update = (name, fn) => updateJson(file(name), list, fn);
export const newId = () => randomBytes(5).toString('hex');

// ---------- notifications ----------
export function notify(n) {
  return update('notifications', l => {
    const rec = { id: newId(), ts: new Date().toISOString(), read: false, ...n };
    l.push(rec);
    if (l.length > 200) l.splice(0, l.length - 200);
    return rec;
  });
}
export const markRead = ids => update('notifications', l => { for (const n of l) if (ids === 'all' || ids.includes(n.id)) n.read = true; });

// ---------- watches (background tasks the dispatcher is waiting on) ----------
export function addWatch(w) {
  return update('watches', l => {
    const rec = { id: newId(), created: new Date().toISOString(), state: 'waiting', sawWorking: false, idlePolls: 0, ...w };
    l.push(rec); return rec;
  });
}
