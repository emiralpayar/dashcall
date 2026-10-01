// Smoke test for demo mode: the mock agent serves the agent API with fake data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const TOKEN = 'm'.repeat(40);
let mock, base;
before(async () => {
  mock = await startServer('scripts/mock-agent.mjs', { DASHCALL_TOKEN: TOKEN, DASHCALL_PORT: '0', DASHCALL_BIND: '127.0.0.1' });
  base = `http://127.0.0.1:${mock.port}`;
});
after(() => mock?.kill());

const call = (p, { method = 'GET', body, token = TOKEN, type = 'application/json' } = {}) =>
  fetch(base + p, { method, body, headers: { authorization: `Bearer ${token}`, 'content-type': type } });
const post = (p, d) => call(p, { method: 'POST', body: JSON.stringify(d) });

test('uses the same bearer auth and error format', async () => {
  const r = await call('/api/sessions', { token: 'nope' });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'unauthorized', code: 'unauthorized' });
  assert.equal((await (await call('/api/nothing')).json()).code, 'not_found');
});

test('serves sessions in different states, with screens', async () => {
  const { sessions } = await (await call('/api/sessions')).json();
  assert.deepEqual(sessions.map(s => s.status).sort(), ['blocked', 'done', 'working']);
  const { text } = await (await call(`/api/sessions/${encodeURIComponent(sessions[0].pane)}/screen`)).json();
  assert.match(text, /Claude Code/);
  assert.ok((await (await call('/api/recent')).json()).sessions.length > sessions.length);
  assert.ok((await (await call('/api/dirs')).json()).dirs.length);
  const b = await (await call('/api/brain')).json();
  assert.ok(b.memory.length && b.notes.length);
  const n = await (await call('/api/notifications')).json();
  assert.equal(n.unread, 1);
});

test('answers through the job flow in the requested language', async () => {
  const ask = async lang => {
    let j = await (await post('/api/ask', { text: 'what is going on?', lang })).json();
    assert.equal(j.status, 'running');
    while (j.status === 'running') { await new Promise(r => setTimeout(r, 200)); j = await (await call('/api/ask/' + j.id)).json(); }
    return j;
  };
  const [en, tr] = await Promise.all([ask('en'), ask('tr')]);
  assert.match(en.reply, /You have three sessions/);
  assert.match(tr.reply, /Üç oturumun var/);
  assert.ok(en.notificationId && en.conversationId);
});

test('ask: a retried POST with the same requestId gets the same job, with the full poll view', async () => {
  const first = await (await post('/api/ask', { text: 'what is going on?', lang: 'en', requestId: 'demo-retry-1' })).json();
  assert.equal(first.status, 'running');
  assert.deepEqual(Object.keys(first).sort(), ['elapsed', 'id', 'lang', 'status']);
  // retried while running: same job, nothing new started
  assert.equal((await (await post('/api/ask', { text: 'what is going on?', lang: 'en', requestId: 'demo-retry-1' })).json()).id, first.id);
  let j = first;
  while (j.status === 'running') { await new Promise(r => setTimeout(r, 200)); j = await (await call('/api/ask/' + first.id)).json(); }
  // retried after it finished: the POST carries the reply, like a poll does
  const again = await (await post('/api/ask', { text: 'what is going on?', lang: 'en', requestId: 'demo-retry-1' })).json();
  assert.equal(again.id, first.id);
  assert.equal(again.status, 'done');
  assert.equal(again.reply, j.reply);
  assert.equal(again.conversationId, j.conversationId);
  assert.equal(again.notificationId, j.notificationId);
  // a new requestId (or none) is a new question
  assert.notEqual((await (await post('/api/ask', { text: 'hi', requestId: 'demo-retry-2' })).json()).id, first.id);
  assert.notEqual((await (await post('/api/ask', { text: 'hi' })).json()).id, first.id);
  for (const requestId of ['', 'has space', 'x'.repeat(65), 42, ['a']]) {
    const r = await post('/api/ask', { text: 'hi', requestId });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'bad_request_id');
  }
});

test('speech: canned transcript per language, and the demo is silent', async () => {
  const stt = async lang => (await (await call('/api/stt?lang=' + lang, { method: 'POST', body: Buffer.alloc(64), type: 'audio/webm' })).json()).text;
  assert.match(await stt('en'), /sessions/);
  assert.match(await stt('tr'), /oturum/i);
  assert.deepEqual(await (await post('/api/speak', { text: 'hi' })).json(), { engine: 'silent', mime: null, audio: null, words: [] });
  assert.equal((await (await call('/api/health')).json()).silent, true);
});
