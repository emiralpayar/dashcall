# Architecture

Dashcall has four parts. None of them has npm dependencies.

```
 browser (phone / car)              web/  (Linux server, Docker)              agent/  (Mac)
┌──────────────────────┐  HTTPS  ┌──────────────────────────────┐  bearer  ┌──────────────────────────────────┐
│ web/public: SPA      │────────▶│ web/server.mjs               │─────────▶│ agent/server.mjs  HTTP API       │
│ i18n.js, app.js      │         │ login, cookie, CSP, static,  │ Tailscale│  ├─ lib.mjs ── herdr CLI ───────▶ Claude Code sessions
│ mic → MediaRecorder  │◀────────│ /api/* proxy                 │◀─────────│  ├─ claude -p (dispatcher/) ─▶ dashcall CLI
│ speech playback      │         └──────────────────────────────┘          │  ├─ ffmpeg + whisper-cli (STT)   │
└──────────────────────┘                                                   │  ├─ tts/speak.py / say (TTS)     │
                                                                           │  └─ watcher: every 10 s          │
                                                                           └──────────────────────────────────┘
```

## Components

| Part | Files | Runs on | Job |
| --- | --- | --- | --- |
| **Web app** | `web/server.mjs`, `web/public/` | Any server (Docker image `node:22-alpine`) | Password login, signed cookie, security headers, serves the single-page app, forwards `/api/*` to the agent with the bearer token. Holds no state apart from the login rate limit. |
| **Agent** | `agent/server.mjs`, `agent/lib.mjs`, `agent/brain.mjs`, `agent/store.mjs`, `agent/prompts.mjs`, `agent/lang.mjs`, `agent/errors.mjs`, `agent/config.mjs` | The Mac with your sessions | HTTP API. Talks to herdr, reads Claude Code transcripts in `~/.claude/projects`, runs the dispatcher, transcribes and synthesizes speech, watches background tasks. |
| **Dispatcher** | `dispatcher/CLAUDE.md`, `agent/bin/dashcall` | Spawned by the agent | A headless `claude -p` per question that works out what the user means and acts through the `dashcall` CLI. |
| **TTS helper** | `tts/speak.py` | Spawned by the agent | Calls edge-tts and returns MP3 audio plus word timings for synced subtitles. |

The single-page app has five views: **Drive** (talk button, subtitles, typed input), **Sessions** (live and recent
sessions, terminal view, prompt, Esc, mute), **New job**, **Brain** (notes, memory, muted) and **Notifications**. On
wide screens the tabs sit in the header; on phones they become a bottom bar within thumb reach. All UI strings live in
`web/public/i18n.js` in English and Turkish, and `test/i18n.test.mjs` checks that both languages stay complete.

### Why herdr?

The agent needs to list running Claude Code sessions, know whether each one is working, idle or blocked, read its
screen, type into it and press keys. herdr provides all of that through a JSON command line (`herdr agent list`,
`agent read`, `agent prompt`, `agent send-keys`, `workspace create`, `pane run` and so on). Transcripts give the
rest: the title, the last user prompt and the last assistant message.

## Flow: a voice question, end to end

1. **Record.** The user taps the talk button. The browser records with `MediaRecorder`. Recording stops after about
   3.5 seconds of silence, at 2 minutes, when the user taps again, or after 12 seconds if no speech is heard at all.
2. **Transcribe.** `POST /api/stt?lang=en` with the raw audio body. The web app checks the cookie and forwards the
   request. The agent accepts only WebM, Ogg, MP4 or WAV (it checks magic bytes), converts the audio to 16 kHz mono
   WAV with ffmpeg, and runs `whisper-cli -l <lang>`. Response: `{text}`.
3. **Ask.** `POST /api/ask {text, conversationId, lang}`. The agent starts a job and immediately returns
   `{id, status: "running"}`.
4. **Dispatch.** The agent spawns this command, with `dispatcher/` as the working directory:

   ```
   claude -p <text> --output-format json --dangerously-skip-permissions --model <DASHCALL_DISPATCH_MODEL>
          --append-system-prompt <current time, reply language, research folder, brain>
          --settings {"claudeMdExcludes":[...]}  [--resume <conversationId>]
   ```

   `dispatcher/CLAUDE.md` is loaded as its instructions. `agent/bin` is prepended to `PATH`, so the `dashcall` CLI is
   available, and `DASHCALL_JOB_ID`, `DASHCALL_CONVERSATION_ID` and `DASHCALL_LANGUAGE` are set. The dispatcher runs
   commands like `dashcall sessions` or `dashcall send <pane> "..."` and writes a short spoken-style reply. Runs are
   killed after 5 minutes.
