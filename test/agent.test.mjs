// Spawns agent/server.mjs with fake claude / ffmpeg / whisper / python binaries (no herdr, network or models needed)
// and checks auth, input validation, the error format and language handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, tempDir } from './helpers.mjs';

const TOKEN = 't'.repeat(40);
let agent, base;

// Tiny shell scripts standing in for the real tools.
function fakeBin(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

before(async () => {
  const dir = tempDir();
  agent = await startServer('agent/server.mjs', {
    DASHCALL_TOKEN: TOKEN, DASHCALL_PORT: '0', DASHCALL_BIND: '127.0.0.1', DASHCALL_DEFAULT_LANGUAGE: 'en',
    DASHCALL_STATE_DIR: path.join(dir, 'state'), DASHCALL_BRAIN_FILE: path.join(dir, 'brain.json'), DASHCALL_HERDR_BIN: '/nonexistent/herdr',
    // echoes the reply language it was given, via the system prompt and the environment
    // "utf8test" replies "şğı" with a multi-byte character split across two writes
    DASHCALL_CLAUDE_BIN: fakeBin(dir, 'claude', `L=none
case "$2" in *utf8test*) printf '{"result":"\\305'; sleep 0.3; printf '\\237\\304\\237\\304\\261","session_id":"0f8fad5b-d9cb-469f-a165-70867728950e","is_error":false}'; exit 0;; esac
for a; do case "$a" in *"Reply language: Turkish"*) L=tr;; *"Reply language: English"*) L=en;; esac; done
printf '{"result":"prompt=%s env=%s","session_id":"0f8fad5b-d9cb-469f-a165-70867728950e","is_error":false}' "$L" "$DASHCALL_LANGUAGE"`),
    DASHCALL_FFMPEG_BIN: fakeBin(dir, 'ffmpeg', 'exit 0'),
    DASHCALL_WHISPER_BIN: fakeBin(dir, 'whisper', 'echo "args: $*"'),
    DASHCALL_TTS_PYTHON: fakeBin(dir, 'python', 'cat >/dev/null; printf \'{"audio":"AA==","words":[]}\''),
  });
  base = `http://127.0.0.1:${agent.port}`;
});
after(() => agent?.kill());

const call = (p, { method = 'GET', body, token = TOKEN, type = 'application/json' } = {}) =>
  fetch(base + p, { method, body, headers: { authorization: `Bearer ${token}`, 'content-type': type } });
const post = (p, data) => call(p, { method: 'POST', body: JSON.stringify(data) });
const WAV = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(32)]);

// Every error is {error, code} with the expected status.
async function assertError(r, status, code) {
  assert.equal(r.status, status);
  const d = await r.json();
  assert.equal(d.code, code);
  assert.equal(typeof d.error, 'string');
  assert.deepEqual(Object.keys(d).sort(), ['code', 'error']);
}

test('requires the bearer token', async () => {
  await assertError(await call('/api/health', { token: 'wrong' }), 401, 'unauthorized');
  assert.deepEqual(await (await call('/api/health')).json(), { ok: true });
});

test('brain notes round-trip', async () => {
  const n = await (await post('/api/brain/note', { text: 'hello' })).json();
  const b = await (await call('/api/brain')).json();
  assert.equal(b.notes[0].id, n.id);
});

test('bad input gets 4xx with an error code, not 500', async () => {
  await assertError(await post('/api/brain/forget', {}), 400, 'key_required');
  await assertError(await post('/api/brain/forget', { key: 'nope' }), 404, 'not_found');
  await assertError(await call('/api/brain/done/nope', { method: 'POST' }), 404, 'not_found');
  await assertError(await post('/api/brain/mute', {}), 400, 'key_required');
  await assertError(await call('/api/brain/note', { method: 'POST', body: '{not json' }), 400, 'invalid_json');
  await assertError(await call('/api/brain/note', { method: 'POST', body: 'null' }), 400, 'text_required');
  await assertError(await post('/api/ask', { text: 'x', conversationId: '--help' }), 400, 'bad_conversation_id');
  await assertError(await post('/api/ask', { text: '  ' }), 400, 'text_required');
  await assertError(await post('/api/sessions/p1/keys', { keys: ['rm -rf'] }), 400, 'bad_keys');
  await assertError(await post('/api/sessions/new', {}), 400, 'folder_not_found');
  await assertError(await call('/api/ask/unknown'), 404, 'unknown_job');
  await assertError(await call('/api/nothing'), 404, 'not_found');
  await assertError(await call('/api/%E0%A4%A'), 400, 'bad_path');
});

