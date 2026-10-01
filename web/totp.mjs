// RFC 6238 time-based one-time codes (HMAC-SHA1, 30-second steps): what authenticator apps show. node:crypto only.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STEP = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let out = '', bits = 0, v = 0;
  for (const b of buf) {
    v = ((v << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + B32[(v << (5 - bits)) & 31] : out;
}

// Returns null for anything that isn't base32. Case, spaces, dashes and padding are ignored, because apps and
// generators show secrets in different shapes ("jbsw y3dp ...").
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  const out = []; let bits = 0, v = 0;
  for (const c of clean) {
    v = ((v << 5) | B32.indexOf(c)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// RFC 4226 HOTP: dynamic truncation of HMAC-SHA1(key, 8-byte big-endian counter).
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const n = h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, '0');
}

export const totp = (key, seconds = Date.now() / 1000, digits = 6) => hotp(key, Math.floor(seconds / STEP), digits);

// The time step a 6-digit code belongs to, or -1. One step either side is accepted for clock drift and typing time;
// the caller must still refuse a step that was already used (RFC 6238 section 5.2).
export function totpStep(key, code, seconds = Date.now() / 1000) {
  if (!/^\d{6}$/.test(code)) return -1;
  const now = Math.floor(seconds / STEP);
  for (const s of [now, now - 1, now + 1]) if (timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code))) return s;
  return -1;
}
