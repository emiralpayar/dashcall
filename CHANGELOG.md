# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-01

A hardening release. The dispatcher can only run the `dashcall` CLI, the web login gets optional one-time codes and
logins that expire and can be revoked, speech-to-text no longer turns silence into words, and long answers start
playing after the first sentence.

### Upgrading from 0.1.0

1. **Mac:** `git pull`, then:
   - `claude update`. The dispatcher's new permission flags need a recent Claude Code (they were checked with
     2.1.286). With an older one, every question fails with `unknown option`.
   - `./scripts/download-model.sh`. It skips the whisper model you already have and downloads the voice activity
     detection (VAD) model (under 1 MB). The default VAD model needs whisper.cpp 1.8.3 or newer
     (`brew upgrade whisper.cpp`). Without the file, speech-to-text still works and the agent log says so once.
   - Restart the agent: `launchctl kickstart -k gui/$(id -u)/com.dashcall.agent`.
2. **Server:** `git pull`, then rebuild the web image with `docker compose up -d --build`. The image now also
   contains `web/totp.mjs`.
3. **Every device logs in once.** Cookies issued by 0.1.0, which were valid for a year, are no longer accepted. From
   now on a login lasts 30 days after the device last used the app.
4. **Folder mutes now match whole folder names.** A mute that relied on part of a folder name (for example `trader`
   for `~/code/edge-trader`) no longer matches anything. Check the muted list in the **Brain** tab, and mute again
   with the full folder name or path.
