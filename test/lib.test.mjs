import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.mjs';

// config is read once at import time, so the environment is set up first
process.env.DASHCALL_BRAIN_FILE = path.join(tempDir(), 'brain.json');
const fakeHerdr = path.join(tempDir(), 'herdr');
writeFileSync(fakeHerdr, '#!/bin/sh\nif [ "$1" = ok ]; then echo \'{"result":{"x":1}}\'; else echo \'{"error":{"code":"nope","message":"bad pane"}}\' >&2; exit 1; fi\n', { mode: 0o755 });
process.env.DASHCALL_HERDR_BIN = fakeHerdr;
const L = await import('../agent/lib.mjs');

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

test('herdr() parses JSON output and maps JSON errors', async () => {
  assert.deepEqual(await L.herdr(['ok']), { result: { x: 1 } });
  await assert.rejects(L.herdr(['fail']), e => e.message === 'bad pane' && e.code === 'nope');
});
