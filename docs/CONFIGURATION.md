# Configuration

Dashcall is configured only through environment variables:

- **Agent** (Mac): read once at startup by [`agent/config.mjs`](../agent/config.mjs). `npm run agent` loads them from
  `.env` in the repo root. Template: [`.env.example`](../.env.example).
- **Web app** (server): read at the top of [`web/server.mjs`](../web/server.mjs). `docker compose` and `npm run web`
  load them from `web/.env`. Template: [`web/.env.example`](../web/.env.example).

Restart the process after changing a value. An empty value counts as unset.

## Agent

Relative paths are resolved against the repo root. Binary settings accept a bare command name, which is looked up on
`PATH`, or a path.

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `DASHCALL_TOKEN` | none | **yes** | Bearer token every request must carry. Must equal `DASHCALL_AGENT_TOKEN` on the web side. Use at least 32 random characters (`openssl rand -hex 32`); shorter values log a warning. The agent exits if it is missing. |
| `DASHCALL_BIND` | `127.0.0.1` | no | Address to listen on. Set it to the Mac's Tailscale IP (`tailscale ip -4`) so the web server can reach it. Never bind to a public interface. |
| `DASHCALL_PORT` | `7420` | no | Port to listen on. `0` picks a free port (the log line shows which). If the agent can't listen on `DASHCALL_BIND`:`DASHCALL_PORT` (for example `EADDRNOTAVAIL` or `EADDRINUSE`), it prints `cannot listen on …` and exits with status 1. |
| `DASHCALL_DEFAULT_LANGUAGE` | `en` | no | `en` or `tr`. Used when a request carries no valid `lang`. Any other value falls back to `en`. |
| `DASHCALL_DISPATCH_MODEL` | `sonnet` | no | Model for the dispatcher, passed to `claude -p --model`. Any value Claude Code accepts, such as `sonnet`, `opus` or a full model ID. |
| `DASHCALL_DISPATCH_UNRESTRICTED` | off | no | **Unsafe.** `1` runs the dispatcher with `--dangerously-skip-permissions` and every tool, the way Dashcall 0.1.0 did. By default it may only run the `dashcall` CLI, so a prompt injection in a session's output can't run other commands on your Mac (see [ARCHITECTURE.md](ARCHITECTURE.md#the-dispatchers-permissions)). Only for debugging the permission setup. The agent logs a warning at startup while it is on. |
| `DASHCALL_SESSION_COMMAND` | `claude` | no | Command typed into a new herdr pane to start a Claude Code session. `claude` asks for permissions, so unattended background tasks wait at the first prompt. `claude --dangerously-skip-permissions` runs them unattended; read [SECURITY.md](../SECURITY.md) first. |
| `DASHCALL_WORKSPACE_ROOT` | your home directory | no | New sessions may only start in folders under this directory. Symlinks are resolved before the check. The folder picker (`/api/dirs`, `dashcall dirs`) lists the folders directly inside it. The repo's own `research/` folder, where the dispatcher runs background research, is always allowed. |
| `DASHCALL_WHISPER_MODEL` | `models/ggml-large-v3-turbo-q5_0.bin` | no | whisper.cpp model file for speech-to-text. `./scripts/download-model.sh [file]` downloads it. |
| `DASHCALL_WHISPER_VAD_MODEL` | `models/ggml-silero-v6.2.0.bin` | no | Silero voice activity detection (VAD) model for whisper.cpp. whisper only gets the parts of a recording that contain speech, so silence and background noise can't come back as made-up text such as "Altyazı M.K." or "Thank you.". `./scripts/download-model.sh` downloads it into `models/`. If the file is missing, the agent transcribes without VAD and logs that once. `off` turns VAD off. The v6.2.0 model needs whisper.cpp 1.8.3 or newer; with 1.7.6 to 1.8.2 use `ggml-silero-v5.1.2.bin` (`./scripts/download-model.sh ggml-large-v3-turbo-q5_0.bin ggml-silero-v5.1.2.bin`). |
| `DASHCALL_SAY_VOICE_EN` | `Samantha` | no | macOS `say` voice for English. Used when the user picks the "local" voice or edge-tts fails. List voices with `say -v '?'`. |
| `DASHCALL_SAY_VOICE_TR` | `Yelda` | no | macOS `say` voice for Turkish. |
| `DASHCALL_BRAIN_FILE` | `dispatcher/brain/brain.json` | no | The dispatcher's memory, notes and muted list. Private; git-ignored. |
| `DASHCALL_STATE_DIR` | `state` | no | Folder for `notifications.json` and `watches.json`. Private; git-ignored. |
| `DASHCALL_LOG_CONTENT` | off | no | `1` also logs questions and transcripts to stdout, and the output of a dispatcher run that didn't return valid JSON. Off by default because they are private. Claude Code's error messages (for example a usage limit) are always logged. |
| `DASHCALL_CLAUDE_BIN` | `claude` | no | Claude Code binary. |
| `DASHCALL_HERDR_BIN` | `herdr` | no | herdr binary. |
| `DASHCALL_FFMPEG_BIN` | `ffmpeg` | no | ffmpeg binary. Used for speech-to-text and for the `say` fallback. |
| `DASHCALL_WHISPER_BIN` | `whisper-cli` | no | whisper.cpp command-line binary (Homebrew's `whisper-cpp` installs `whisper-cli`). |
| `DASHCALL_TTS_PYTHON` | `tts/.venv/bin/python` | no | Python with `edge-tts` installed. If it is missing or fails, the agent falls back to macOS `say`. |
| `TZ` | system time zone | no | Time zone for the current time given to the dispatcher, which it uses to resolve "tomorrow", "in an hour" and so on. For example `Europe/Istanbul`. |

The agent adds `/opt/homebrew/bin` and `/usr/local/bin` to its own `PATH`, because launchd starts it with a minimal
one. Other locations, such as `~/.local/bin` for `claude` or `herdr`, must be in the LaunchAgent's `PATH` or set with
the `*_BIN` variables above.

### Set by the agent for the dispatcher

You don't set these. The agent passes them to each dispatcher run, and the `dashcall` CLI reads them.

| Variable | Meaning |
| --- | --- |
| `DASHCALL_JOB_ID` | ID of the dispatcher job. Stored on background watches the job creates. |
| `DASHCALL_CONVERSATION_ID` | Conversation (Claude session) the job belongs to, so a background result is reported back into it. |
| `DASHCALL_LANGUAGE` | `en` or `tr`. Stored on background watches, so their summary is in the same language. |

## Web app

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `DASHCALL_PASSWORD` | none | **yes** | Login password. Anyone who knows it can run commands on your Mac. Values under 12 characters log a warning. Changing it signs out every device. |
| `DASHCALL_SECRET` | none | **yes** | Key for signing session cookies (`openssl rand -hex 32`). Values under 32 characters log a warning. Changing it signs out every device. |
| `DASHCALL_AGENT_URL` | none | **yes** | Base URL of the agent, for example `http://100.101.102.103:7420`. Trailing slashes are removed. |
| `DASHCALL_AGENT_TOKEN` | none | **yes** | Must equal the agent's `DASHCALL_TOKEN`. |
| `PORT` | `8080` | no | Port to listen on. `0` picks a free port. With Docker, `web/docker-compose.yml` reads it from `web/.env` and publishes the same port on `127.0.0.1` only (`127.0.0.1:${PORT:-8080}:${PORT:-8080}`), so point your reverse proxy at that port. If the port can't be used, the app prints `cannot listen on …` and exits with status 1. |
| `HOST` | `127.0.0.1` | no | Address to listen on. The default only accepts connections from the same machine, which is what a reverse proxy on the same server needs. The Docker image sets `HOST=0.0.0.0` so the published port works; Compose still publishes it on `127.0.0.1` only. |
| `DASHCALL_TRUST_PROXY` | off | no | `1` takes the client IP for the login rate limit from the last `X-Forwarded-For` entry. Set it only behind a reverse proxy that adds that header; without one, clients could fake their IP. `web/docker-compose.yml` sets it to `1`. |
| `DASHCALL_COOKIE_SECURE` | on | no | `0` drops the `Secure` flag from the session cookie so login works over plain `http://`. Only for local development and the demo. |
| `DASHCALL_SESSION_DAYS` | `30` | no | How many days a login lasts after the device last used the app. Any number above 0 and up to 400 (browsers don't keep cookies longer). Lowering it also shortens existing logins. See [Staying logged in](#staying-logged-in-and-signing-out-everywhere). |
| `DASHCALL_SESSION_EPOCH` | `0` | no | Part of every session cookie's signature. Change it, for example from `0` to `1`, and restart to **sign out every device**. |
| `DASHCALL_TOTP_SECRET` | none | no | Turns on [two-factor login](#two-factor-login): the base32 secret your authenticator app uses (at least 16 characters; spaces and case don't matter). Make one with `node scripts/totp-secret.mjs`. Setting, changing or removing it signs out every device. The web app refuses to start if the value isn't valid base32. |

The web app exits at startup and lists the missing variables if any required one is unset. It also exits if
`DASHCALL_SESSION_DAYS` or `DASHCALL_TOTP_SECRET` has an invalid value.

### Staying logged in and signing out everywhere

A login is a signed, HttpOnly cookie. It stays valid for `DASHCALL_SESSION_DAYS` (30) days, and every device that
uses the app gets a renewed cookie at most once a day. So a phone or a car that opens Dashcall at least once a month
never has to log in again, and a device you stopped using is logged out after a month.

To **sign out everywhere**, for example after losing a phone, raise `DASHCALL_SESSION_EPOCH` (`0` → `1` → `2` …) in
`web/.env` and restart the web app (`docker compose up -d`). Every cookie issued before is rejected, and each device
has to log in again. Changing `DASHCALL_PASSWORD`, `DASHCALL_SECRET` or `DASHCALL_TOTP_SECRET` has the same effect.

Failed logins are limited to 10 per client IP and 30 in total (from all IPs together) per 15 minutes. After that the
app answers `rate_limited` until the window passes; the global limit means that during an attack from many addresses
nobody can log in for a while, but devices that are already logged in keep working.

### Two-factor login

With `DASHCALL_TOTP_SECRET` set, logging in needs the password **and** the 6-digit code from an authenticator app
(Google Authenticator, 1Password, Authy, Bitwarden and others; RFC 6238, SHA-1, 30-second codes). The login page shows
the code field on its own.

1. Generate a secret on any machine with Node 22, such as your Mac, in the repo:
   `node scripts/totp-secret.mjs dashcall.example.com` (the argument is the account name the app shows). With only
   Docker on the server, run it from the repo root as
   `docker run --rm -v "$PWD:/repo:ro" -w /repo node:22-alpine node scripts/totp-secret.mjs`.
2. Add it to the authenticator app: scan a QR code of the printed `otpauth://` URI (for example
   `qrencode -t ansiutf8 '<uri>'`), or type in the secret.
3. Put the printed `DASHCALL_TOTP_SECRET=…` line in `web/.env` and restart the web app.

Each code works once: logging in on a second device within the same 30 seconds needs the next code. The server's
clock must be right (within about 30 seconds), because codes are accepted for the current 30-second step and one step
either side. A wrong password and a wrong code get the same answer (`bad_login`), so the password can't be guessed on
its own, and failed codes count toward the login limits. Only the web app's log tells the two apart: `login failed
(right password, wrong code)` means someone knows your password, so change it.

## Demo mode

`npm run demo` starts the web app and the mock agent (`scripts/mock-agent.mjs`) with a random token, password `demo`
and `DASHCALL_COOKIE_SECURE=0`. You don't need a `.env` file.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port of the demo web app (on `127.0.0.1`). The mock agent always gets a free local port. |
| `DASHCALL_DEMO_SOUND` | off | The demo is **silent** by default: the mock agent reports `silent: true` from `/api/health` and answers `/api/speak` with `engine: "silent"`, so the app shows the subtitles on a timer and makes no sound at all (no voice, no browser speech, no notification chime). `1` opts into sound: `/api/speak` then fails and the app reads answers with the browser's built-in voice. Example: `DASHCALL_DEMO_SOUND=1 npm run demo`. |

## Browser settings

The app keeps a few per-device values in the browser's `localStorage`. They never leave the device, but the history
contains your recent questions and answers, so anyone with access to the device can read them.

| Key | Meaning |
| --- | --- |
| `lang` | `en` or `tr`. On the first visit, `tr` if the browser language starts with `tr`, otherwise `en`. |
| `voice.en`, `voice.tr` | Chosen voice per language: a neural voice name or `local`. |
| `conversationId` | The current dispatcher conversation. **New chat** clears it. |
| `history` | The last 30 questions and answers of the current conversation, shown under **History** in Drive mode. **New chat** clears it. |
| `lastReply` | The last spoken answer, for the repeat button in Drive mode. |
