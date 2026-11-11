// Remote sessions: reading the /remote-control screen, and typing the command through a fake herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.mjs';

// The fake herdr logs every call and shows a "Continue" menu until Enter was pressed twice (submit + confirm).
const dir = tempDir(), log = path.join(dir, 'calls'), fake = path.join(dir, 'herdr');
const URL_ = 'https://claude.ai/code/session_01AbCdEf';
writeFileSync(log, '');
writeFileSync(fake, `#!/bin/sh
echo "$*" >> ${log}
if [ "$2" = read ]; then
  if [ "$3" = stuck ]; then echo "nothing here"; exit 0; fi
  n=$(grep -c "send-keys $3 enter" ${log})
  if [ "$n" -ge 2 ]; then echo "  /remote-control is active · Continue here, on your phone, or at ${URL_}"
  else printf '   Remote Control\\n     Disconnect this session\\n   ❯ Continue\\n   Enter to select\\n'; fi
fi
`, { mode: 0o755 });
process.env.DASHCALL_HERDR_BIN = fake;
const L = await import('../agent/lib.mjs');

test('remoteControlState() finds the link only once remote control is active, and knows when Enter is wanted', () => {
  assert.deepEqual(L.remoteControlState(`❯ /remote-control\n  /remote-control is active · Continue here, on your phone, or at ${URL_}\n`), { url: URL_ });
  assert.equal(L.remoteControlState(`see ${URL_} for an older session`), 'wait', 'a link alone is not this session');
  assert.equal(L.remoteControlState(' ❯ Continue\n   Disconnect'), 'enter');
  assert.equal(L.remoteControlState('   ❯ Disconnect this session\n     Continue\n   Enter to select · Esc to continue'), 'wait', 'never confirms another choice');
  assert.equal(L.remoteControlState(' ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel'), 'wait');
  assert.equal(L.remoteControlState('❯ /remote-control\n'), 'wait');
  assert.equal(L.remoteControlState(''), 'wait');
});

test('enableRemoteControl() types the command, confirms the menu and returns the link', async () => {
  assert.equal(await L.enableRemoteControl('w1:p1', { poll: 20 }), URL_);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls[0], 'pane send-text w1:p1 /remote-control');
  assert.equal(calls.filter(c => c === 'pane send-keys w1:p1 enter').length, 2, 'one Enter to submit, one for the menu');
});

test('enableRemoteControl() gives up with remote_control_failed when the link never shows', async () => {
  await assert.rejects(L.enableRemoteControl('stuck', { poll: 5, tries: 3 }), e => e.code === 'remote_control_failed' && e.status === 500 && /stuck/.test(e.message));
});
