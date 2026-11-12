// agent/pull.mjs refuses to start without its settings. The polling loop itself needs herdr and a web app, so it is
// verified live; here we only check the guard clauses, which are what a misconfigured machine hits first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function run(env) {
  const p = spawn(process.execPath, ['agent/pull.mjs'], { env: { ...process.env, DASHCALL_HERDR_BIN: '/nonexistent/herdr', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  return new Promise(resolve => p.on('exit', code => resolve({ code, err })));
}
const OK = { DASHCALL_PULL_URL: 'https://pilot.example.com', DASHCALL_PULL_TOKEN: 'd'.repeat(40), DASHCALL_PULL_NAME: 'work' };

test('agent/pull.mjs exits with a clear message when a setting is missing or wrong', async () => {
  for (const [patch, re] of [
    [{ DASHCALL_PULL_URL: 'ftp://x' }, /DASHCALL_PULL_URL/],
    [{ DASHCALL_PULL_TOKEN: 'short' }, /DASHCALL_PULL_TOKEN/],
    [{ DASHCALL_PULL_NAME: 'Work PC' }, /DASHCALL_PULL_NAME/],
  ]) {
    const { code, err } = await run({ ...OK, ...patch });
    assert.equal(code, 1, JSON.stringify(patch));
    assert.match(err, re);
  }
});
