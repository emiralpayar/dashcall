import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tempDir } from './helpers.mjs';

const dir = process.env.DASHCALL_STATE_DIR = tempDir();
const S = await import('../agent/store.mjs');

test('read() of a missing list is empty', () => {
  assert.deepEqual(S.read('nothing'), []);
});

test('notify() stores unread notifications and caps the list at 200', () => {
  for (let i = 0; i < 205; i++) S.notify({ text: 'n' + i });
  const all = S.read('notifications');
  assert.equal(all.length, 200);
  assert.equal(all[0].text, 'n5');
  assert.equal(all.at(-1).read, false);
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('markRead() by ids and "all"', () => {
  const [a, b] = S.read('notifications').slice(-2);
  S.markRead([a.id]);
  let all = S.read('notifications');
  assert.equal(all.find(n => n.id === a.id).read, true);
  assert.equal(all.find(n => n.id === b.id).read, false);
  S.markRead('all');
  all = S.read('notifications');
  assert.ok(all.every(n => n.read));
});

test('addWatch() applies defaults that callers can override', () => {
  const w = S.addWatch({ pane: 'p1', sawWorking: true });
  assert.equal(w.state, 'waiting');
  assert.equal(w.idlePolls, 0);
  assert.equal(w.sawWorking, true);
  assert.equal(S.update('watches', l => l.length), 1);
});

test('two processes updating the same file concurrently lose nothing', async () => {
  const { spawn } = await import('node:child_process');
  const script = `const S = await import(${JSON.stringify(new URL('../agent/store.mjs', import.meta.url).href)});
    for (let i = 0; i < 100; i++) S.update('race', l => { l.push(i); });`;
  const run = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DASHCALL_STATE_DIR: dir }, stdio: 'inherit' });
    p.on('exit', code => (code ? reject(new Error('exit ' + code)) : resolve()));
  });
  await Promise.all([run(), run(), run()]);
  assert.equal(S.read('race').length, 300);
});