test('unexpected failures are reported as internal errors', async () => {
  await assertError(await call('/api/sessions'), 500, 'internal'); // herdr is missing
});

test('speech-to-text only accepts browser audio containers', async () => {
  await assertError(await call('/api/stt', { method: 'POST', body: '#EXTM3U\nfile:///etc/passwd\n', type: 'audio/webm' }), 415, 'unsupported_audio');
});

test('speech-to-text passes the requested language to whisper, defaulting when invalid', async () => {
  const stt = async q => (await (await call('/api/stt' + q, { method: 'POST', body: WAV, type: 'audio/wav' })).json()).text;
  assert.match(await stt('?lang=tr'), /-l tr /);
  assert.match(await stt('?lang=en'), /-l en /);
  assert.match(await stt('?lang=xx'), /-l en /);
  assert.match(await stt(''), /-l en /);
});

test('speak picks a voice of the requested language', async () => {
  const speak = async d => (await (await post('/api/speak', { text: 'hi', ...d })).json()).voice;
  assert.equal(await speak({ lang: 'tr' }), 'tr-TR-EmelNeural');
  assert.equal(await speak({ lang: 'tr', voice: 'tr-TR-AhmetNeural' }), 'tr-TR-AhmetNeural');
  assert.equal(await speak({ lang: 'en', voice: 'tr-TR-AhmetNeural' }), 'en-US-AvaNeural');
  assert.equal(await speak({ lang: 'en', voice: 'en-US-AndrewNeural' }), 'en-US-AndrewNeural');
  assert.equal(await speak({ voice: 'evil; rm -rf /' }), 'en-US-AvaNeural');
});

async function ask(data) {
  let j = await (await post('/api/ask', data)).json();
  for (let i = 0; i < 100 && j.status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 50));
    j = await (await call('/api/ask/' + j.id)).json();
  }
  return j;
}

test('ask runs the dispatcher in the requested language and stores a notification', async () => {
  const tr = await ask({ text: 'merhaba', lang: 'tr' });
  assert.equal(tr.status, 'done');
  assert.equal(tr.reply, 'prompt=tr env=tr');
  assert.equal(tr.conversationId, '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.equal((await ask({ text: 'hello', lang: 'en' })).reply, 'prompt=en env=en');
  assert.equal((await ask({ text: 'hello', lang: 'de' })).reply, 'prompt=en env=en');
  const { items } = await (await call('/api/notifications')).json();
  const n = items.find(x => x.id === tr.notificationId);
  assert.equal(n.lang, 'tr');
  assert.equal(n.kind, 'answer');
});

test('new sessions are limited to WORKSPACE_ROOT', async () => {
  const r = await post('/api/sessions/new', { cwd: '/', prompt: 'x' });
  await assertError(r.clone(), 400, 'folder_outside_root');
  assert.match((await r.json()).error, /must be inside/);
  await assertError(await post('/api/sessions/new', { cwd: '/nonexistent/folder' }), 400, 'folder_not_found');
});

test('multi-byte characters split across output chunks survive', async () => {
  assert.equal((await ask({ text: 'utf8test', lang: 'tr' })).reply, 'şğı');
});

test('a malformed request line does not crash the agent', async () => {
  const net = await import('node:net');
  await new Promise(resolve => {
    const s = net.connect(agent.port, '127.0.0.1', () => s.end('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.on('data', () => {}); s.on('close', resolve); s.on('error', resolve);
  });
  assert.deepEqual(await (await call('/api/health')).json(), { ok: true });
});
