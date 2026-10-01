# AGENTS.md

Guide for AI coding agents and humans working **on** Dashcall. For what the product does, see [README.md](README.md);
for the design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **Hard rule: never make sound on the developer's machine.** Automated tests, QA scripts and AI agents must stay
> silent. Launch headless browsers with `--mute-audio` **and** an init script that stubs
> `speechSynthesis.speak` and `HTMLMediaElement.prototype.play`. Never run `say` or any TTS playback in tests. Use
> demo mode (`npm run demo`, silent by default) for UI work, and don't set `DASHCALL_DEMO_SOUND=1` in anything
> automated. Details under [Safety rules](#safety-rules).

> `dispatcher/CLAUDE.md` is **not** developer documentation. It is the runtime system prompt of the voice
> assistant. Edit it only to change the assistant's behaviour, and write it for that audience.

## Project map

```
agent/                 Mac-side HTTP API (Node, no deps)
  server.mjs           routes, dispatcher jobs, speech, background-task watcher
  dispatch.mjs         dispatcher command line, per-conversation queue, friendly limit/login errors
  config.mjs           ALL agent settings (DASHCALL_* env vars), read once at import
  lib.mjs              herdr control, transcript reading, starting sessions
  brain.mjs            memory / notes / mutes (dispatcher/brain/brain.json)
  store.mjs            notifications + watches (state/*.json)
  jsonfile.mjs         locked, atomic JSON state files (never overwrites an unreadable one)
  prompts.mjs          dispatcher system prompt + background-summary prompt
  lang.mjs             languages, locales, voices, pickLang / pickVoice
  stt-text.mjs         cleans whisper transcripts (silence hallucinations, repeats)
  errors.mjs           httpError(status, code, message), errorBody()
  bin/dashcall         CLI the dispatcher uses (also handy for debugging)
dispatcher/CLAUDE.md   runtime prompt of the dispatcher (see above)
web/                   login + static SPA + /api proxy (Node, no deps, Docker)
  server.mjs           settings at the top of the file, then everything else
  totp.mjs             one-time codes (RFC 6238) for the optional two-factor login
  public/              the SPA: index.html, app.js, subtitles.js, login.html, login.js, i18n.js, style.css,
                       manifest.webmanifest + icons (icon.svg, icon-192/512.png, icon-maskable-512.png,
                       apple-touch-icon.png)
tts/speak.py           edge-tts wrapper (MP3 + word timings)
scripts/               demo.mjs, mock-agent.mjs, check.mjs, download-model.sh (whisper + VAD models),
                       totp-secret.mjs (secret for two-factor login)
test/                  node:test suites (no herdr, Claude or network needed), helpers.mjs
  agent, web, cli      the real servers and CLI against fake claude/herdr/ffmpeg/whisper binaries or a stub agent
  app, speak, subtitles
                       the SPA in node:vm: app.js in a fake browser (DOM, fetch, mic, audio), segmented speech and
                       the subtitle helpers; nothing makes a sound
  dispatch, lib, brain, store, jsonfile, stt-text, lang, totp, i18n, mock-agent
                       tests of the matching module or script; i18n checks both string tables
docs/                  user documentation, example configs
```

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs every test (178) with Node's built-in runner. Fast, offline, silent, no herdr or Claude needed. |
| `node --test test/web.test.mjs` | Runs a single test file. |
| `npm run check` | Syntax-checks every JavaScript file (`node --check`), including `agent/bin/dashcall`. |
| `npm run demo` | Web app + mock agent at <http://localhost:8080>, password `demo`. Silent: subtitles only, no audio. Use it for all UI work. |
| `npm run agent` | The real agent (needs `.env`, herdr, Claude Code). |
| `npm run web` | The real web app (needs `web/.env`). |

CI (`.github/workflows/ci.yml`) runs `npm run check` and `npm test` on Ubuntu and macOS with Node 22. Run both before
you say you're done.

## Conventions

- **No runtime dependencies.** Node standard library only, in both servers and the SPA (no build step, no framework).
  Discuss in an issue before adding one.
- **ES modules**, Node 22+, 2-space indent, compact code that matches the surrounding style. Comments explain *why*.
- **Configuration lives in one place.** Agent settings go in `agent/config.mjs` (as `DASHCALL_*` env vars). Web
  settings go at the top of `web/server.mjs`. Never read settings from `process.env` anywhere else (the demo scripts
  in `scripts/` and the per-job `DASHCALL_JOB_ID`/`DASHCALL_CONVERSATION_ID`/`DASHCALL_LANGUAGE` the agent passes to
  the CLI are the only exceptions). When you add a setting, document
  it in `.env.example` or `web/.env.example` **and** in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **i18n: every user-facing string** lives in `web/public/i18n.js`, in **both** `en` and `tr`, with the same keys.
  Use `t('key', {vars})` in JS, or `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label` or `data-i18n-title`
  in HTML. Never hard-code UI text. English should be natural and concise. Turkish should be natural too, not a
  literal translation. `test/i18n.test.mjs` is the safety net: it fails if `en` and `tr` differ in keys or `{placeholders}`,
  if a key used in the HTML or JS is missing, or if an error code the servers can return has no `errors.<code>`.
- **The SPA is classic scripts, no modules and no build.** `index.html` loads `i18n.js`, then `subtitles.js`, then
  `app.js`; they share one global scope, so a top-level name may be declared only once (`test/subtitles.test.mjs`
  fails on a clash). The subtitle and markup helpers in `subtitles.js` are pure (no DOM), so they can be unit-tested;
  keep them that way. Car and older iOS browsers run this code:
  avoid recent syntax such as `??=`, `||=`, `&&=` and `.at()` (`test/speak.test.mjs` checks the speech code), and
  don't rely on `crypto.randomUUID`, which needs HTTPS and a recent browser.
- **Strict CSP.** No inline `<script>`, `style="…"` attributes or `on…="…"` handlers anywhere in `web/public`, not even
  in `innerHTML` templates: the CSP is `script-src 'self'; style-src 'self'`, and `test/web.test.mjs` scans for them.
  Use classes in `style.css` and `addEventListener` / `onclick` from JS.
- **State files go through `agent/jsonfile.mjs`** (`readJson`, `updateJson`, used by `brain.mjs` and `store.mjs`):
  atomic writes under a lock shared with the `dashcall` CLI, and a file that can't be parsed is never written over.
  Don't read or write `brain.json` or `state/*.json` with plain `fs` calls.
- **Error contract.** Every error response is `{"error": "<English message>", "code": "<snake_case>"}`. In the agent,
  throw `httpError(status, code, message)` from `agent/errors.mjs`; in the web app, use `fail(res, status, code, message)`.
  Reuse existing codes. For a new code, add it to [docs/API.md](docs/API.md) and add `errors.<code>` to `i18n.js` in
  both languages (the i18n test enforces the translation).
- **Server-side text is English**, including logs and messages. Text that reaches the user through speech (such as
  the failure notification) is chosen per language.
- **Tests are required** for bug fixes and for new behaviour that can be tested without herdr or Claude: HTTP
  validation, stores, parsing, language handling, and the SPA's behaviour. Use `test/helpers.mjs`:
  `startServer(script, env)` starts a server and resolves once it logs where it listens (pass `PORT: '0'` /
  `DASHCALL_PORT: '0'` for a free port, then read `.port`), and `tempDir()` gives a temp folder. Point
  `DASHCALL_STATE_DIR` and `DASHCALL_BRAIN_FILE` at a temp dir. For the SPA, `boot()` in `test/app.test.mjs` runs
  the real page scripts in a fake browser with a fake `fetch`, microphone and speech, on a fast virtual clock.
- **Documentation is part of the change.** API changes go in `docs/API.md`, CLI changes in `docs/CLI.md` (and the
  usage text in `agent/bin/dashcall`), and user-visible changes in `CHANGELOG.md` under `[Unreleased]`.

## Safety rules

These protect the maintainer's real machine and private data. Follow them strictly.

- **Never make sound.** The maintainer requires development and QA to be completely silent:
  - Headless browsers (Playwright, Puppeteer, Chrome) are launched with `--mute-audio` and an init script that stubs
    audio before any page script runs, for example:

    ```js
    await context.addInitScript(() => {
      if (window.speechSynthesis) window.speechSynthesis.speak = () => {};
      HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    });
    ```

  - Never run `say`, `afplay`, edge-tts playback or any other audio output from tests or scripts.
  - Use demo mode for UI work. The mock agent is silent: `/api/health` returns `silent: true` and `/api/speak`
    returns `{"engine": "silent", "audio": null, …}`, so the app shows timed subtitles and plays nothing (no browser
    speech, no chime). `DASHCALL_DEMO_SOUND=1` is for a human trying the demo by hand, never for automation.

- **Never commit runtime data or secrets:** `.env`, `web/.env`, `dispatcher/brain/`, `state/`, `logs/`, `research/*`,
  `models/*`. They are git-ignored; don't force-add them. No real names, hosts, IPs, home paths or tokens in code,
  tests, docs or commit messages. Use placeholders such as `100.101.102.103`, `/Users/you` or
  `dashcall.example.com`.
- **Never call the real dispatcher in tests or scripts.** No `POST /api/ask` against a real agent, and no
  `claude -p`: it spends the user's Claude usage and acts on their real sessions.
- **Never start or prompt real herdr sessions** from tests or experiments (`/api/sessions/new`, `dashcall new|task|send|keys`).
  Tests set `DASHCALL_HERDR_BIN` to a nonexistent path; keep it that way.
- **Never point tests at the real brain or state.** Always use temp dirs.
- **Security-sensitive code** needs extra care and a test: auth, cookies, one-time codes (`web/totp.mjs`), the
  proxy, the same-origin check, anything that spawns processes, path checks (`DASHCALL_WORKSPACE_ROOT`) and the
  dispatcher's flags (`dispatcherArgs` in `agent/dispatch.mjs`, tested in `test/dispatch.test.mjs`). Never give the
  dispatcher more than `Bash(dashcall:*)`, and never pass it `DASHCALL_TOKEN`. See [SECURITY.md](SECURITY.md).

## Verifying UI changes

Use demo mode. It runs the real `web/server.mjs` against `scripts/mock-agent.mjs`, which implements the whole agent
API with fake data held in memory:

1. `npm run demo`, then open <http://localhost:8080> and log in with `demo`.
2. Check every view you touched in **both languages** (EN/TR toggle), at phone width (about 390 px) and on desktop.
3. The mock `/api/ask` answers in the request's language after about 1.5 s through the normal job polling. The mock
   `/api/stt` returns a canned transcript. The mock is silent: `/api/speak` returns `engine: "silent"`, so answers
   appear as timed subtitles with no audio; that is expected.
4. If you add or change an agent endpoint, update `scripts/mock-agent.mjs` to match, so the demo keeps working.

For automated screenshots or checks, drive the demo with a headless browser, muted and with the audio stubs from
[Safety rules](#safety-rules). Don't aim tools at a real deployment.

## The dispatcher and `claudeMdExcludes`

Claude Code loads `CLAUDE.md` from the working directory and all parent directories. The dispatcher runs in
`dispatcher/`, so without precautions it would also load the root `CLAUDE.md`, which imports this file. The agent
therefore passes `--settings {"claudeMdExcludes": [<repo>/CLAUDE.md, <repo>/AGENTS.md, <repo>/.claude/CLAUDE.md]}`
to every dispatcher run, next to its permission flags (`dispatcherArgs` in `agent/dispatch.mjs`).

Consequences:

- Put contributor guidance here (or in `.claude/CLAUDE.md`), never in `dispatcher/`.
- If you move or rename these files, update that exclude list.
- Changes to `dispatcher/CLAUDE.md` change product behaviour. Keep it in English, keep trigger examples in both
  languages, keep the `[[written|spoken]]` markup rule limited to Turkish replies, and keep it in sync with the
  `dashcall` CLI, the dispatcher's permissions (only `dashcall`, one command per call) and the
  `[SYSTEM NOTICE — not written by the user]` marker in `agent/prompts.mjs`.

## Adding a language

1. Add the code to `LANGUAGES` in `agent/config.mjs`, and add a name, a locale and two edge-tts voices in
   `agent/lang.mjs`. Add a `say` voice setting.
2. Add a full string table to `web/public/i18n.js`, plus the toggle option and the speech locale.
3. Check that whisper supports the language, and add trigger examples to `dispatcher/CLAUDE.md` if useful.
4. Add tests (see `test/lang.test.mjs`; extend `test/i18n.test.mjs` so it checks the new table too) and update the
   docs.
