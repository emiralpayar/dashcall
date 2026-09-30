# HTTP API

There are two HTTP servers:

- The **agent** (on the Mac) implements the API. Every request needs `Authorization: Bearer <DASHCALL_TOKEN>`.
- The **web app** handles login and forwards `/api/*` to the agent unchanged (same path, query and body). It adds the
  bearer token and has a 120-second timeout.

Browsers only talk to the web app. The agent API is also handy for scripts on your Tailscale network, for example:

```sh
curl -H "Authorization: Bearer $DASHCALL_TOKEN" http://100.101.102.103:7420/api/sessions
```

JSON bodies are limited to 1 MB, and audio bodies to 25 MB.

## Errors

Every error response, from both servers, is JSON:

```json
{ "error": "text required", "code": "text_required" }
```

`error` is a short English message for people. `code` is stable; clients should branch on it. The app shows a
translated message for known codes (`errors.<code>` in `web/public/i18n.js`) and falls back to `error` otherwise.

### Agent error codes

| Code | Status | When |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or wrong bearer token |
| `not_found` | 404 | Unknown route, or an unknown note ID or brain key |
| `bad_path` | 400 | The URL path could not be decoded |
| `invalid_json` | 400 | The body is not valid JSON |
| `too_large` | 413 | The body is over the limit |
| `text_required` | 400 | `text` is missing or empty |
| `key_required` | 400 | `key` is missing or empty |
| `bad_keys` | 400 | `keys` is not an array of allowed key names |
| `bad_conversation_id` | 400 | `conversationId` is not a UUID |
| `unsupported_audio` | 415 | The audio is not WebM, Ogg, MP4/M4A or WAV |
| `unknown_job` | 404 | Unknown or expired dispatcher job (jobs are kept for 1 hour) |
| `folder_not_found` | 400 | `cwd` is missing or not a directory |
| `folder_outside_root` | 400 | `cwd` is outside `DASHCALL_WORKSPACE_ROOT` |
| `session_start_failed` | 500 | herdr couldn't create the pane, or Claude Code didn't become ready within 60 s |
| `internal` | 500 | Anything else, for example a herdr, ffmpeg or whisper failure. `error` carries a short reason. |

### Web error codes

| Code | Status | When |
| --- | --- | --- |
| `login_required` | 401 | `/api/*` without a valid session cookie |
| `bad_password` | 401 | Wrong password at `/login` |
| `rate_limited` | 429 | More than 10 login attempts from one IP in 15 minutes |
| `cross_origin` | 403 | A login or non-GET API call that isn't same-origin |
| `too_large` | 413 | The body is over 25 MB |
| `agent_unreachable` | 502 | The agent didn't answer: it's down or unreachable, or the 120 s timeout passed |
| `agent_auth` | 502 | The agent answered `401`: `DASHCALL_AGENT_TOKEN` doesn't match the agent's `DASHCALL_TOKEN`. Returned as 502 so the browser isn't logged out; the web app logs `agent rejected DASHCALL_AGENT_TOKEN`. |
| `internal` | 500 | Unexpected error in the web app |

Other errors from the agent pass through the web app unchanged. For `internal` and `session_start_failed`, the app
shows the translated text followed by the agent's `error` detail (for example which binary is missing).

## Languages

`lang` is `en` or `tr`. When it's missing or invalid, the agent uses `DASHCALL_DEFAULT_LANGUAGE`.

## Agent endpoints

### Health

#### `GET /api/health`

