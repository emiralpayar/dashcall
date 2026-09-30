import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const tempDir = () => mkdtempSync(path.join(tmpdir(), 'agent-test-'));

// Start a server script on a free port (port 0) and wait until it logs where it listens; the port is on `.port`.
export function startServer(script, env) {
  const p = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const onData = d => { out += d; const m = / on .*:(\d+)/.exec(out); if (m) { p.port = Number(m[1]); resolve(p); } };
    p.stdout.on('data', onData);
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => reject(new Error(`server exited (${code}): ${out}`)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 5000);
  });
}
