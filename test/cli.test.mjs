// The dashcall CLI (used by the dispatcher): help output and storing the watch language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.mjs';

const CLI = 'agent/bin/dashcall';
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('no arguments or help prints usage', () => {
  for (const args of [[], ['help'], ['--help']]) {
    const r = run(args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: dashcall <command>/);
  }
});

test('an unknown command prints usage and fails', () => {
  const r = run(['bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command: bogus[\s\S]*Usage:/);
});

test('watch stores the language the user is speaking', () => {
  const dir = tempDir(), herdr = path.join(dir, 'herdr');
  writeFileSync(herdr, `#!/bin/sh\necho '{"result":{"pane":{"agent":"claude","agent_status":"working","cwd":"/proj","agent_session":{"value":"s1"}}}}'\n`, { mode: 0o755 });
  const env = { DASHCALL_HERDR_BIN: herdr, DASHCALL_STATE_DIR: dir, DASHCALL_BRAIN_FILE: path.join(dir, 'brain.json'), DASHCALL_JOB_ID: 'j1' };
  assert.equal(run(['watch', 'p1', 'Run', 'tests'], { ...env, DASHCALL_LANGUAGE: 'tr' }).status, 0);
  assert.equal(run(['watch', 'p2'], { ...env, DASHCALL_LANGUAGE: '' }).status, 0);
  const [a, b] = JSON.parse(readFileSync(path.join(dir, 'watches.json'), 'utf8'));
  assert.deepEqual([a.label, a.lang, a.sawWorking, a.sessionId, a.jobId], ['Run tests', 'tr', true, 's1', 'j1']);
  assert.equal(b.lang, null);
});
