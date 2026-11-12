// scripts/remote-agent.mjs (the one-file agent for a second machine) against a fake `claude`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, tempDir } from './helpers.mjs';

const TOKEN = 't'.repeat(40), URL_ = 'https://claude.ai/code/session_01WorkPc';
const dir = tempDir(), logs = path.join(dir, 'logs'), calls = path.join(dir, 'calls');
// Like the real one: status lines with colours, the link inside a terminal hyperlink, then it keeps running.
const fake = path.join(dir, 'claude');
writeFileSync(fake, `#!/bin/sh
echo "$PWD $*" >> ${calls}
printf '\\033[2K Connected\\n'
sleep 0.3
printf '    \\033]8;;${URL_}?from=cli\\033\\\\Attached\\033]8;;\\033\\\\\\n'
sleep 1
`, { mode: 0o755 });
const broken = path.join(dir, 'claude-broken');
writeFileSync(broken, '#!/bin/sh\necho "Error: Workspace not trusted."\nexit 1\n', { mode: 0o755 });

const env = extra => ({ DASHCALL_TOKEN: TOKEN, DASHCALL_PORT: '0', DASHCALL_REMOTE_DIR: dir, DASHCALL_CLAUDE_BIN: fake, DASHCALL_REMOTE_LOG_DIR: logs, ...extra });
const call = (port, p, method = 'GET', token = TOKEN) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${token}` } });
let agent;
before(async () => { agent = await startServer('scripts/remote-agent.mjs', env()); });
after(() => agent?.kill());

test('every request needs the token', async () => {
  for (const [p, m] of [['/api/health', 'GET'], ['/api/sessions/remote', 'POST']]) {
    const r = await call(agent.port, p, m, 'wrong');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'unauthorized');
  }
  assert.deepEqual(await (await call(agent.port, '/api/health')).json(), { ok: true });
  assert.equal((await call(agent.port, '/api/nope')).status, 404);
});

test('POST /api/sessions/remote starts claude remote-control in the folder and returns its link', async () => {
  // two taps at once share one start
  const [a, b] = await Promise.all([call(agent.port, '/api/sessions/remote', 'POST'), call(agent.port, '/api/sessions/remote', 'POST')]);
  const first = await a.json();
  assert.equal(first.url, URL_);
  assert.match(first.cwd, /[\\/]session-[\dTZ-]+$/);
  assert.equal(path.dirname(first.cwd), dir, 'a new subfolder of DASHCALL_REMOTE_DIR');
  assert.deepEqual(await b.json(), first);
  assert.equal(readdirSync(logs).length, 1, 'one session, one output file');
  assert.match(readFileSync(calls, 'utf8'), new RegExp(`session-[\\dTZ-]+ remote-control\n`), 'claude ran inside that folder');
  // the next tap is a new session in another folder
  const second = await (await call(agent.port, '/api/sessions/remote', 'POST')).json();
  assert.notEqual(second.cwd, first.cwd);
});

test('the permission mode is passed on, and a claude that stops is reported with what it said', async () => {
  const withMode = await startServer('scripts/remote-agent.mjs', env({ DASHCALL_REMOTE_PERMISSION_MODE: 'acceptEdits', DASHCALL_REMOTE_LOG_DIR: path.join(dir, 'logs2') }));
  try { assert.equal((await call(withMode.port, '/api/sessions/remote', 'POST')).status, 200); } finally { withMode.kill(); }
  assert.match(readFileSync(calls, 'utf8'), /remote-control --permission-mode acceptEdits\n/);

  const bad = await startServer('scripts/remote-agent.mjs', env({ DASHCALL_CLAUDE_BIN: broken, DASHCALL_REMOTE_LOG_DIR: path.join(dir, 'logs3') }));
  try {
    const r = await call(bad.port, '/api/sessions/remote', 'POST');
    assert.equal(r.status, 500);
    const d = await r.json();
    assert.equal(d.code, 'session_start_failed');
    assert.match(d.error, /Workspace not trusted/);
  } finally { bad.kill(); }
});

test('a short token or a missing folder stops the agent at start', async () => {
  await assert.rejects(startServer('scripts/remote-agent.mjs', env({ DASHCALL_TOKEN: 'short' })), /exited \(1\).*DASHCALL_TOKEN/s);
  await assert.rejects(startServer('scripts/remote-agent.mjs', env({ DASHCALL_REMOTE_DIR: path.join(dir, 'nope') })), /exited \(1\).*DASHCALL_REMOTE_DIR/s);
});
