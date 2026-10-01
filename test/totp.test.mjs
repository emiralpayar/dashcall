// One-time codes for the optional two-factor login (web/totp.mjs) and the secret generator script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { base32Decode, base32Encode, hotp, totp, totpStep, STEP } from '../web/totp.mjs';

const KEY = Buffer.from('12345678901234567890'); // the seed of the RFC 4226 / RFC 6238 SHA1 test vectors

test('TOTP matches the RFC 6238 SHA1 test vectors', () => {
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [time, code] of vectors) assert.equal(totp(KEY, time, 8), code, `T=${time}`);
});

test('HOTP matches the RFC 4226 test vectors', () => {
  const codes = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  codes.forEach((code, counter) => assert.equal(hotp(KEY, counter), code, `counter ${counter}`));
});

test('base32 matches RFC 4648 and tolerates the way apps display secrets', () => {
  const vectors = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
  for (const [plain, enc] of Object.entries(vectors)) {
    assert.equal(base32Encode(Buffer.from(plain)), enc);
    if (enc) assert.equal(base32Decode(enc).toString(), plain);
  }
  assert.equal(base32Encode(KEY), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-gy3t qojq gezdgnbvgy3tqojq'), KEY);
  assert.equal(base32Decode('MZXW6===').toString(), 'foo');
  for (const bad of ['MZXW1', 'not base32!', '']) assert.equal(base32Decode(bad), null, bad);
});

test('a code is accepted one step either side of now, and reports its step', () => {
  const now = 1_700_000_015, step = Math.floor(now / STEP);
  for (const s of [step - 1, step, step + 1]) assert.equal(totpStep(KEY, hotp(KEY, s), now), s);
  for (const s of [step - 2, step + 2]) assert.equal(totpStep(KEY, hotp(KEY, s), now), -1);
  for (const bad of ['', '12345', '1234567', 'abcdef', hotp(KEY, step) + ' ']) assert.equal(totpStep(KEY, bad, now), -1, bad);
});

test('totp-secret.mjs prints a 160-bit secret and an otpauth URI for Dashcall', () => {
  const out = execFileSync(process.execPath, ['scripts/totp-secret.mjs', 'dashcall.example.com'], { encoding: 'utf8' });
  const secret = /^DASHCALL_TOTP_SECRET=([A-Z2-7]+)$/m.exec(out)[1];
  assert.equal(base32Decode(secret).length, 20);
  const uri = new URL(/^otpauth:\/\/\S+$/m.exec(out)[0]);
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.host, 'totp');
  assert.equal(uri.pathname, '/Dashcall:dashcall.example.com');
  assert.equal(uri.searchParams.get('secret'), secret);
  assert.equal(uri.searchParams.get('issuer'), 'Dashcall');
  assert.equal(uri.searchParams.get('digits'), '6');
  assert.equal(uri.searchParams.get('period'), '30');
  assert.notEqual(execFileSync(process.execPath, ['scripts/totp-secret.mjs'], { encoding: 'utf8' }), out, 'a new secret each time');
});
