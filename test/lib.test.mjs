import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.mjs';

// config is read once at import time, so the environment is set up first
process.env.DASHCALL_BRAIN_FILE = path.join(tempDir(), 'brain.json');
const fakeHerdr = path.join(tempDir(), 'herdr');
writeFileSync(fakeHerdr, '#!/bin/sh\nif [ "$1" = ok ]; then echo \'{"result":{"x":1}}\'; else echo \'{"error":{"code":"nope","message":"bad pane"}}\' >&2; exit 1; fi\n', { mode: 0o755 });
process.env.DASHCALL_HERDR_BIN = fakeHerdr;
// a fake home: it is the workspace root and holds ~/.claude/projects, so no real transcript is ever read
const home = tempDir();
process.env.HOME = home;
const L = await import('../agent/lib.mjs');
const B = await import('../agent/brain.mjs');

const PROJECTS = path.join(home, '.claude/projects');
const jsonl = entries => entries.map(e => JSON.stringify(e) + '\n').join('');
function transcript(dir, sid, entries) {
  mkdirSync(path.join(PROJECTS, dir), { recursive: true });
  const f = path.join(PROJECTS, dir, `${sid}.jsonl`);
  writeFileSync(f, jsonl(entries));
  return f;
}
const chat = (q, a, cwd = '/Users/you/proj') => [
  { type: 'user', cwd, message: { content: q }, timestamp: '2026-01-01T00:00:01Z' },
  { type: 'assistant', cwd, message: { content: [{ type: 'text', text: a }] }, timestamp: '2026-01-01T00:00:02Z' },
];

test('clip() shortens long text only', () => {
  assert.equal(L.clip(null, 3), null);
  assert.equal(L.clip('abc', 3), 'abc');
  assert.equal(L.clip('abcd', 3), 'abc…');
});

test('asPositional() keeps option-like text from being parsed as a flag', () => {
  assert.equal(L.asPositional('--help'), ' --help');
  assert.equal(L.asPositional('hello'), 'hello');
});

test('isDispatcher() matches the dispatcher folder, not look-alikes', () => {
  assert.ok(L.isDispatcher({ cwd: L.DISPATCHER_DIR }));
  assert.ok(L.isDispatcher({ cwd: path.join(L.DISPATCHER_DIR, 'sub') }));
  assert.ok(!L.isDispatcher({ cwd: L.DISPATCHER_DIR + '-other' }));
  assert.ok(!L.isDispatcher({}));
});

test('startSession() refuses folders outside WORKSPACE_ROOT', async () => {
  await assert.rejects(L.startSession('/', 'hi'), e => e.code === 'folder_outside_root' && e.status === 400 && /must be inside/.test(e.message));
  await assert.rejects(L.startSession('/nonexistent/folder', 'hi'), e => e.code === 'folder_not_found');
});

test('startSession() allows a folder named "..foo" but not the root\'s parent or a symlink out of the root', async () => {
  mkdirSync(path.join(home, '..foo'));
  // passing the folder check means herdr is called next, and the fake herdr fails with "bad pane"
  await assert.rejects(L.startSession(path.join(home, '..foo'), 'hi'), e => e.message === 'bad pane');
  await assert.rejects(L.startSession('~/..foo', 'hi'), e => e.message === 'bad pane');
  await assert.rejects(L.startSession(home, 'hi'), e => e.message === 'bad pane', 'the root itself');
  await assert.rejects(L.startSession(path.dirname(home), 'hi'), e => e.code === 'folder_outside_root');
  await assert.rejects(L.startSession(path.join(home, '..'), 'hi'), e => e.code === 'folder_outside_root');
  symlinkSync(tempDir(), path.join(home, 'link-out'));
  await assert.rejects(L.startSession('~/link-out', 'hi'), e => e.code === 'folder_outside_root');
});

