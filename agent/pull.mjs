// Dashcall pull agent: for a machine that can reach the web app but cannot be reached FROM it — a work PC on a
// network that blocks inbound connections, or where the private network (Tailscale) between the two can't be used.
// Instead of listening like agent/server.mjs, it makes only outbound HTTPS to the web app: it holds open
// GET /device/poll, and when the phone shortcut asks for a remote session it starts one here — a herdr session with
// /remote-control turned on, exactly like the main agent — and posts the link back to POST /device/result.
//
// It needs herdr and Claude Code on this machine, like the main agent, but no whisper, ffmpeg, TTS or open port.
// Settings (environment, via agent/config.mjs): DASHCALL_PULL_URL (the web app, e.g. https://pilot.example.com),
// DASHCALL_PULL_TOKEN (this machine's device token, matching DASHCALL_PULL_DEVICES on the web app), DASHCALL_PULL_NAME
// (this machine's id). Session behaviour comes from the usual DASHCALL_SESSION_COMMAND / DASHCALL_WORKSPACE_ROOT.
import { config } from './config.mjs';
import { startRemoteSession } from './lib.mjs';

const { url, token, name } = config.pull;
const die = m => { console.error(m); process.exit(1); };
if (!/^https?:\/\//.test(url)) die('DASHCALL_PULL_URL must be the web app URL, e.g. https://pilot.example.com');
if (!token || token.length < 32) die('DASHCALL_PULL_TOKEN must be set (the device token configured on the web app, 32+ chars)');
if (!name || !/^[a-z0-9-]{1,32}$/.test(name)) die('DASHCALL_PULL_NAME must be this machine id (a-z, 0-9, -), matching the web app');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const headers = { authorization: `Bearer ${token}`, 'x-dashcall-device': name, 'content-type': 'application/json' };

async function post(body) {
  try {
    const r = await fetch(url + '/device/result', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) log('result rejected', r.status);
  } catch (e) { log('could not deliver result', e.message); }
}

async function handle(job) {
  log('job', job.id, '→ starting a remote session');
  try {
    const { url: link, pane } = await startRemoteSession();
    log('job', job.id, 'ready', link, pane);
    await post({ id: job.id, url: link });
  } catch (e) {
    log('job', job.id, 'failed:', e.message);
    await post({ id: job.id, error: e.message, code: e.code || 'internal' });
  }
}

// Long-poll loop. A poll held open with no job comes back as 204 (or times out on our side); both are normal and
// reset the backoff. Only real errors (the web app down, a rejected token) back off, so a flaky link keeps retrying.
let backoff = 1000;
log(`dashcall pull agent: ${name} → ${url}`);
for (;;) {
  try {
    const r = await fetch(url + '/device/poll', { headers, signal: AbortSignal.timeout(35000) });
    if (r.status === 200) { backoff = 1000; const { job } = await r.json().catch(() => ({})); if (job) await handle(job); }
    else if (r.status === 204) { backoff = 1000; }
    else if (r.status === 401) { log('the web app rejected the device token; check DASHCALL_PULL_TOKEN. Retrying in 30 s.'); await sleep(30000); }
    else { log('poll got', r.status); await sleep(backoff); backoff = Math.min(backoff * 2, 30000); }
  } catch (e) {
    if (e.name === 'TimeoutError') continue; // an idle long-poll that our side timed out: just poll again
    log('poll error', e.message); await sleep(backoff); backoff = Math.min(backoff * 2, 30000);
  }
}
