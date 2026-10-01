import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
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

test('isMuted matches session ids exactly and folders by whole path segments', () => {
  const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  B.mute(sid, 'one session');
  B.mute('Trader', 'a project');
  const brain = B.load();
  assert.equal(B.isMuted({ sessionId: sid, cwd: '/x' }, brain).key, sid);
  assert.equal(B.isMuted({ sessionId: 'other', cwd: '/home/me/trader' }, brain).key, 'Trader', 'case-insensitive');
  assert.ok(B.isMuted({ sessionId: 'other', cwd: '/home/me/TRADER/sub/dir' }, brain), 'folders inside the muted one too');
  assert.equal(B.isMuted({ sessionId: 'other', cwd: '/home/me/my-trader' }, brain), null, 'not a substring match');
  assert.equal(B.isMuted({ sessionId: 'other', cwd: `/tmp/${sid}` }, brain), null, 'session-id mutes never match a cwd');
  B.unmuteSession(sid);
  assert.equal(B.isMuted({ sessionId: sid, cwd: '/x' }), null);
  B.unmuteSession(null); // no-op
  B.forget('Trader');
});

test('folder mutes never match parts of a folder name', () => {
  const brain = { muted: [{ key: 'api' }, { key: 'side-quest-app' }] };
  const by = cwd => B.isMuted({ sessionId: 'x', cwd }, brain)?.key ?? null;
  for (const cwd of ['/Users/you/rapid-x', '/Users/you/capital', '/Users/you/api-server', '/Users/you/my-api', '/Users/you/apis']) assert.equal(by(cwd), null, cwd);
  for (const cwd of ['/Users/you/api', '/Users/you/code/API', '/Users/you/api/src', '/Users/you/api/']) assert.equal(by(cwd), 'api', cwd);
  assert.equal(by('/Users/you/side-quest-app'), 'side-quest-app', 'existing folder-name keys keep working');
  assert.equal(by('/Users/you/side-quest'), null);
  assert.equal(B.isMuted({ sessionId: 'x' }, brain), null, 'no cwd, no folder match');
});

test('folder mutes can be multi-segment names or paths', () => {
  const home = homedir();
  const brain = { muted: [{ key: 'code/web' }, { key: '/srv/apps/shop/' }, { key: '~/notes' }] };
  const by = cwd => B.isMuted({ sessionId: 'x', cwd }, brain)?.key ?? null;
  assert.equal(by('/Users/you/code/web/client'), 'code/web');
  assert.equal(by('/Users/you/mycode/web'), null);
  assert.equal(by('/Users/you/code/webapp'), null);
  assert.equal(by('/srv/apps/shop'), '/srv/apps/shop/');
  assert.equal(by('/srv/apps/shop/backend'), '/srv/apps/shop/');
  assert.equal(by('/srv/apps/shop-v2'), null, 'a path matches that folder and its subfolders only');
  assert.equal(by('/backup/srv/apps/shop'), null, 'a path is anchored at the root');
  assert.equal(by(path.join(home, 'notes', 'daily')), '~/notes', '~ is the home folder');
  assert.equal(by('/elsewhere/notes'), null);
});

test('isMuted prefers a session-id mute and ignores malformed entries', () => {
  const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const brain = { muted: [{ key: 'api' }, { label: 'no key' }, null, { key: sid }] };
  assert.equal(B.isMuted({ sessionId: sid, cwd: '/Users/you/api' }, brain).key, sid);
  assert.equal(B.isMuted({ cwd: '/Users/you/other' }, brain), null);
});

test('mute and forget treat equivalent folder keys as the same mute', () => {
  const m = B.mute('My-Api', 'x');
  assert.equal(B.mute('my-api/').id, m.id);
  assert.equal(B.forget('MY-API').id, m.id);
  assert.throws(() => B.forget('my-api'), /not found/);
});

test('unmuteSession leaves the brain file alone when there is nothing to remove', () => {
  B.mute('keep-me');
  const before = statSync(process.env.DASHCALL_BRAIN_FILE).ino; // every write renames a new file into place
  B.unmuteSession('0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.equal(statSync(process.env.DASHCALL_BRAIN_FILE).ino, before);
  B.forget('keep-me');
});

test('asPrompt lists open notes only', () => {
  const n = B.addNote('open one');
  const done = B.addNote('closed one'); B.noteDone(done.id);
  const p = B.asPrompt();
  assert.match(p, new RegExp(`\\[${n.id}\\].*open one`));
  assert.doesNotMatch(p, /closed one/);
});
