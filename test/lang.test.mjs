import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.mjs';

// config is read once at import time, so the environment is set up first
process.env.DASHCALL_BRAIN_FILE = path.join(tempDir(), 'brain.json');
process.env.DASHCALL_DEFAULT_LANGUAGE = 'tr';
const { pickLang, pickVoice } = await import('../agent/lang.mjs');
const P = await import('../agent/prompts.mjs');
const { httpError, errorBody } = await import('../agent/errors.mjs');

test('pickLang() accepts en/tr and falls back to the configured default', () => {
  assert.equal(pickLang('en'), 'en');
  assert.equal(pickLang('tr'), 'tr');
  assert.equal(pickLang('de'), 'tr');
  assert.equal(pickLang(undefined), 'tr');
  assert.equal(pickLang(['en']), 'tr');
  assert.equal(pickLang('xx', 'en'), 'en');
});

test('pickVoice() keeps voices of the same language, local, and defaults the rest', () => {
  assert.equal(pickVoice('en', 'en-US-AndrewNeural'), 'en-US-AndrewNeural');
  assert.equal(pickVoice('en', 'en-US-AvaNeural'), 'en-US-AvaNeural');
  assert.equal(pickVoice('tr', 'tr-TR-AhmetNeural'), 'tr-TR-AhmetNeural');
  assert.equal(pickVoice('en', 'tr-TR-AhmetNeural'), 'en-US-AvaNeural', 'a voice of the other language');
  assert.equal(pickVoice('tr', 'en-US-AndrewNeural'), 'tr-TR-EmelNeural');
  assert.equal(pickVoice('en', undefined), 'en-US-AvaNeural');
  assert.equal(pickVoice('tr', '--rate=+99%'), 'tr-TR-EmelNeural');
  assert.equal(pickVoice('en', 'local'), 'local');
  assert.equal(pickVoice('xx', 'x'), 'tr-TR-EmelNeural', 'invalid language uses the default language');
});

test('systemPrompt() names the reply language and formats the time in its locale', () => {
  const en = P.systemPrompt('en'), tr = P.systemPrompt('tr');
  assert.match(en, /^Current time: .*\nReply language: English\nResearch folder: .*research\n\n# Your brain/);
  assert.match(tr, /Reply language: Turkish/);
  const day = new Date().toLocaleString('tr-TR', { weekday: 'long' });
  assert.ok(tr.includes(day), 'Turkish weekday name in the Turkish prompt');
});

test('watchPrompt() is marked as a system notice and asks for the watch language', () => {
  const w = { label: 'Run tests', cwd: '/proj', pane: 'p1' };
  const tr = P.watchPrompt(w, 'done', 'All green', 'tr');
  assert.ok(tr.startsWith('[SYSTEM NOTICE — not written by the user]'));
  assert.match(tr, /has finished: "Run tests"/);
  assert.match(tr, /All green/);
  assert.match(tr, /in Turkish/);
  assert.match(P.watchPrompt(w, 'blocked', '', 'en'), /is stuck waiting for input[\s\S]*in English/);
});

test('errorBody() exposes our errors and hides everything else behind `internal`', () => {
  assert.deepEqual(errorBody(httpError(404, 'not_found', 'nope')), [404, { error: 'nope', code: 'not_found' }]);
  const e = Object.assign(new Error('x'.repeat(500)), { code: 'ENOENT', status: 418 });
  const [status, body] = errorBody(e);
  assert.equal(status, 500);
  assert.equal(body.code, 'internal');
  assert.equal(body.error.length, 300);
});
