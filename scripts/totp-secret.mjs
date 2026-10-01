// Generates a secret for the optional two-factor login (DASHCALL_TOTP_SECRET) and the otpauth:// URI that
// authenticator apps import. Usage: node scripts/totp-secret.mjs [account name shown in the app]
import { randomBytes } from 'node:crypto';
import { base32Encode } from '../web/totp.mjs';

const secret = base32Encode(randomBytes(20)); // 160 bits, the size RFC 4226 recommends
const account = process.argv[2] || 'dashcall';
const uri = `otpauth://totp/Dashcall:${encodeURIComponent(account)}?secret=${secret}&issuer=Dashcall&algorithm=SHA1&digits=6&period=30`;
console.log(`DASHCALL_TOTP_SECRET=${secret}

${uri}

1. Add it to your authenticator app: scan a QR code of the URI above (for example \`qrencode -t ansiutf8 '<uri>'\`),
   or enter the secret by hand (time-based, 6 digits, 30 seconds).
2. Put the DASHCALL_TOTP_SECRET line in web/.env and restart the web app. Every device then logs in once more,
   with the password and the 6-digit code.`);
