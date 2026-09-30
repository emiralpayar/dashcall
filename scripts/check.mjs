// `npm run check`: syntax-check every JavaScript file in the repo with `node --check`.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.git', 'state', 'models', '.venv', 'research']);
// The extensionless CLI is an ES module; `node --check <file>` would skip it, so it goes through stdin.
const CLI = path.join(ROOT, 'agent/bin/dashcall');
const files = [CLI];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.m?js$/.test(e.name)) files.push(p);
  }
})(ROOT);
let failed = 0;
for (const f of files) {
  try {
    if (f === CLI) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(f), stdio: ['pipe', 'ignore', 'inherit'] });
    else execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch { console.error('  in ' + path.relative(ROOT, f)); failed++; }
}
console.log(`checked ${files.length} files${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