Returns `{"ok": true}`. Use it to check the token and reachability. The mock agent used by `npm run demo` returns
`{"ok": true, "silent": true}`; `silent` tells the app to play no audio at all (see [Speech](#speech)).

### Sessions

#### `GET /api/sessions`

The Claude Code sessions running in herdr, without the dispatcher's own sessions.

```json
{ "sessions": [ {
  "pane": "<pane id>", "name": null, "agent": "claude", "status": "working",
  "cwd": "/Users/you/code/api", "workspace": "api", "title": "Fix flaky tests",
  "sessionId": "0f8c…", "lastUser": "…", "lastAssistant": "…", "lastTs": "2026-09-29T08:12:00.000Z", "muted": false
} ] }
```

`status` is herdr's agent status: `working`, `idle`, `blocked` or `done`. `lastUser` is clipped to 600 characters
and `lastAssistant` to 1500. `muted` means a brain mute matches the session.

#### `GET /api/recent?hours=48`

Sessions whose transcripts changed in the last `hours` (default 48, up to 30 results), including finished ones. The
dispatcher's own sessions are left out, as in `/api/sessions`. Each item has `sessionId`, `title`, `cwd`, `lastUser`, `lastAssistant`, `lastTs`, `mtime` and `muted`.

#### `GET /api/sessions/:pane/screen?lines=200`

The recent terminal output of a pane: `{"text": "…"}`. `lines` defaults to 200.

#### `POST /api/sessions/:pane/prompt`

Body `{"text": "run the tests again"}`. Types the text into the session and submits it. This also unmutes the
session. Returns `{"ok": true}`. Errors: `text_required`.

#### `POST /api/sessions/:pane/keys`

Body `{"keys": ["esc"]}`. Sends keys in order. Allowed keys: `esc`, `enter`, `ctrl+c`, `up`, `down`, `tab`,
`shift+tab`, `1`, `2`, `3`. Returns `{"ok": true}`. Errors: `bad_keys`.

#### `POST /api/sessions/new`

Body `{"cwd": "~/code/api", "prompt": "Add a health endpoint", "label": "health"}`. Only `cwd` is required; `~` is
expanded.

Starts a new herdr workspace in `cwd`, runs `DASHCALL_SESSION_COMMAND`, accepts the "trust this folder" prompt if it
appears, waits until Claude Code is ready (up to 60 s), then sends `prompt`. Returns `{"pane": "…", "cwd": "…"}`.
Errors: `folder_not_found`, `folder_outside_root`, `session_start_failed`.

#### `GET /api/dirs`

Folders directly under `DASHCALL_WORKSPACE_ROOT` (default: your home directory), most recently modified first. System folders such as Library, Documents
and Downloads are skipped, as are hidden folders. Returns `{"dirs": [{"name", "path", "mtime"}]}`.

### Dispatcher

#### `POST /api/ask`

Body `{"text": "what are my sessions doing?", "conversationId": "…", "lang": "en"}`. Only `text` is required.
`conversationId` must be the UUID returned by an earlier job; omit it to start a new conversation.

Starts a dispatcher job and returns immediately: `{"id": "<job id>", "status": "running"}`. Errors: `text_required`,
`bad_conversation_id`.

#### `GET /api/ask/:id`

Poll a job:

```json
{ "id": "…", "status": "done", "lang": "en", "reply": "Two sessions are working…",
  "conversationId": "…", "notificationId": "…", "elapsed": 8123 }
```

`status` is `running`, `done` or `error`. Fields without a value are left out: while the job is running there is no
`reply`, `conversationId` or `notificationId`, and `error` (a short reason) is only present when `status` is `error`. Jobs time out after 5 minutes and are forgotten after 1 hour. Errors:
`unknown_job`.

### Speech

#### `POST /api/stt?lang=en`

The body is raw audio, as the browser records it (WebM, Ogg, MP4/M4A or WAV; up to 25 MB), with a matching
`Content-Type`. Transcribes it with whisper.cpp in the given language and returns `{"text": "…"}`. Errors:
`unsupported_audio`, `too_large`, `internal` (ffmpeg or whisper failed, for example because the model is missing).

#### `POST /api/speak`

Body `{"text": "…", "voice": "en-US-AvaNeural", "rate": "+10%", "lang": "en"}`. Only `text` is required; it is cut at
4000 characters.

| `voice` | Language |
| --- | --- |
| `en-US-AvaNeural` (default for `en`), `en-US-AndrewNeural` | English |
| `tr-TR-EmelNeural` (default for `tr`), `tr-TR-AhmetNeural` | Turkish |
| `local` | macOS `say` with `DASHCALL_SAY_VOICE_EN` / `DASHCALL_SAY_VOICE_TR` |

A missing or unknown voice, or a voice of the other language, is replaced by the language's default. `rate` must look
like `+10%` or `-5%`; anything else means `+0%`.

```json
{ "engine": "neural", "voice": "en-US-AvaNeural", "mime": "audio/mpeg",
  "audio": "<base64 mp3>", "words": [ { "t": 0.1, "d": 0.3, "w": "Two" } ] }
```

`words` are word boundaries in seconds (`t` start, `d` duration). If edge-tts fails, the response has
`"engine": "local"`, no `voice` and an empty `words` array.

The mock agent (`npm run demo`) is silent: it returns `{"engine": "silent", "mime": null, "audio": null, "words": []}`.
On `engine: "silent"` (or `silent: true` from `/api/health`) the app shows the subtitles on a timer and plays nothing:
no neural audio, no browser speech, no notification chime. With `DASHCALL_DEMO_SOUND=1` the mock returns `501
internal` instead and the app falls back to the browser's own voice.

### Notifications and background tasks

#### `GET /api/notifications`

The last 100 notifications, newest first, and the unread count:

```json
{ "items": [ { "id": "…", "ts": "…", "read": false, "jobId": "…", "kind": "task", "lang": "en",
  "title": "Research X", "q": "Research X", "text": "…", "error": false, "conversationId": "…" } ], "unread": 1 }
```

`kind` is `answer` (a reply to `/api/ask`) or `task` (a background task summary).

#### `POST /api/notifications/read`

Body `{"ids": ["…", "…"]}` or `{"ids": "all"}`. Returns `{"ok": true}`.

#### `GET /api/watches`

Background tasks that are still waiting: `{"watches": [{"id", "pane", "cwd", "label", "sessionId", "state",
"created", "jobId", "conversationId", "lang", …}]}`.

### Brain

#### `GET /api/brain`

`{"memory": [{"id", "text", "ts"}], "notes": [{"id", "text", "ts", "done", "doneTs?"}], "muted": [{"id", "key",
"label", "reason", "ts"}]}`

#### `POST /api/brain/note` and `POST /api/brain/memory`

Body `{"text": "…"}`. Adds a note or a memory and returns the new item. Errors: `text_required`.

#### `POST /api/brain/done/:id`

Marks a note done and returns it. Errors: `not_found`.

#### `POST /api/brain/mute`

Body `{"key": "<Claude session id or folder name>", "label": "…"}`. Mutes a session (an exact session ID) or every
session whose folder path contains `key`. Returns the mute; muting the same key twice returns the existing one.
Errors: `key_required`.

#### `POST /api/brain/forget`

Body `{"key": "<memory id | note id | mute id | mute key>"}`. Deletes that item and returns it. Errors:
`key_required`, `not_found`.

## Web endpoints

| Method and path | Auth | Description |
| --- | --- | --- |
| `GET /healthz` | none | Returns `ok` (plain text). For uptime checks and load balancers. |
| `POST /login` | same-origin | Body `{"password": "…"}`. On success, sets the `dashcall` cookie (HttpOnly, `Secure` unless `DASHCALL_COOKIE_SECURE=0`, `SameSite=Lax`, one year) and returns `{"ok": true}`. Errors: `cross_origin`, `rate_limited`, `bad_password`. |
| `POST /logout` | same-origin | Clears the session cookie (204). |
| `/api/*` (any method) | cookie; same-origin for non-GET | Forwarded to the agent. Errors: `login_required`, `cross_origin`, `too_large`, `agent_unreachable`, `agent_auth`. |
| `GET /*` | cookie | Static files from `web/public/`. Without a valid cookie, every path serves the login page, except `/login.js`, `/i18n.js`, `/style.css` and `/icon.svg`. |

All static responses carry the security headers described in [ARCHITECTURE.md](ARCHITECTURE.md#security-model-briefly).
