# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
