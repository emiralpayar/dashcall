// Atomic JSON files shared by the agent server and the dashcall CLI (two processes), with a small lock so
// concurrent read-modify-write cycles can't drop each other's updates.
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';

// A lock left by a crashed process is broken at once (its pid is gone); the age limit only covers a reused or
// unwritten pid. Giving up takes longer, or no waiter could ever break a stale lock, with room for a burst of
// writes from other processes (a waiter can lose many rounds in a row). Normal use never waits more than a few ms.
const STALE_MS = 3000, GIVE_UP_MS = 10000;
const pause = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = ms => Atomics.wait(pause, 0, 0, ms);
const warned = new Set(), held = new Set();

// {value} from the file, plus {problem} when its content is unusable. Missing or blank means the fallback; any
// other read error (EACCES, EISDIR...) throws, so it can never be mistaken for "empty" and written over.
function parse(file, fallback) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { value: fallback() }; throw e; }
  const empty = fallback();
  if (!text.trim()) return { value: empty };
  let v;
  try { v = JSON.parse(text); } catch (e) { return { value: empty, problem: e.message }; }
  // the wrong kind can't be updated either: an array brain would silently swallow every change
  if (v && typeof v === 'object' && Array.isArray(v) === Array.isArray(empty)) return { value: v };
  return { value: empty, problem: `not a JSON ${Array.isArray(empty) ? 'array' : 'object'}` };
}

// Never modifies the file: an unusable one (say, a hand-edited brain with a typo) reads as the fallback, with one
// warning until it parses again.
export function readJson(file, fallback) {
  const { value, problem } = parse(file, fallback);
  report(file, problem);
  return value;
}

function report(file, problem) {
  if (!problem) warned.delete(file);
  else if (!warned.has(file)) {
    warned.add(file);
    console.error(`warning: ignoring ${file} (${problem}); it stays as it is until the next change moves it aside`);
  }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

// The lock file holds its owner's pid. True if it was stale and is now gone.
function breakStale(lock) {
  let owner, st;
  // read before stat: should the lock be replaced in between, a newer one can only look younger, never older
  try { owner = readFileSync(lock, 'utf8'); st = statSync(lock); } catch { return false; }
  const pid = Number(owner);
  // our own pid can only be a dead earlier process's: this one never waits for a lock it holds (see `held`)
  const gone = Number.isInteger(pid) && pid > 0 && (pid === process.pid || !alive(pid));
  if (!gone && Date.now() - st.mtimeMs <= STALE_MS) return false;
  // re-read right before removing: if another waiter broke it first and took the lock, that new lock must stay
  try { if (readFileSync(lock, 'utf8') === owner) { unlinkSync(lock); return true; } } catch {}
  return false;
}

// Synchronous on purpose (callers do a tiny read-modify-write); waits only while another live process holds it.
function withLock(file, fn) {
  const lock = file + '.lock', me = String(process.pid);
  if (held.has(lock)) throw new Error(`nested update of ${file}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const giveUp = Date.now() + GIVE_UP_MS;
  for (let i = 0; ; i++) {
    try { writeFileSync(lock, me, { flag: 'wx' }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (Date.now() > giveUp) throw new Error(`timed out waiting for ${lock}`);
    if (!breakStale(lock)) sleepSync(Math.min(2 ** i, 10));
  }
  held.add(lock);
  try { return fn(); } finally {
    held.delete(lock);
    // only if it is still ours: had we stalled past STALE_MS, it may now be someone else's
    try { if (readFileSync(lock, 'utf8') === me) unlinkSync(lock); } catch {}
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    const fd = openSync(tmp, 'w');
    // flushed before the rename so a crash can't publish a half-written file (best effort: on macOS plain fsync
    // doesn't flush the drive's cache, and the folder isn't synced)
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}

// Read-modify-write under the lock; fn mutates the value and may return a result.
export function updateJson(file, fallback, fn) {
  return withLock(file, () => {
    const { value, problem } = parse(file, fallback);
    let result;
    // fn first: when it fails (an unknown id, say) nothing gets saved, so an unusable file stays where it is
    try { result = fn(value); } catch (e) { report(file, problem); throw e; }
    if (problem) {
      // never write over content we couldn't read: keep it next to the file, then save the new value
      const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(file, kept);
      console.error(`warning: ${file} was unusable (${problem}); moved it to ${kept} before saving a new one. Fix that copy and merge it back to restore its contents.`);
    }
    writeAtomic(file, JSON.stringify(value, null, 1));
    return result;
  });
}
