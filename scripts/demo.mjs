// Demo mode: the web app in front of a mock agent with fake sessions. No Mac, herdr or Claude Code needed.
// Usage: npm run demo   (PORT=8080 by default; the mock agent gets a free local port)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.PORT || '8080';
const token = randomBytes(24).toString('hex');
const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const agentPort = await freePort();

const children = [];
function start(name, script, env) {
  const p = spawn(process.execPath, [path.join(ROOT, script)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let buf = '';
  const ready = new Promise((resolve, reject) => {
    const onLine = chunk => {
      buf += chunk;
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        if (!/warning: DASHCALL_PASSWORD is short/.test(line)) console.log(`[${name}] ${line}`);
      }
      if (/ on .*:\d+/.test(buf)) resolve();
    };
    p.stdout.on('data', onLine); p.stderr.on('data', onLine);
    p.on('exit', code => { reject(new Error(`${name} exited (${code})`)); shutdown(code || 1); });
  });
  return ready;
}
function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown());

try {
  await start('agent', 'scripts/mock-agent.mjs', { DASHCALL_TOKEN: token, DASHCALL_PORT: String(agentPort), DASHCALL_BIND: '127.0.0.1' });
  await start('web', 'web/server.mjs', {
    PORT, DASHCALL_PASSWORD: 'demo', DASHCALL_SECRET: randomBytes(32).toString('hex'), DASHCALL_COOKIE_SECURE: '0',
    DASHCALL_AGENT_URL: `http://127.0.0.1:${agentPort}`, DASHCALL_AGENT_TOKEN: token,
  });
} catch (e) { console.error(e.message); shutdown(1); }
console.log(`\nOpen http://localhost:${PORT} — password: demo\n(Ctrl+C to stop)`);
