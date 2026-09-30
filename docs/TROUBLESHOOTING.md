# Troubleshooting

Start with the logs:

- **Agent:** `tail -f logs/agent.log` (with launchd) or the terminal running `npm run agent`. Set
  `DASHCALL_LOG_CONTENT=1` temporarily to also see questions and transcripts.
- **Web app:** `docker compose logs -f` in `web/`.
- **Browser:** error messages show up as toasts in the app. API errors carry a `code`; the codes are listed in
  [API.md](API.md#errors).

## Login

### Login does nothing or keeps returning to the login page

The session cookie is `Secure`, so browsers only send it back over HTTPS. Over plain `http://` the login "succeeds" but
the cookie is dropped.

- In production, serve the app over HTTPS ([INSTALL.md, step 7](INSTALL.md#7-server-https-with-caddy)).
- For local development only, set `DASHCALL_COOKIE_SECURE=0` in `web/.env`. `npm run demo` does this for you.

### "Too many attempts" (`rate_limited`)

After 10 failed logins from one IP in 15 minutes, logins from that IP are blocked until the window passes. If
*everyone* is blocked at once, the web app is seeing your proxy's IP instead of the clients'. Set
`DASHCALL_TRUST_PROXY=1` (the compose file already does) and make sure the proxy sets `X-Forwarded-For`.

### Everyone was signed out

That happens when `DASHCALL_PASSWORD` or `DASHCALL_SECRET` changes, which is by design.

## `403 cross_origin` on login or when sending anything

The web app rejects logins and non-GET API calls unless the browser's `Origin` matches the `Host` header it
receives. A reverse proxy that rewrites `Host`, for example to `127.0.0.1:8080`, causes exactly this error.

- **Caddy** forwards `Host` by default. Don't add `header_up Host {upstream_hostport}`.
- **nginx:** add `proxy_set_header Host $host;`.
- **Traefik and others:** enable "pass host header".
- Also open the app through the same hostname the proxy serves. Using its IP address or another domain doesn't work.

## The Mac shows as offline (`agent_unreachable`)

The dot next to the logo is red, and requests fail with "cannot reach the agent". Check each hop from the
**server**:

```sh
tailscale status                                   # is the Mac online in your tailnet?
curl -H "Authorization: Bearer <token>" http://<mac-tailscale-ip>:7420/api/health
```

- **Connection refused:** the agent isn't running, or listens on another address. If the log shows
  `EADDRNOTAVAIL`, the agent started before Tailscale had its address (for example right after login); launchd
  restarts it every 10 seconds until Tailscale is up. Check `DASHCALL_BIND` (it must be
  the Mac's current `tailscale ip -4`, not `127.0.0.1`) and the agent log.
- **Timeout:** the Mac is asleep, Tailscale is disconnected on one side, or the macOS firewall blocks `node`
  (System Settings → Network → Firewall → Options).
- **`401 unauthorized` from curl:** the token in your command doesn't match `DASHCALL_TOKEN` on the Mac.
- **The app says "The Mac rejected the server's token":** the Mac is reachable but the tokens differ; see
  [`agent_auth`](#the-mac-rejected-the-servers-token-agent_auth).
- **It works with curl but not in Docker:** check that `DASHCALL_AGENT_URL` has the right IP and port. The container
  must be able to reach the tailnet, which it can when Tailscale runs on the host.
- **Long voice messages fail at about 2 minutes:** the web app gives the agent 120 seconds per request. Very long
  recordings on a slow Mac can go over that. Use a smaller whisper model.

## "The Mac rejected the server's token" (`agent_auth`)

The web app reached the agent, but the agent answered `401`: `DASHCALL_AGENT_TOKEN` in `web/.env` doesn't match
`DASHCALL_TOKEN` in the Mac's `.env`. The web app logs `agent rejected DASHCALL_AGENT_TOKEN` and returns
`502 agent_auth`, so you stay logged in and the app shows this message instead of sending you back to the login page.
Make the two values equal, then restart the container (`docker compose up -d`) or the agent, whichever you changed.

## The web app or the agent exits right after starting (`cannot listen on …`)

Both servers print `cannot listen on <address>:<port>: <reason>` and exit with status 1 when they can't open their
port.

- **`EADDRINUSE`:** another process uses the port. Stop it (`lsof -i :8080` shows which) or change `PORT` /
  `DASHCALL_PORT`.
- **`EADDRNOTAVAIL`:** the address doesn't belong to this machine. For the agent, `DASHCALL_BIND` must be the Mac's
  current `tailscale ip -4`, and Tailscale must be connected. For the web app, check `HOST`.

## Speech-to-text

### Every recording fails with an `internal` error

Look for `ffmpeg` or `whisper` in the agent log.

- **Model missing:** run `./scripts/download-model.sh`. If you set `DASHCALL_WHISPER_MODEL`, check the path (relative
  paths start at the repo root).
- **`whisper-cli` or `ffmpeg` not found:** run `brew install whisper-cpp ffmpeg`. Under launchd, see
  [the PATH issue below](#it-works-in-the-terminal-but-not-under-launchd).

### Transcripts are in the wrong language or garbled

whisper transcribes in the language selected in the app (EN/TR in the header). Switch it to the language you're
speaking.

### `unsupported_audio` (415)

The browser sent a format other than WebM, Ogg, MP4 or WAV. Try a current Safari, Chrome or Firefox.

## The voice sounds robotic (edge-tts fallback)

A robotic voice without word-by-word subtitles means edge-tts failed and the agent used macOS `say`. The log shows
`neural tts failed, falling back to say:` followed by the reason.

- **The virtual environment is missing:** run
  `python3 -m venv tts/.venv && tts/.venv/bin/pip install -r tts/requirements.txt`.
- **No internet on the Mac, or the service is blocked:** edge-tts needs Microsoft's online service. It is unofficial
  and can change; `tts/.venv/bin/pip install -U -r tts/requirements.txt` often fixes breakage.
- **`say` uses the wrong voice:** set `DASHCALL_SAY_VOICE_EN` / `DASHCALL_SAY_VOICE_TR` to a voice listed by
  `say -v '?'`. Download more voices in System Settings → Accessibility → Spoken Content.

If even `say` fails, the app falls back to the browser's own voice.

## It works in the terminal but not under launchd

launchd starts the agent with a minimal `PATH`. The agent adds `/opt/homebrew/bin` and `/usr/local/bin` itself, but
`claude` and `herdr` often live in `~/.local/bin`. Symptoms: `spawn claude ENOENT` or `herdr` errors in
`logs/agent.log`, and every question failing.

- Run `which claude herdr ffmpeg whisper-cli` in your terminal. Add those folders to the `PATH` in
  `~/Library/LaunchAgents/com.dashcall.agent.plist`, or set `DASHCALL_CLAUDE_BIN` / `DASHCALL_HERDR_BIN` to full paths
  in `.env`.
- Then restart: `launchctl kickstart -k gui/$(id -u)/com.dashcall.agent`.

## Sessions

### No sessions show up

Dashcall only sees Claude Code sessions that run **inside herdr**. Check with `herdr agent list`. Sessions started in a
plain terminal are invisible, and the dispatcher's own sessions are hidden on purpose.

- `herdr status` should show the server as `running`. After a reboot, start `herdr` once so its server is up.
- `herdr integration status` should show `claude: current`. If not, run `herdr integration install claude` and
  restart your Claude Code sessions. Without it, herdr can't tell Dashcall a session's status or transcript.

### New jobs or background tasks get stuck

A new session types `DASHCALL_SESSION_COMMAND` (default `claude`) into a fresh pane. Plain `claude` stops at its first
permission prompt ("Allow this edit?"), so a background task started from the car waits there. The watcher reports it
as *stuck waiting for input* after about 20 seconds.

- Answer the prompt from the app: open the session under **Sessions** and send `1`/`2`/`3` or `enter`, or ask the
  dispatcher to do it.
- Or configure Claude Code's permission rules for your projects.
- Or set `DASHCALL_SESSION_COMMAND="claude --dangerously-skip-permissions"`, after reading
  [SECURITY.md](../SECURITY.md).

### `session_start_failed`

Claude Code didn't become ready within 60 seconds. Open the herdr workspace on the Mac and look: common causes are a
login prompt (run `claude` once by hand), a slow shell startup, or a wrong `DASHCALL_SESSION_COMMAND`.

### `folder_outside_root`

The folder isn't under `DASHCALL_WORKSPACE_ROOT` (default: your home directory). Symlinks are resolved first, so a
link inside the root that points outside it is refused too.

## Microphone and audio in the browser

### The microphone button does nothing, or permission is never asked

Browsers only allow microphone access on secure pages: `https://` or `http://localhost`. Over `http://` with an IP
address, the microphone is blocked. Serve the app over HTTPS. If you denied access earlier, allow it again in the
site settings (on iOS: Settings → Safari → Microphone).

### No sound on iPhone, iPad or in the car

Mobile browsers and car browsers, such as Tesla's, block audio that doesn't start from a tap. The app unlocks audio on
your first tap in a session, so tap the talk button (or anywhere) once after opening the page. Also check:

- On iPhone, the ring/silent switch or Focus mode can silence web audio. Turn the volume up while audio is playing.
- In the car, make sure the browser's audio is routed to the car speakers and isn't muted by media playback.
- Background results arrive while the page is open. If you closed it, they wait in **Notifications** and pop up when
  you come back.

### The screen turns off

The app asks the browser to keep the screen on while Drive mode is open (the Screen Wake Lock API). Some browsers
don't support it; in that case, change the device's auto-lock setting.

## The demo

`npm run demo` needs Node 22 or newer (`node --version`) and a free port 8080. If 8080 is taken, use another port:
`PORT=3000 npm run demo`. The mock agent picks a free local port by itself and returns canned answers; that is
expected.

The demo is **silent on purpose**: answers appear as timed subtitles, and nothing is read aloud, not even the
notification chime. To hear the browser's built-in voice, run `DASHCALL_DEMO_SOUND=1 npm run demo`
([CONFIGURATION.md](CONFIGURATION.md#demo-mode)).
