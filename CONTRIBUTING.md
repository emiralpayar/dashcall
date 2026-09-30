# Contributing to Dashcall

Thanks for helping out! Bug reports, ideas, documentation fixes and pull requests are all welcome.

Please read [AGENTS.md](AGENTS.md) first. It is the full guide to the codebase: the project map, conventions and
safety rules, for people and AI coding agents alike. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

```sh
git clone https://github.com/emiralpayar/dashcall.git && cd dashcall
npm test          # 57 unit, HTTP and i18n tests, offline, silent, no dependencies
npm run check     # syntax check of every JavaScript file
npm run demo      # the app with a mock agent at http://localhost:8080 (password: demo), silent
```

You need Node.js 22 or newer. You **don't** need a Mac, herdr or Claude Code for most work:

- **UI work:** use `npm run demo`. It serves the real web app against a mock agent with fake sessions, notes and
  notifications. Check your change in both languages (the EN/TR toggle) and at phone width. The demo is silent
  (answers show as timed subtitles); run `DASHCALL_DEMO_SOUND=1 npm run demo` if you want to hear the browser voice.
- **Agent and web server work:** add tests in `test/`. The existing suites start the real servers with temp data
  folders and a fake herdr path.
- **End-to-end** testing needs a Mac with herdr and Claude Code; see [docs/INSTALL.md](docs/INSTALL.md).

## Rules of thumb

- **Automation never makes sound.** Tests, QA scripts and AI agents must stay silent on the developer's machine:
  launch headless browsers with `--mute-audio` plus an init script that stubs `speechSynthesis.speak` and
  `HTMLMediaElement.prototype.play`, never run `say` or TTS playback in tests, and use the (silent) demo for UI work.
  See [AGENTS.md](AGENTS.md#safety-rules).
- **No runtime dependencies.** Node's standard library only. Open an issue first if you think one is worth it.
- **Every UI string goes in `web/public/i18n.js`, in English and Turkish.** If you can't write the Turkish text, put
  your best attempt in and say so in the PR; a maintainer will polish it. `test/i18n.test.mjs` catches missing keys,
  mismatched `{placeholders}` and untranslated error codes.
- **Settings are environment variables**, defined only in `agent/config.mjs` or at the top of `web/server.mjs`, and
  documented in the `.env.example` files and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- **Errors follow the `{error, code}` contract** described in [docs/API.md](docs/API.md#errors).
- **Tests are required** for bug fixes and for new behaviour that can be tested without herdr or Claude.
- **Never commit personal data:** `.env` files, `dispatcher/brain/`, `state/`, `logs/`, real hostnames, IPs, names or
  tokens.
- **Security-sensitive changes** (auth, the proxy, process spawning, path checks, dispatcher flags) get extra
  scrutiny. See [SECURITY.md](SECURITY.md).

## Commits and pull requests

- Keep each PR focused on one change. Small PRs get reviewed faster.
- Write commit messages in the imperative mood, with a short summary line (about 72 characters at most) and details
  in the body if needed. For example: `Add Spanish voices to the voice picker`.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` for user-visible changes.
- Fill in the pull request template. Its checklist covers:
  - [ ] `npm test` and `npm run check` pass
  - [ ] New behaviour has tests
  - [ ] UI changes checked in demo mode, in EN and TR, at phone width
  - [ ] New UI strings are in `i18n.js` in both languages
  - [ ] Tests and scripts make no sound
  - [ ] Docs updated (API, CLI, configuration, changelog) where relevant
  - [ ] No personal data, secrets or runtime files

## Good first contributions

- More languages (see "Adding a language" in [AGENTS.md](AGENTS.md#adding-a-language)).
- Linux support for the agent (replacing macOS `say`, launchd examples for systemd).
- Narrowing the dispatcher's permissions to just the `dashcall` CLI.
- Screenshots, docs and accessibility improvements.

## Reporting bugs and security issues

Use the [issue templates](https://github.com/emiralpayar/dashcall/issues/new/choose) for bugs and feature requests.
Report security problems privately, never in a public issue: see [SECURITY.md](SECURITY.md).
