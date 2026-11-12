#!/usr/bin/env node
// Dashcall remote agent: the smallest possible agent, for a second machine that only needs the "remote session"
// button (POST /shortcut/remote/<name> on the web app, see docs/CONFIGURATION.md). One file, no dependencies, no
// herdr: it works on Windows, macOS and Linux with Node 22+ and Claude Code.
//
//   POST /api/sessions/remote   starts `claude remote-control` in a new subfolder of DASHCALL_REMOTE_DIR and returns
//                               {"url": "…", "cwd": "…"}
//   GET  /api/health            {"ok": true}
//
// Settings (environment):
//   DASHCALL_TOKEN                   required, at least 32 characters; the web app sends it as a bearer token
//   DASHCALL_REMOTE_DIR              required; every session gets a new subfolder of this folder. Not your home
//                                    folder (Claude Code refuses it): run `claude` there once and accept the trust prompt
//   DASHCALL_BIND / DASHCALL_PORT    address and port to listen on (default 127.0.0.1:7420); use the Tailscale IP
//   DASHCALL_CLAUDE_BIN              the Claude Code command (default: claude)
//   DASHCALL_REMOTE_PERMISSION_MODE  optional --permission-mode for the sessions (e.g. acceptEdits, bypassPermissions)
//   DASHCALL_REMOTE_LOG_DIR          where each session's output is kept (default: <tmp>/dashcall-remote)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = name => process.env[name] || undefined; // empty counts as unset
const TOKEN = env('DASHCALL_TOKEN');
const BIND = env('DASHCALL_BIND') || '127.0.0.1', PORT = Number(env('DASHCALL_PORT') || 7420);
const DIR = env('DASHCALL_REMOTE_DIR') && path.resolve(env('DASHCALL_REMOTE_DIR'));
const CLAUDE = env('DASHCALL_CLAUDE_BIN') || 'claude';
const MODE = env('DASHCALL_REMOTE_PERMISSION_MODE');
const LOGS = path.resolve(env('DASHCALL_REMOTE_LOG_DIR') || path.join(os.tmpdir(), 'dashcall-remote'));
const WAIT_MS = Number(env('DASHCALL_REMOTE_WAIT_MS') || 60000); // how long a session may take to print its link

const die = msg => { console.error(msg); process.exit(1); };
if (!TOKEN || TOKEN.length < 32) die('DASHCALL_TOKEN must be set, at least 32 characters (openssl rand -hex 32)');
if (!DIR || !statSync(DIR, { throwIfNoEntry: false })?.isDirectory()) die('DASHCALL_REMOTE_DIR must be an existing folder (not your home folder; run `claude` there once to trust it)');
if (MODE && !/^[A-Za-z]+$/.test(MODE)) die('DASHCALL_REMOTE_PERMISSION_MODE must be a mode name such as acceptEdits');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => createHash('sha256').update(String(s)).digest();
const authed = req => timingSafeEqual(hash(req.headers.authorization || ''), hash(`Bearer ${TOKEN}`));
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
// for error messages, what a terminal would show: no colours, cursor moves or hyperlink wrappers
const plain = s => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const SESSION_URL = /https:\/\/claude\.ai\/code\/session_\w+/;

// `claude remote-control` needs no terminal: it prints the session's link and keeps serving it. Its output goes to a
// file rather than a pipe, and it runs detached, so the session outlives a restart of this agent. Claude Code serves
// one folder once and reattaches to that folder's last session, so every start gets a folder of its own.
async function startRemote() {
  mkdirSync(LOGS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(LOGS, `${stamp}.log`), cwd = path.join(DIR, `session-${stamp}`);
  mkdirSync(cwd);
  const fd = openSync(file, 'a');
  const args = ['remote-control', ...(MODE ? ['--permission-mode', MODE] : [])];
  let exit = null;
  // shell on Windows: an npm-installed claude is claude.cmd, which only a shell can run. The arguments are fixed words.
  const child = spawn(CLAUDE, args, { cwd, stdio: ['ignore', fd, fd], detached: true, windowsHide: true, shell: process.platform === 'win32' });
  closeSync(fd);
  child.on('error', e => { exit = e.message; });
  child.on('exit', code => { exit ??= `exit ${code}`; });
  child.unref();
  const output = () => plain(readFileSync(file, 'utf8'));
  for (const t0 = Date.now(); Date.now() - t0 < WAIT_MS;) {
    await sleep(250);
    const url = SESSION_URL.exec(readFileSync(file, 'utf8'))?.[0]; // the raw text: the link sits inside a terminal hyperlink
    if (url) { log('remote session', url, `pid ${child.pid}`); return { url, cwd }; }
    if (exit !== null) throw httpError(500, 'session_start_failed', `claude remote-control stopped (${exit}): ${output().trim().slice(-300)}`);
  }
  child.kill();
  throw httpError(500, 'session_start_failed', `claude remote-control printed no session link within ${WAIT_MS / 1000} s`);
}

let starting = null; // a double tap joins the start that is already running
const server = http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  try {
    if (!authed(req)) return send(401, { error: 'unauthorized', code: 'unauthorized' });
    req.resume(); // no endpoint reads a body
    const route = `${req.method} ${req.url.split('?')[0]}`;
    if (route === 'GET /api/health') return send(200, { ok: true });
    if (route === 'POST /api/sessions/remote') return send(200, await (starting ??= startRemote().finally(() => { starting = null; })));
    throw httpError(404, 'not_found', 'not found');
  } catch (e) {
    log('error', req.method, req.url, e.message);
    send(e.status || 500, { error: e.message, code: e.code || 'internal' });
  }
});
server.on('error', e => die(`cannot listen on ${BIND}:${PORT}: ${e.message}`));
server.listen(PORT, BIND, () => log(`dashcall remote agent on ${BIND}:${server.address().port}`));