5. **Poll.** The browser polls `GET /api/ask/<id>` about every 1.2 seconds until the status is `done` or `error`.
   The response includes the reply and the `conversationId` (the Claude session ID), which the browser keeps for
   follow-ups.
6. **Notify.** Every finished job is also saved as a notification. If the page was closed, the answer is waiting in
   the **Notifications** view.
7. **Speak.** `POST /api/speak {text, voice, lang}`. `tts/speak.py` returns MP3 audio and word boundaries. The app
   plays the audio and highlights subtitles word by word. If edge-tts fails, the agent uses macOS `say` with the
   language's voice (no word timings). If `/api/speak` itself fails, the browser uses its own `speechSynthesis`.
   **Silent mode:** the mock agent behind `npm run demo` reports `silent: true` from `/api/health` and answers
   `/api/speak` with `engine: "silent"`. The app then runs the subtitles on a timer and makes no sound at all (no
   audio, no `speechSynthesis`, no chime). `DASHCALL_DEMO_SOUND=1` turns the browser voice back on for the demo.

For Turkish replies, the dispatcher writes English terms as `[[written|spoken]]`, for example `[[PR|pi ar]]`. The app
shows the written part in subtitles and sends the spoken part to the voice.

## Flow: background tasks (watches)

A *watch* is a record in `state/watches.json` that says "tell the user when this session finishes".

1. The user says, for example, "research the best way to do X and let me know". The dispatcher runs
   `dashcall task <dir> "<prompt>"`, which starts a new session and creates a watch, or
   `dashcall watch <pane> "<label>"` for an existing session. The watch stores the pane, folder, label, Claude session
   ID, `DASHCALL_JOB_ID`, `DASHCALL_CONVERSATION_ID` and `DASHCALL_LANGUAGE`.
2. The dispatcher replies right away ("Started; the result will come as a notification") and the job ends. If the
   conversation was new, its ID is now written into the watch.
3. Every 10 seconds, the agent's watcher runs `herdr pane list` and checks each waiting watch. It fires when:

   | Reason | Condition |
   | --- | --- |
   | `done` | Idle for 2 polls in a row, after having been seen working (or after 90 seconds) |
   | `blocked` | Blocked, for example at a permission prompt, for 2 polls in a row |
   | `closed` | The pane is gone or no longer runs Claude |
   | `timeout` | Still not finished after 8 hours |

4. On firing, the agent reads the session's last assistant message from its transcript and runs the dispatcher again
   in the original conversation. The message starts with `[SYSTEM NOTICE — not written by the user]` and asks for a
   1 to 3 sentence summary in the watch's language. The session's reply is untrusted, so it is quoted between two
   lines holding a random marker (`<<<…>>>`, new for every summary), and the prompt says never to follow
   instructions inside it. The session's text can't fake the end of the quote because it can't guess the marker.
5. That summary becomes a notification of kind `task`, titled with the watch label.

## Flow: notifications

- Every dispatcher job, whether an answer or a task summary, is appended to `state/notifications.json` with
  `{id, ts, read, jobId, kind, lang, title, q, text, error, conversationId}`. The file keeps the last 200.
- The browser polls `GET /api/notifications` (the last 100, newest first, plus the unread count) to update the badge.
  When a new unread notification arrives that the page isn't already delivering, such as a background result or an
  answer to a question asked before the page was closed, it plays a chime (not in silent mode) and shows a popup with
  **Listen** and **Later**. Returning to the app pops up the most recent unread one.
- **Listen** reads a notification aloud in its own language (its `lang` field), whatever the UI language is now.
  Likewise, an answer is spoken in the language the question was asked in, even if the user switches meanwhile.
- Once the browser has shown or spoken a notification, it marks it read with `POST /api/notifications/read`.
- Opening a notification continues its conversation, so "tell me more" has context.

## Data files and privacy

Everything personal stays on the Mac, inside the repo folder, and is git-ignored.

