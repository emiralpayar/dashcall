// Every UI string exists in both languages, and every error code a server can return has a translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const ctx = {
  document: { addEventListener() {}, dispatchEvent() {}, documentElement: {}, querySelectorAll: () => [] },
  localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en-US' },
  CustomEvent: class {}, Event: class {},
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(read('web/public/i18n.js') + '\nthis.__S = STRINGS;', ctx);
const { en, tr } = ctx.__S;
const vars = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('English and Turkish have the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) assert.deepEqual(vars(tr[k]), vars(en[k]), `placeholders differ for ${k}`);
});

test('every key used by the pages and scripts exists', () => {
  const html = read('web/public/index.html') + read('web/public/login.html');
  const js = read('web/public/app.js') + read('web/public/login.js');
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]),
    ...[...js.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1]),
    ...[...js.matchAll(/key: '([\w.]+)'/g)].map(m => m[1]),
  ]);
  const missing = [...used].filter(k => !k.endsWith('.') && !(k in en)); // 'errors.' + code etc. are prefixes
  assert.deepEqual(missing, []);
});

test('every error code the servers return has a translation', () => {
  const src = ['agent/server.mjs', 'agent/lib.mjs', 'agent/brain.mjs', 'agent/errors.mjs', 'web/server.mjs'].map(read).join('\n');
  const codes = new Set([
    ...[...src.matchAll(/httpError\(\d+, '(\w+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/fail\(res, \d+, '(\w+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/code: '(\w+)'/g)].map(m => m[1]),
  ]);
  assert.ok(codes.size > 15, 'found the error codes');
  assert.deepEqual([...codes].filter(c => !(`errors.${c}` in en)), []);
});