5. **New settings, all optional:** `DASHCALL_WHISPER_VAD_MODEL` and `DASHCALL_DISPATCH_UNRESTRICTED` for the agent;
   `DASHCALL_SESSION_DAYS`, `DASHCALL_SESSION_EPOCH` and `DASHCALL_TOTP_SECRET` for the web app. Compare your `.env`
   files with the `.env.example` files. Two-factor login is recommended:
   [docs/CONFIGURATION.md](docs/CONFIGURATION.md#two-factor-login).

### Security

- **The dispatcher may only run the `dashcall` CLI** ([#7]). It no longer runs with `--dangerously-skip-permissions`.
  Bash is its only tool and accepts `dashcall …` commands only (`--permission-mode dontAsk`, no MCP servers, no reads
  outside `dispatcher/`), so a prompt injection in a session's output can't run other commands on your Mac.
  `DASHCALL_TOKEN` is removed from its environment. `DASHCALL_DISPATCH_UNRESTRICTED=1` brings back the old run for
  debugging; it is unsafe. Allow rules in your own `~/.claude/settings.json` also apply to the dispatcher.
- **Optional two-factor login** ([#4]). With `DASHCALL_TOTP_SECRET` set, logging in also needs the 6-digit code of an
  authenticator app (RFC 6238; each code works once). `node scripts/totp-secret.mjs` makes a secret. A wrong password
  and a wrong code get the same answer (`bad_login`). The web app refuses to start with an invalid secret.
- **Logins expire and can be revoked** ([#4]). A login lasts `DASHCALL_SESSION_DAYS` (30) days after the device last
  used the app, instead of a fixed year; devices in use get a fresh cookie once a day. Raising
  `DASHCALL_SESSION_EPOCH` signs out every device, and so does changing the password, `DASHCALL_SECRET` or
  `DASHCALL_TOTP_SECRET`.
- **Global login limit** ([#4]). Besides 10 failed logins per IP, at most 30 from all IPs together per 15 minutes.
- **Strict CSP** ([#5]). The Content Security Policy no longer allows inline styles (`style-src 'self'`), and a test
  checks that no page or script in `web/public` needs inline styles, handlers or scripts.

### Added

- **Quick keys** ([#5]). The session view has 1, 2, 3 and Enter buttons for permission and menu prompts. They send one
  key at a time, so a double tap can't also answer the next prompt.
- **Past sessions open** ([#5]). A finished session from the last 48 hours opens read-only, with its last prompt and
  reply.
- **Home screen app** ([#5]). A web app manifest and icons, so "Add to Home Screen" opens Dashcall full screen with its
  own icon. There is no offline mode.
- **Spoken limit errors** ([#7]). When Claude Code hits a usage limit, is logged out or is overloaded, the answer is a
  short sentence in the question's language (with the reset time, if Claude gave one) instead of Claude's English
  message. The original text is kept in `detail`.
- **Safe retries of `POST /api/ask`** ([#7], [#6]). An optional `requestId` returns the job it already started instead
  of asking twice; the web app sends one with every question. `POST /api/ask` returns the same fields as a poll.
- **`mutedBy`** ([#2]) on `/api/sessions`, `/api/recent` and `dashcall sessions|recent --all`: the key of the mute
  that hides a session. The app's **Unmute** removes exactly that key.
- **Docker healthcheck** ([#3]). `docker compose ps` shows whether the web app answers on `/healthz`.
- `GET /login/config` ([#4]) tells the login page whether to ask for a one-time code.
- Tests: 178, up from 57. The single-page app now has tests too (`test/app.test.mjs` runs `app.js` in a fake
  browser), as do segmented speech, the subtitle helpers (moved to `web/public/subtitles.js`, [#3]), the
  dispatcher's command line and queue, state files, one-time codes and the transcript clean-up. All of them stay
  offline and silent.

### Changed

- **Folder mutes match whole folder names or paths** ([#2]). Muting `api` hides `~/code/api` and its subfolders, but
  no longer `~/rapid-x`, `~/capital` or `~/api-server`. See [Upgrading](#upgrading-from-010).
- **Every device has to log in once after updating** ([#4]); see [Upgrading](#upgrading-from-010).
- **Speech-to-text needs the VAD model and whisper.cpp 1.8.3 or newer for its defaults** ([#8]).
  `./scripts/download-model.sh` now also downloads the VAD model; `DASHCALL_WHISPER_VAD_MODEL` picks another one or
  `off`. A `whisper-cli` too old for the new flags is reported as an error instead of every recording coming back
  empty.
- **The dispatcher can't read your files, browse the web or run other programs itself** ([#7]). For such work it starts
  or uses a session, or says it can't.
- **One answer at a time per conversation** ([#7]). A background-task summary and a live question in the same
  conversation run one after the other. The app says "Waiting for the previous answer", and the question's 5-minute
  limit starts once it runs ([#6]).
- The full-text sheet opens from any tab, keeps keyboard focus inside while open and gives it back on close. The
  session view fits the screen, with the reply box always visible ([#5]).
- The docs use Homebrew's current formula name, `whisper.cpp` (`whisper-cpp` still works as an alias).

### Fixed

- **State files are never written over when they can't be read** ([#1]). A `brain.json` with a typo from a hand edit
  reads as empty with a warning, and the next change moves it to `<file>.corrupt-<time>` instead of replacing your
  brain. A lock left by a crashed `dashcall` command no longer blocks the brain and state files, writes are flushed to
  disk before the atomic rename, and `watches.json` keeps only the 50 newest finished background tasks.
- **Silence no longer comes back as text** ([#8]). Speech-to-text runs whisper.cpp's Silero voice activity
  detection, so silence and noise never reach whisper ("Altyazı M.K.", "Thank you.", "you"). whisper also runs
  without non-speech tokens and without feeding its own text back, and the agent drops known silence hallucinations
  and a sentence sequence whisper repeated. A recording of only "thank you" now comes back empty on purpose.
- **A question whose job the agent forgot** (it restarted) stops at once with a clear message instead of "thinking"
  for 5 minutes ([#6]). Errors are no longer left as unread notifications after being spoken.
- **New job** waits up to 100 s for a slow session start and, on a timeout, points to **Sessions** instead of
  inviting a retry that could start the same job twice ([#6]).
- **Dictation and Drive mode no longer share state** ([#6]). One voice input runs at a time, a failed dictation is
  only a message (never a Drive **Resend**), and a dictation's upload can be cancelled from its button. Opening a
  notification while a question is being answered is refused instead of taking over the conversation, and a
  microphone that fails to start is released.
- **Subtitles** ([#3], [#9]): an emoji no longer shifts the timing of later lines; a word that contains the next one
  ("this", "is") no longer swallows it; punctuation the voice reads inside a path no longer stops the alignment; and
  words are matched in the answer's language, so Turkish I/ı line up while the app is in English and the other way
  round. **Replay** now also speaks the last answer in its own language after you switch languages.
- **Sessions** ([#2]): a folder named `..x` inside the workspace root can be used for a new session, a long
  transcript keeps the title the agent already found once it scrolls out of the part the agent reads, and prompting
  a session no longer rewrites `brain.json` when it wasn't muted.
- A successful login could stay counted against the login limit, or un-count another attempt instead ([#4]).
- A sheet opened from the Sessions tab could never be seen ([#5]).

### Performance

- **Long answers start talking sooner** ([#9]). An answer of more than 200 characters is synthesized in segments: the
  first sentence plays while the rest is still being synthesized, instead of after the whole answer's audio has
  arrived (for a 584-character Turkish answer, about 29 KB to download before the first word instead of 322 KB). If
  edge-tts fails for one segment, the agent reads that segment with macOS `say`; if a segment's request fails, the
  browser's own voice reads the rest. An answer is still read for at most about 4000 characters.
- **The Sessions tab's polls are served from a transcript summary cache** ([#2]), which is checked against each
  file's size and modification time. A repeated poll drops from about 25 ms to about 0.3 ms.

## [0.1.0] - 2026-09-30

First public release.

### Added

- **Drive mode:** a big talk button. Speech is transcribed locally with whisper.cpp, a headless Claude Code
  "dispatcher" answers, and the reply is read aloud with word-synced subtitles. Recording ends after a 3.5 s pause,
  at 2 minutes, or after 12 s without speech, and a tap sends early. Typed input, replay, a per-device conversation
  history, **New chat** and resend after a failed upload. Answers are spoken in the language the question was asked in.
- **Sessions:** running Claude Code sessions (through herdr) and the last 48 hours of finished ones, a live terminal
  view, sending prompts, Esc to interrupt, and muting.
- **New job:** start a Claude Code session in a folder under `DASHCALL_WORKSPACE_ROOT` with a task, by voice or text.
  The folder picker lists the folders directly inside that root.
- **Background tasks:** `dashcall task` / `dashcall watch`. The agent watches the session and sends a spoken summary
  when it finishes, gets stuck, closes or times out after 8 hours. The session's reply is fenced with a random marker
  and treated as untrusted data in the summary prompt.
- **Notifications:** every answer and task summary is stored, with an unread badge, a popup and a chime; each one is
  read aloud in its own language, and opening one continues its conversation.
- **Brain:** persistent memory, notes and reminders, and muted sessions or projects, managed by voice, in the app, or
  with the `dashcall` CLI.
- **English and Turkish:** an in-app EN/TR switch for the UI, speech recognition, neural voices (Ava/Andrew,
  Emel/Ahmet) and dispatcher replies, with pronunciation markup for English terms in Turkish replies.
- **Phone layout:** on phones the tabs are a bottom bar within thumb reach; wide screens put Drive mode's button and
  subtitles side by side.
- **Demo mode:** `npm run demo` runs the web app against a mock agent, so no Mac is needed. It is silent: answers show
  as timed subtitles and nothing plays. `DASHCALL_DEMO_SOUND=1` opts into the browser's voice.
- **Security:** a rate-limited password login (attempts are counted before the body is read), signed HttpOnly
  cookies, same-origin checks, a strict CSP, a bearer token between the web app and the agent, a workspace root
  check, a fixed allow-list of keys (API and CLI alike), and audio format validation.
- **Consistent errors:** every error response is `{error, code}` with stable codes, translated in the app. An agent
  that rejects the web app's token is reported as `502 agent_auth` instead of logging the user out, and `internal` /
  `session_start_failed` errors show the agent's detail after the translated text.
- **Configuration** through `DASHCALL_*` environment variables plus `PORT` and `HOST` for the web app (loopback by
  default; the Docker image listens on `0.0.0.0`, and Compose publishes `PORT` on `127.0.0.1` only). `PORT=0` /
  `DASHCALL_PORT=0` pick a free port, a trailing slash in `DASHCALL_AGENT_URL` is ignored, and both servers exit with
  `cannot listen on …` when they can't open their port. Includes a Docker Compose file, a Caddy example and a launchd
  example.
- **Docs:** installation from zero, configuration, architecture, API, CLI and troubleshooting, with screenshots in
  English and Turkish.
- **Tests:** 57 tests on Node's built-in runner with no dependencies, including `test/i18n.test.mjs` (both languages
  have the same keys and placeholders, every used key exists, every server error code is translated). Tests and the
  demo never make sound. CI runs them on Ubuntu and macOS.

[Unreleased]: https://github.com/emiralpayar/dashcall/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/emiralpayar/dashcall/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/emiralpayar/dashcall/releases/tag/v0.1.0
[#1]: https://github.com/emiralpayar/dashcall/pull/1
[#2]: https://github.com/emiralpayar/dashcall/pull/2
[#3]: https://github.com/emiralpayar/dashcall/pull/3
[#4]: https://github.com/emiralpayar/dashcall/pull/4
[#5]: https://github.com/emiralpayar/dashcall/pull/5
[#6]: https://github.com/emiralpayar/dashcall/pull/6
[#7]: https://github.com/emiralpayar/dashcall/pull/7
[#8]: https://github.com/emiralpayar/dashcall/pull/8
[#9]: https://github.com/emiralpayar/dashcall/pull/9