| Path | Written by | Contents |
| --- | --- | --- |
| `dispatcher/brain/brain.json` (`DASHCALL_BRAIN_FILE`) | Agent, `dashcall` CLI | `{memory[], notes[], muted[]}`: facts about you, your notes and reminders, muted sessions and projects |
| `state/notifications.json` (`DASHCALL_STATE_DIR`) | Agent | The last 200 answers and summaries, including your questions |
| `state/watches.json` | Agent, `dashcall` CLI | Background tasks: every waiting one, plus the 50 newest (by creation) fired or cancelled |
| `logs/agent.log` | launchd (stdout and stderr) | Request timings and errors. Questions and transcripts only with `DASHCALL_LOG_CONTENT=1`. |
| `research/` | Sessions started for research | The dispatcher's default folder for research that belongs to no project |
| `~/.claude/projects/` | Claude Code | Transcripts (Dashcall only reads them). The dispatcher's own conversations are stored here too. |

Files are written atomically (a temporary file, flushed to disk, then a rename), and every change holds a lock file
next to the file (`<file>.lock`, containing the writer's process ID), so the agent and the CLI can both write them
safely. A lock left by a crashed process is removed as soon as that process is gone, and any lock older than 3 seconds
counts as abandoned. A file that isn't valid JSON, such as a hand-edited brain with a typo, is never written over:
reads treat it as empty and log a warning, and the next change moves it to `<file>.corrupt-<time>` before starting a
new one ([recovering it](TROUBLESHOOTING.md#the-brain-or-notifications-suddenly-look-empty)).

What leaves the Mac:

- Replies and screen contents go to the web app and your browser.
- The dispatcher's prompts go to Anthropic, like any Claude Code use.
- Text to be spoken goes to Microsoft's Edge text-to-speech service when edge-tts is used. Pick the **local** voice to
  keep it on the Mac.
- Speech-to-text runs locally with whisper.cpp. Audio never leaves your Mac.

The web server stores nothing on disk.

## The `claudeMdExcludes` trick

Claude Code loads `CLAUDE.md` files from the working directory **and every parent directory**. The dispatcher runs in
`dispatcher/`, so it would also load the repo's root `CLAUDE.md`. That file imports `AGENTS.md`, the guide for people
and coding agents working *on* Dashcall. A voice assistant has no use for build commands and code conventions, and the
extra text would cost tokens on every question and could change its behaviour.

So every dispatcher run passes:

```
--settings {"claudeMdExcludes":["<repo>/CLAUDE.md","<repo>/AGENTS.md","<repo>/.claude/CLAUDE.md"]}
```

The dispatcher sees only `dispatcher/CLAUDE.md` (its runtime prompt) plus your user-level `~/.claude/CLAUDE.md`, and
contributors still get a normal `CLAUDE.md` at the root. This is also why `dispatcher/CLAUDE.md` must never be
treated as developer documentation.

The dispatcher's own sessions run in `dispatcher/`, so they are hidden from every session list (`isDispatcher` in
`agent/lib.mjs`) and never show up as your "jobs".

## Security model, briefly

- **Perimeter:** the web login. Cookies are HMAC-signed with `DASHCALL_SECRET` and include a hash of the password,
  so changing the password invalidates all of them. They are HttpOnly, `Secure` and `SameSite=Lax`, and last one
  year. Logins are limited to 10 attempts per 15 minutes per IP. An attempt is counted before the request body is
  read, so parallel requests can't slip past the limit.
- **CSRF:** non-GET API calls and the login must be same-origin (checked with `Sec-Fetch-Site` and `Origin` against
  `Host`).
- **Headers:** a strict CSP without inline scripts, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and
  microphone access for the page itself only.
- **Web app to agent:** the web app listens on `127.0.0.1` by default (`HOST`). If the agent rejects its token, the
  browser gets `502 agent_auth`, not a `401`, so a server misconfiguration never looks like an expired login.
- **Agent:** reachable only on a private address, with a constant-time bearer token check. The request body limit is
  25 MB for audio and 1 MB for JSON, and audio is checked by magic bytes before ffmpeg sees it.
- **Sessions:** new jobs only start under `DASHCALL_WORKSPACE_ROOT` (checked with real paths). Keys sent to a session
  come from a fixed allow-list.
- **Accepted risk:** the dispatcher runs with `--dangerously-skip-permissions`. See [SECURITY.md](../SECURITY.md).
