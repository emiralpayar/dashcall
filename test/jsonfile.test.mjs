// agent/jsonfile.mjs: a state file that can't be read is never written over, and a crash can't wedge the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, updateJson } from '../agent/jsonfile.mjs';
import { tempDir } from './helpers.mjs';

const MOD = new URL('../agent/jsonfile.mjs', import.meta.url).href;
const list = () => [];
const brain = () => ({ memory: [] });
const quiet = t => t.mock.method(console, 'error', () => {});
const corrupt = dir => readdirSync(dir).filter(n => n.includes('.corrupt-'));

test('a missing file reads as the fallback and is created by the first update', () => {
  const dir = tempDir(), f = path.join(dir, 'sub', 'state.json');
  assert.deepEqual(readJson(f, list), []);
  assert.equal(updateJson(f, list, l => { l.push(1); return 'ok'; }), 'ok');
  assert.deepEqual(readJson(f, list), [1]);
  assert.deepEqual(readdirSync(path.dirname(f)), ['state.json'], 'no lock or temp file left behind');
});

test('readJson() leaves an unparseable file alone and warns once per breakage', t => {
  const dir = tempDir(), f = path.join(dir, 'brain.json'), bad = '{"memory": [{"text": "keep me"}],}';
  writeFileSync(f, bad);
  const err = quiet(t);
  assert.deepEqual(readJson(f, brain), { memory: [] });
  assert.deepEqual(readJson(f, brain), { memory: [] });
  assert.equal(readFileSync(f, 'utf8'), bad);
  assert.deepEqual(readdirSync(dir), ['brain.json']);
  assert.equal(err.mock.callCount(), 1);
  assert.match(err.mock.calls[0].arguments[0], /ignoring .*brain\.json/);
  writeFileSync(f, '{"memory": []}');
  readJson(f, brain);
  writeFileSync(f, 'oops');
  readJson(f, brain);
  assert.equal(err.mock.callCount(), 2, 'a file that broke again is reported again');
});

test('updateJson() moves an unparseable file aside instead of writing over it', t => {
  const dir = tempDir(), f = path.join(dir, 'brain.json'), bad = '{"memory": [{"text": "keep me"}],}';
  writeFileSync(f, bad);
  const err = quiet(t);
  assert.equal(updateJson(f, brain, b => b.memory.push({ text: 'new' })), 1);
  const [kept] = corrupt(dir);
  assert.match(kept, /^brain\.json\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
  assert.equal(readFileSync(path.join(dir, kept), 'utf8'), bad, 'the original content is kept byte for byte');
  assert.deepEqual(readJson(f, brain), { memory: [{ text: 'new' }] });
  assert.deepEqual(readdirSync(dir).sort(), ['brain.json', kept].sort());
  assert.equal(err.mock.callCount(), 1);
  assert.ok(err.mock.calls[0].arguments[0].includes(kept), 'the warning says where the content went');
});

test('valid JSON of the wrong kind is unusable too, and kept the same way', t => {
  quiet(t);
  for (const [content, fallback] of [['[1, 2]', brain], ['{"a": 1}', list], ['null', list], ['"text"', brain]]) {
    const dir = tempDir(), f = path.join(dir, 'x.json');
    writeFileSync(f, content);
    assert.deepEqual(readJson(f, fallback), fallback(), content);
    updateJson(f, fallback, () => {});
    assert.deepEqual(readJson(f, fallback), fallback(), content);
    assert.equal(readFileSync(path.join(dir, corrupt(dir)[0]), 'utf8'), content);
  }
});

test('a blank file is just empty: nothing to keep, nothing to warn about', t => {
  const err = quiet(t), dir = tempDir(), f = path.join(dir, 'x.json');
  writeFileSync(f, ' \n');
  assert.deepEqual(readJson(f, list), []);
  updateJson(f, list, l => l.push(1));
  assert.deepEqual(readJson(f, list), [1]);
  assert.deepEqual(corrupt(dir), []);
  assert.equal(err.mock.callCount(), 0);
});

test('read errors other than a missing file throw instead of reading as empty', () => {
  const f = path.join(tempDir(), 'x.json');
  mkdirSync(f);
  assert.throws(() => readJson(f, list), { code: 'EISDIR' });
  assert.throws(() => updateJson(f, list, l => l.push(1)), { code: 'EISDIR' });
  assert.ok(!existsSync(f + '.lock'), 'the lock is released');
});

test('an unreadable file throws EACCES and is never written over', { skip: process.getuid?.() === 0 && 'root reads anything' }, () => {
  const f = path.join(tempDir(), 'x.json');
  writeFileSync(f, '[1]');
  chmodSync(f, 0);
  try {
    assert.throws(() => readJson(f, list), { code: 'EACCES' });
    assert.throws(() => updateJson(f, list, l => l.push(2)), { code: 'EACCES' });
  } finally { chmodSync(f, 0o644); }
  assert.equal(readFileSync(f, 'utf8'), '[1]');
});

test('the lock holds its owner pid; a nested update of the same file fails fast', () => {
  const f = path.join(tempDir(), 'x.json');
  updateJson(f, list, () => {
    assert.equal(readFileSync(f + '.lock', 'utf8'), String(process.pid));
    assert.throws(() => updateJson(f, list, () => {}), /nested update/);
  });
  assert.ok(!existsSync(f + '.lock'));
});

test('a lock left by a process killed mid-update is broken at once', () => {
  const f = path.join(tempDir(), 'x.json');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { updateJson } = await import(${JSON.stringify(MOD)});
     updateJson(${JSON.stringify(f)}, () => [], () => process.kill(process.pid, 'SIGKILL'));`]);
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(readFileSync(f + '.lock', 'utf8'), String(r.pid), 'the dead process left its lock behind');
  const t0 = Date.now();
  updateJson(f, list, l => l.push('after'));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(readJson(f, list), ['after']);
});

test('a lock carrying this process\'s own pid is from an earlier process and is broken at once', () => {
  const f = path.join(tempDir(), 'x.json');
  writeFileSync(f + '.lock', String(process.pid));
  const t0 = Date.now();
  updateJson(f, list, l => l.push(1));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('an old lock is broken even when its pid is alive or missing', () => {
  for (const owner of [String(process.ppid), '']) {
    const f = path.join(tempDir(), 'x.json'), old = new Date(Date.now() - 60e3);
    writeFileSync(f + '.lock', owner);
    utimesSync(f + '.lock', old, old);
    const t0 = Date.now();
    updateJson(f, list, l => l.push(1));
    assert.ok(Date.now() - t0 < 1000, `owner ${JSON.stringify(owner)}: took ${Date.now() - t0} ms`);
  }
});

test('a fresh lock held by a live process is waited for, not broken', async () => {
  const f = path.join(tempDir(), 'x.json'), lock = f + '.lock';
  const holder = spawn(process.execPath, ['-e', `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(lock)}, String(process.pid), { flag: 'wx' });
    console.log('locked'); setTimeout(() => fs.unlinkSync(${JSON.stringify(lock)}), 400);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => holder.on('exit', resolve));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const t0 = Date.now();
  updateJson(f, list, l => l.push(1));
  const waited = Date.now() - t0;
  assert.ok(waited >= 250 && waited < 3000, `waited ${waited} ms`);
  assert.equal(await exited, 0, 'the holder still owned its lock when it let go');
  assert.deepEqual(readJson(f, list), [1]);
});
