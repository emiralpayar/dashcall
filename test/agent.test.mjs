// Spawns agent/server.mjs with fake claude / ffmpeg / whisper / python binaries (no herdr, network or models needed)
// and checks auth, input validation, the error format and language handling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startServer, tempDir } from './helpers.mjs';

const TOKEN = 't'.repeat(40);
let agent, base, dir;

// Tiny shell scripts standing in for the real tools.
function fakeBin(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

before(async () => {
  dir = tempDir();
  agent = await startServer('agent/server.mjs', {
    DASHCALL_TOKEN: TOKEN, DASHCALL_PORT: '0', DASHCALL_BIND: '127.0.0.1', DASHCALL_DEFAULT_LANGUAGE: 'en',
    DASHCALL_STATE_DIR: path.join(dir, 'state'), DASHCALL_BRAIN_FILE: path.join(dir, 'brain.json'), DASHCALL_HERDR_BIN: '/nonexistent/herdr',
    FAKE_DIR: dir, // the fake claude logs every prompt to calls.txt
    // echoes the reply language it was given, via the system prompt and the environment
    // "utf8test" replies "şğı" with a multi-byte character split across two writes
    // "argsdump" saves its arguments; "limittest" / "failtest" fail like Claude Code does;
    // "queuetest" logs which session it resumes, takes a while and always ends in session 2222…
    DASHCALL_CLAUDE_BIN: fakeBin(dir, 'claude', `L=none R= P=
printf '%s\\n' "$2" >> "$FAKE_DIR/calls.txt"
for a; do [ "$P" = --resume ] && R=$a; P=$a; done
case "$2" in
  *argsdump*) for a; do printf '%s\\0' "$a"; done > "$FAKE_DIR/args.bin";;
  *limittest*) printf '{"type":"result","is_error":true,"result":"You\\047ve hit your session limit · resets 2pm (Europe/Istanbul)","session_id":"0f8fad5b-d9cb-469f-a165-70867728950e"}'; exit 0;;
  *failtest*) printf '{"type":"result","is_error":true,"result":"Prompt is too long","session_id":"0f8fad5b-d9cb-469f-a165-70867728950e"}'; exit 0;;
  *queuetest*) echo "start $R" >> "$FAKE_DIR/queue.txt"; sleep 0.6; echo "end $R" >> "$FAKE_DIR/queue.txt"
    printf '{"result":"ok","session_id":"22222222-2222-4222-8222-222222222222","is_error":false}'; exit 0;;
esac
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

async function poll(j) {
  for (let i = 0; i < 100 && j.status === 'running'; i++) {
    await new Promise(r => setTimeout(r, 50));
    j = await (await call('/api/ask/' + j.id)).json();
  }
  return j;
}
const ask = async data => poll(await (await post('/api/ask', data)).json());
const notification = async id => (await (await call('/api/notifications')).json()).items.find(x => x.id === id);

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

test('the dispatcher runs with an allow-list, not --dangerously-skip-permissions', async () => {
  assert.equal((await ask({ text: 'argsdump', lang: 'en' })).status, 'done');
  const args = readFileSync(path.join(dir, 'args.bin'), 'utf8').split('\0');
  assert.deepEqual(args.slice(0, 2), ['-p', 'argsdump']);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Bash(dashcall:*)');
});

test('a repeated requestId returns the first job instead of asking again', async () => {
  const body = { text: 'idempotent question', lang: 'en', requestId: 'req-1' };
  const a = await (await post('/api/ask', body)).json();
  assert.equal((await (await post('/api/ask', body)).json()).id, a.id);
  assert.equal((await poll(a)).status, 'done');
  assert.equal((await (await post('/api/ask', body)).json()).id, a.id, 'also once it has finished');
  assert.notEqual((await ask({ ...body, requestId: 'req-2' })).id, a.id);
  assert.equal(readFileSync(path.join(dir, 'calls.txt'), 'utf8').split('\n').filter(l => l === body.text).length, 2);
  for (const requestId of ['has space', 'x'.repeat(65), 42, '']) {
    await assertError(await post('/api/ask', { text: 'x', requestId }), 400, 'bad_request_id');
  }
});

test('jobs of one conversation run one at a time and resume its latest session', async () => {
  const conv = '11111111-1111-4111-8111-111111111111', next = '22222222-2222-4222-8222-222222222222';
  const a = await (await post('/api/ask', { text: 'queuetest a', conversationId: conv })).json();
  const b = await (await post('/api/ask', { text: 'queuetest b', conversationId: conv })).json();
  assert.equal(a.queued, undefined);
  assert.deepEqual([b.status, b.queued], ['running', true]);
  assert.equal((await (await call('/api/ask/' + b.id)).json()).queued, true); // the web client keeps polling
  const [ra, rb] = await Promise.all([poll(a), poll(b)]);
  assert.deepEqual([ra.status, rb.status, rb.conversationId, rb.queued], ['done', 'done', next, undefined]);
  assert.deepEqual(readFileSync(path.join(dir, 'queue.txt'), 'utf8').trim().split('\n'), [`start ${conv}`, `end ${conv}`, `start ${next}`, `end ${next}`]);
});

test('a Claude usage limit is reported in the job language; the raw text stays in detail', async () => {
  const j = await ask({ text: 'limittest', lang: 'tr' });
  assert.equal(j.status, 'error');
  assert.equal(j.error, '[[Claude|klod]] kullanım limitine ulaşıldı, 14:00’te sıfırlanıyor.');
  assert.equal(j.detail, 'You\'ve hit your session limit · resets 2pm (Europe/Istanbul)');
  const n = await notification(j.notificationId);
  assert.deepEqual([n.text, n.detail, n.error], [j.error, j.detail, true]);
  // anything else keeps the generic failure text
  const f = await ask({ text: 'failtest', lang: 'en' });
  assert.deepEqual([f.error, f.detail], ['Prompt is too long', undefined]);
  assert.equal((await notification(f.notificationId)).text, 'Something went wrong: Prompt is too long');
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
