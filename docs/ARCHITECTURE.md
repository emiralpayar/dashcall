# Architecture

Dashcall has four parts. None of them has npm dependencies.

```
 browser (phone / car)              web/  (Linux server, Docker)              agent/  (Mac)
┌──────────────────────┐  HTTPS  ┌──────────────────────────────┐  bearer  ┌──────────────────────────────────┐
│ web/public: SPA      │────────▶│ web/server.mjs               │─────────▶│ agent/server.mjs  HTTP API       │
│ i18n, subtitles, app │         │ login, cookie, CSP, static,  │ Tailscale│  ├─ lib.mjs ── herdr CLI ───────▶ Claude Code sessions
│ mic → MediaRecorder  │◀────────│ /api/* proxy                 │◀─────────│  ├─ claude -p (dispatcher/) ─▶ dashcall CLI
│ speech playback      │         └──────────────────────────────┘          │  ├─ ffmpeg + whisper-cli (STT)   │
└──────────────────────┘                                                   │  ├─ tts/speak.py / say (TTS)     │
                                                                           │  └─ watcher: every 10 s          │
                                                                           └──────────────────────────────────┘
```

## Components

| Part | Files | Runs on | Job |
| --- | --- | --- | --- |
| **Web app** | `web/server.mjs`, `web/totp.mjs`, `web/public/` | Any server (Docker image `node:22-alpine`) | Password login (optionally with one-time codes), signed cookie, security headers, serves the single-page app, forwards `/api/*` to the agent with the bearer token. Holds no state apart from the login rate limits and the last used one-time code (in memory). |
| **Agent** | `agent/server.mjs`, `agent/dispatch.mjs`, `agent/stt-text.mjs`, `agent/lib.mjs`, `agent/brain.mjs`, `agent/store.mjs`, `agent/prompts.mjs`, `agent/lang.mjs`, `agent/errors.mjs`, `agent/config.mjs` | The Mac with your sessions | HTTP API. Talks to herdr, reads Claude Code transcripts in `~/.claude/projects`, runs the dispatcher, transcribes and synthesizes speech, watches background tasks. |
| **Dispatcher** | `dispatcher/CLAUDE.md`, `agent/bin/dashcall` | Spawned by the agent | A headless `claude -p` per question that works out what the user means and acts through the `dashcall` CLI, the only command it is allowed to run. |
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
   request. The agent accepts only WebM, Ogg, MP4 or WAV (it checks magic bytes). Silero voice activity detection
   (VAD) keeps silence and noise away from whisper, and `agent/stt-text.mjs` drops known silence hallucinations and
   repeated sentences from what whisper returns. To transcribe, the agent converts the audio to 16 kHz mono
   WAV with ffmpeg, and runs `whisper-cli -l <lang>`. Response: `{text}`.
3. **Ask.** `POST /api/ask {text, conversationId, lang, requestId}`. The agent starts a job and immediately returns
   the same view as a poll (step 5), for a new job `{id, status: "running", lang, elapsed}`. `requestId` makes the
   call safe to retry: the same ID returns the job it already started instead of asking twice, with its reply if it
   has already finished. The demo's mock agent does the same.