test('transcriptSummary() skips noise, sidechains and meta messages', async () => {
  const file = path.join(tempDir(), 's.jsonl');
  const lines = [
    { type: 'ai-title', aiTitle: 'Fix the bug', timestamp: '2026-01-01T00:00:00Z' },
    { type: 'user', cwd: '/proj', message: { content: 'real question' }, timestamp: '2026-01-01T00:00:01Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'real answer' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: '<system-reminder>ignore</system-reminder>' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
  ];
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n');
  const s = await L.transcriptSummary('sid', file);
  assert.equal(s.title, 'Fix the bug');
  assert.equal(s.cwd, '/proj');
  assert.equal(s.lastUser.text, 'real question');
  assert.equal(s.lastAssistant.text, 'real answer');
});

test('transcriptSummary() is cached until the file changes (mtime or size)', async () => {
  const f = transcript('-cache', 'sid-cache', chat('q1', 'a1'));
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(f, old, old);
  const a = await L.transcriptSummary('sid-cache');
  assert.equal(a.lastAssistant.text, 'a1');
  assert.equal(await L.transcriptSummary('sid-cache'), a, 'an unchanged file is not read again');
  writeFileSync(f, jsonl(chat('q2', 'a22')));
  utimesSync(f, old, old); // same mtime, different size
  assert.equal((await L.transcriptSummary('sid-cache')).lastAssistant.text, 'a22');
  appendFileSync(f, jsonl(chat('q3', 'a3')));
  const c = await L.transcriptSummary('sid-cache');
  assert.equal(c.lastUser.text, 'q3');
  assert.notEqual(c.mtime, old.toISOString());
});

test('transcriptSummary() finds a transcript again after it moves, and returns null once it is gone', async () => {
  const f = transcript('-first', 'sid-move', chat('q', 'before'));
  assert.equal((await L.transcriptSummary('sid-move')).lastAssistant.text, 'before');
  mkdirSync(path.join(PROJECTS, '-second'));
  const moved = path.join(PROJECTS, '-second', 'sid-move.jsonl');
  renameSync(f, moved);
  appendFileSync(moved, jsonl(chat('q', 'after')));
  assert.equal((await L.transcriptSummary('sid-move')).lastAssistant.text, 'after');
  rmSync(moved);
  assert.equal(await L.transcriptSummary('sid-move'), null);
  assert.equal(await L.transcriptSummary('sid-never-existed'), null);
});

test('transcriptSummary() keeps the title once it scrolls out of the 400 KB tail', async () => {
  const f = transcript('-long', 'sid-long', [{ type: 'ai-title', aiTitle: 'Long job' }, ...chat('q', 'a')]);
  assert.equal((await L.transcriptSummary('sid-long')).title, 'Long job');
  const filler = { type: 'progress', data: 'x'.repeat(10_000) };
  appendFileSync(f, jsonl(Array(50).fill(filler)) + jsonl(chat('q2', 'a2')));
  const s = await L.transcriptSummary('sid-long');
  assert.equal(s.lastAssistant.text, 'a2');
  assert.equal(s.title, 'Long job');
});

test('recentTranscripts() lists recent sessions newest first, with muted and mutedBy', async () => {
  const sids = ['0f8fad5b-d9cb-469f-a165-70867728950e', '1f8fad5b-d9cb-469f-a165-70867728950e', '2f8fad5b-d9cb-469f-a165-70867728950e'];
  transcript('-r-api', sids[0], chat('q', 'a', '/Users/you/api'));
  transcript('-r-rapid', sids[1], chat('q', 'a', '/Users/you/rapid-x'));
  transcript('-r-one', sids[2], chat('q', 'a', '/Users/you/one'));
  const t0 = Date.now() / 1000 + 60; // newer than any transcript the other tests wrote
  const touch = (dir, sid, t) => utimesSync(path.join(PROJECTS, dir, `${sid}.jsonl`), t, t);
  ['-r-api', '-r-rapid', '-r-one'].forEach((dir, i) => touch(dir, sids[i], t0 - i));
  transcript('-r-old', 'sid-old', chat('q', 'a'));
  touch('-r-old', 'sid-old', t0 - 3 * 86400);
  transcript('-r-empty', 'sid-empty', [{ type: 'ai-title', aiTitle: 'nothing said yet' }]);
  touch('-r-empty', 'sid-empty', t0 + 10);
  B.mute('api'); B.mute(sids[2]);
  try {
    const r = await L.recentTranscripts(48, 10);
    assert.deepEqual(r.slice(0, 3).map(s => s.sessionId), sids, 'newest first');
    assert.deepEqual(r.slice(0, 3).map(s => [s.muted, s.mutedBy]), [[true, 'api'], [false, null], [true, sids[2]]]);
    assert.ok(!r.some(s => s.sessionId === 'sid-old'), 'older than `hours`');
    assert.ok(!r.some(s => s.sessionId === 'sid-empty'), 'no prompt or reply yet');
  } finally { B.forget('api'); B.forget(sids[2]); }
});

test('herdr() parses JSON output and maps JSON errors', async () => {
  assert.deepEqual(await L.herdr(['ok']), { result: { x: 1 } });
  await assert.rejects(L.herdr(['fail']), e => e.message === 'bad pane' && e.code === 'nope');
});
