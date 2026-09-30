// Atomic JSON files shared by the agent server and the dashcall CLI (two processes), with a small lock so
// concurrent read-modify-write cycles can't drop each other's updates.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';

const pause = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = ms => Atomics.wait(pause, 0, 0, ms);

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback(); }
}

function withLock(file, fn) {
  const lock = file + '.lock';
  mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // a lock older than 5s belongs to a process that died mid-write
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock); } catch {}
      if (i > 200) throw new Error(`timed out waiting for ${lock}`);
      sleepSync(10);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

// Read-modify-write under the lock; fn mutates the value and may return a result.
export function updateJson(file, fallback, fn) {
  return withLock(file, () => {
    const value = readJson(file, fallback);
    const result = fn(value);
    const tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, file);
    return result;
  });
}
