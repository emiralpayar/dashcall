# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Sessions:** 1, 2, 3 and Enter buttons answer permission and menu prompts (one key at a time, so a double tap
  can't also answer the next prompt), and a finished session from the last 48 hours opens read-only with its last
  prompt and reply.
- **Home screen app:** a web app manifest and icons, so "Add to Home Screen" opens Dashcall full screen with its own
  icon (there is no offline mode).

### Changed

- **After updating, run `./scripts/download-model.sh`:** it skips the whisper model you have and fetches the new VAD
  model (under 1 MB). Without it speech-to-text still works, and the agent log says so once. The default VAD model
  needs whisper.cpp 1.8.3 or newer (`DASHCALL_WHISPER_VAD_MODEL` picks another model or `off`); a whisper-cli too
  old for the new flags is now reported as an error instead of every recording coming back empty.
- **Folder mutes match whole folder names or paths:** muting `api` no longer hides `~/rapid-x` or `~/capital`. A mute
  that relied on part of a folder name (say, `trader` for `edge-trader`) no longer matches anything, so mute again
  with the full folder name or path. Sessions report which mute hides them (`mutedBy`), and Unmute removes that exact
  key. The Sessions tab's polls are served from a transcript summary cache, and a folder named `..x` inside the
  workspace root can now be used for a new session.
- **Every device has to log in once after updating:** session cookies issued by 0.1.0 are no longer accepted. Rebuild
  the web image (`docker compose up -d --build`), because it now also contains `web/totp.mjs`.
- **Long replies start talking sooner:** a reply of more than 200 characters is synthesized in segments, so the first
  sentence can play while the rest is still being synthesized, instead of only after the whole reply's audio has
  arrived. If edge-tts fails for one segment, the agent reads that segment with macOS `say`; if a segment's request
  fails, the browser's own voice reads the rest. A reply is still read for at most about 4000 characters.
- The full-text sheet can be opened from any tab, keeps keyboard focus inside while open and returns it on close.
  The session view fits the screen, with the reply box always visible.

### Fixed

- A state file that isn't valid JSON (say, `brain.json` after a hand edit with a typo) is never written over any
  more: it reads as empty with a warning, and the next change moves it to `<file>.corrupt-<time>`. A lock left by a
  crashed `dashcall` command no longer blocks the brain and state files, and `watches.json` keeps only the 50 newest
  finished background tasks.
- **Silence no longer comes back as text:** speech-to-text runs whisper.cpp's Silero voice activity detection, so
  silence and noise never reach whisper ("Altyazı M.K.", "Thank you.", "you"). whisper also runs without non-speech
  tokens and without feeding its own text back, and the agent drops known silence hallucinations and a sentence
  sequence whisper repeated. A recording of only "thank you" now comes back empty on purpose.
- **One answer at a time per conversation:** a background-task summary and a live question in the same
  conversation no longer run two `claude -p --resume` processes on one transcript; they queue in order. `POST
  /api/ask` takes an optional `requestId`, so a retried request returns the job it already started. Usage-limit,
  login and overload errors are spoken as a short sentence in the reply's language, with Claude's text in `detail`.
- **Web app voice flow:** a question whose job the agent forgot (it restarted) stops at once with a clear message
  instead of "thinking" for 5 minutes, and every question carries a `requestId` so a retried POST can't ask twice. A
  question queued behind an earlier job of its conversation says "Waiting for the previous answer" and gets its full
  5 minutes once it runs. Errors are no longer left as unread notifications after being spoken, and the agent's
  ready-made usage-limit, login and overload sentences are spoken as is.
- **New job** waits up to 100 s for a slow session start and, on a timeout, points to **Sessions** instead of
  inviting a retry that could start the same job twice.
- Dictation and Drive mode no longer share state: one voice input runs at a time, a failed dictation is only a
  message (never a Drive **Resend**), and a dictation's upload can be cancelled from its button. Opening a
  notification while a question is being answered is refused instead of taking over the conversation, and a
  microphone that fails to start is released.

### Security

- **Optional two-factor login:** with `DASHCALL_TOTP_SECRET` set, logging in also needs the 6-digit code of an
  authenticator app (RFC 6238; each code works once). `node scripts/totp-secret.mjs` makes a secret. The web app
  refuses to start with an invalid secret.
- **Global login limit:** besides 10 failed logins per IP, at most 30 from all IPs together per 15 minutes.
- **Logins expire and can be revoked:** a login now lasts `DASHCALL_SESSION_DAYS` (30) days after the device last
  used the app, instead of a fixed year, and raising `DASHCALL_SESSION_EPOCH` signs out every device.
- The CSP no longer allows inline styles (`style-src 'self'`).
- **The dispatcher may only run the `dashcall` CLI:** it no longer runs with `--dangerously-skip-permissions`. Bash
  is its only tool and is limited to `dashcall …` commands (`--permission-mode dontAsk`, no MCP servers, no reads
  outside `dispatcher/`), and `DASHCALL_TOKEN` is removed from its environment. `DASHCALL_DISPATCH_UNRESTRICTED=1`
  brings back the old run for debugging; it is unsafe. The flags need a recent Claude Code (`claude update`).

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

[Unreleased]: https://github.com/emiralpayar/dashcall/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/emiralpayar/dashcall/releases/tag/v0.1.0