4. **Dispatch.** The agent spawns this command (built by `dispatcherArgs` in `agent/dispatch.mjs`), with
   `dispatcher/` as the working directory:

   ```
   claude -p <text> --output-format json --model <DASHCALL_DISPATCH_MODEL>
          --append-system-prompt <current time, reply language, research folder, brain>
          --permission-mode dontAsk --tools Bash --allowedTools "Bash(dashcall:*)" --strict-mcp-config
          --settings {"claudeMdExcludes":[...],"permissions":{"blockReadsOutsideWorkingDirectories":true}}
          [--resume <conversationId>]
   ```

   `dispatcher/CLAUDE.md` is loaded as its instructions. `agent/bin` is prepended to `PATH`, so the `dashcall` CLI is
   available, and `DASHCALL_JOB_ID`, `DASHCALL_CONVERSATION_ID` and `DASHCALL_LANGUAGE` are set. `DASHCALL_TOKEN` is
   removed from its environment: the CLI doesn't need it, and a command like `dashcall send 1 "$DASHCALL_TOKEN"`
   would pass the allow-list. The dispatcher runs
   commands like `dashcall sessions` or `dashcall send <pane> "..."` and writes a short spoken-style reply. It can't
   run anything else (see [The dispatcher's permissions](#the-dispatchers-permissions)). Runs are killed after
   5 minutes.

   **One conversation at a time.** Jobs that resume the same conversation run one after another, in order: two
   `claude -p --resume <id>` processes at once would both append to the same transcript. That happens when a
   background task finishes while the user is talking in that conversation. A job waiting its turn reports
   `status: "running"` with `queued: true`. `--resume` keeps the session ID, but the next job resumes whatever
   session ID the previous one ended in, so it would also work if Claude Code ever returned a new one. Jobs without a
   conversation never wait.
5. **Poll.** The browser polls `GET /api/ask/<id>` about every 1.2 seconds until the status is `done` or `error`.
   The response includes the reply and the `conversationId` (the Claude session ID), which the browser keeps for
   follow-ups. When Claude Code fails with a known usage-limit, login or overload message, `error` is a short
   sentence in the job's language, for example `[[Claude|klod]] kullanım limitine ulaşıldı, 14:00’te sıfırlanıyor.`,
   and Claude's original text is in `detail`.
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
   If a job of that conversation is still running, for example because the user is talking in it, the summary waits
   for it to finish.
5. That summary becomes a notification of kind `task`, titled with the watch label.

## Flow: notifications

- Every dispatcher job, whether an answer or a task summary, is appended to `state/notifications.json` with
  `{id, ts, read, jobId, kind, lang, title, q, text, error, detail, conversationId}`. `detail` is only set for the
  friendly usage-limit, login and overload errors and holds Claude's original message. The file keeps the last 200.
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
| `state/watches.json` | Agent, `dashcall` CLI | Background tasks: waiting, fired or cancelled |
| `logs/agent.log` | launchd (stdout and stderr) | Request timings and errors, including Claude Code's error messages for failed dispatcher jobs. Questions, transcripts and dispatcher output that isn't valid JSON only with `DASHCALL_LOG_CONTENT=1`. |
| `research/` | Sessions started for research | The dispatcher's default folder for research that belongs to no project |
| `~/.claude/projects/` | Claude Code | Transcripts (Dashcall only reads them, and caches their summaries in memory until a file's size or modification time changes). The dispatcher's own conversations are stored here too. |

Files are written atomically (a temporary file, flushed to disk, then a rename), and every change holds a lock file
next to the file (`<file>.lock`, containing the writer's process ID), so the agent and the CLI can both write them
safely. A lock left by a crashed process is removed as soon as that process is gone, and any lock older than 3 seconds
counts as abandoned. An update that changes nothing writes nothing. A file that isn't valid JSON, such as a
hand-edited brain with a typo, is never written over: reads treat it as empty and log a warning, and the next real
change (a new note, say) moves it to `<file>.corrupt-<time>` before starting a new one
([recovering it](TROUBLESHOOTING.md#the-brain-or-notifications-suddenly-look-empty)). `watches.json` keeps every
waiting task but only the 50 newest (by creation) fired or cancelled ones.

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

So every dispatcher run passes (next to the permission setting described below):

```
--settings {"claudeMdExcludes":["<repo>/CLAUDE.md","<repo>/AGENTS.md","<repo>/.claude/CLAUDE.md"]}
```

The dispatcher sees only `dispatcher/CLAUDE.md` (its runtime prompt) plus your user-level `~/.claude/CLAUDE.md`, and
contributors still get a normal `CLAUDE.md` at the root. This is also why `dispatcher/CLAUDE.md` must never be
treated as developer documentation.

The dispatcher's own sessions run in `dispatcher/`, so they are hidden from every session list (`isDispatcher` in
`agent/lib.mjs`) and never show up as your "jobs".

## The dispatcher's permissions

The dispatcher reads text nobody vetted: session screens, transcripts, research results and misheard speech. Any of
it can carry a prompt injection, so the dispatcher gets only what it needs, the `dashcall` CLI, and Claude Code
enforces that, whatever the model is talked into:

| Flag | Effect |
| --- | --- |
| `--permission-mode dontAsk` | Anything not allowed below is denied on the spot instead of waiting for a prompt nobody can answer. |
| `--tools Bash` | Bash is the only built-in tool: no file editing, web fetching or subagents. |
| `--allowedTools "Bash(dashcall:*)"` | Bash runs `dashcall …` commands only. |
| `--strict-mcp-config` | No MCP servers. |
| `blockReadsOutsideWorkingDirectories` (in `--settings`) | Claude Code's built-in read-only commands (`cat`, `ls`, …), which run without approval, can't read outside `dispatcher/`. |

Claude Code checks every part of a compound command on its own. Checked against Claude Code 2.1.286:

| Command | Result |
| --- | --- |
| `dashcall help`, `dashcall help \| head -3`, `dashcall help \| grep -c sessions`, `dashcall help > /dev/null` | Runs |
| `touch <file>`, `echo hi > <file>`, `sh -c '…'`, `cat /etc/hosts` | Denied |
| `dashcall help && touch <file>`, `dashcall help; touch <file>`, `dashcall help $(touch <file>)` | Denied |
| `DASHCALL_STATE_DIR=<dir> dashcall help` | Denied |

`dispatcher/CLAUDE.md` tells the dispatcher the same, so it doesn't waste turns on blocked commands.

What remains: whatever the `dashcall` CLI can do, a prompt injection can still ask for. It can type into your
sessions, press keys in them (including answering their permission prompts) and start new ones, and those sessions
run with the permissions you gave them (`DASHCALL_SESSION_COMMAND`). Allow rules in your own Claude Code settings
(`permissions.allow` in `~/.claude/settings.json`) also apply to the dispatcher, so keep broad ones out of there.

These flags need a recent Claude Code. If every answer fails with `unknown option`, run `claude update`.

`DASHCALL_DISPATCH_UNRESTRICTED=1` brings back the old `--dangerously-skip-permissions` run, with every tool and
no checks. It is unsafe; use it only to rule out the permission setup while debugging, and turn it off again.

## Security model, briefly

- **Perimeter:** the web login, with optional one-time codes (RFC 6238, `web/totp.mjs`; each code is accepted once).
  Cookies carry their issue and expiry time, are HMAC-signed with `DASHCALL_SECRET` and also cover the password, the
  TOTP secret and `DASHCALL_SESSION_EPOCH`, so changing any of these invalidates all of them ("sign out everywhere").
  They are HttpOnly, `Secure` and `SameSite=Lax`, last `DASHCALL_SESSION_DAYS` (30) days and are renewed once a day
  while the device is used. Failed logins are limited to 10 per IP and 30 across all IPs per 15 minutes. An attempt
  is counted before the request body is read, so parallel requests can't slip past either limit.
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
- **Dispatcher:** may only run the `dashcall` CLI (see [The dispatcher's permissions](#the-dispatchers-permissions)).
  **Accepted risk:** what it can do through `dashcall`, including driving your sessions. See
  [SECURITY.md](../SECURITY.md).
