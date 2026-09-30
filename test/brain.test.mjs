import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.mjs';

process.env.DASHCALL_BRAIN_FILE = path.join(tempDir(), 'brain.json');
const B = await import('../agent/brain.mjs');

test('load() returns an empty brain when the file is missing', () => {
  assert.deepEqual(B.load(), { memory: [], notes: [], muted: [] });
});

test('notes can be added and marked done', () => {
  const n = B.addNote('buy milk');
  assert.equal(n.done, false);
  const d = B.noteDone(n.id);
  assert.equal(d.done, true);
  assert.ok(d.doneTs);
  assert.throws(() => B.noteDone('nope'), /no such note/);
});

test('forget removes by id or mute key and requires a key', () => {
  const m = B.remember('likes short answers');
  B.mute('some-project', 'Some project');
  assert.throws(() => B.forget(undefined), /key required/);
  assert.ok(B.load().memory.some(x => x.id === m.id), 'forget() without a key must not delete anything');
  assert.equal(B.forget(m.id).text, 'likes short answers');
  assert.equal(B.forget('some-project').label, 'Some project');
  assert.throws(() => B.forget('some-project'), /not found/);
});

test('mute is idempotent per key', () => {
  const a = B.mute('dup', 'x'), b = B.mute('dup', 'y');
  assert.equal(a.id, b.id);
  B.forget('dup');
});

test('isMuted matches session ids exactly and folders by fragment', () => {
  const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  B.mute(sid, 'one session');
  B.mute('Trader', 'a project');
  const brain = B.load();
  assert.ok(B.isMuted({ sessionId: sid, cwd: '/x' }, brain));
  assert.ok(B.isMuted({ sessionId: 'other', cwd: '/home/me/my-trader' }, brain));
  assert.equal(B.isMuted({ sessionId: 'other', cwd: `/tmp/${sid}` }, brain), null, 'session-id mutes never match a cwd');
  B.unmuteSession(sid);
  assert.equal(B.isMuted({ sessionId: sid, cwd: '/x' }), null);
  B.unmuteSession(null); // no-op
});

test('asPrompt lists open notes only', () => {
  const n = B.addNote('open one');
  const done = B.addNote('closed one'); B.noteDone(done.id);
  const p = B.asPrompt();
  assert.match(p, new RegExp(`\\[${n.id}\\].*open one`));
  assert.doesNotMatch(p, /closed one/);
});
