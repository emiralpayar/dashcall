# Installing Dashcall

This guide takes you from nothing to a working setup:

- the **agent** on your Mac, next to your Claude Code sessions
- the **web app** on a Linux server, behind HTTPS
- a private network (Tailscale) between the two

It takes about 30 minutes, mostly downloads. If you only want to look around first, run `npm run demo` (see the
[README](../README.md#try-the-demo-in-30-seconds)). The demo needs none of this.

**Contents**

1. [What you need](#1-what-you-need)
2. [Mac: tools](#2-mac-tools)
3. [Mac: Dashcall agent](#3-mac-dashcall-agent)
4. [Tailscale on both machines](#4-tailscale-on-both-machines)
5. [Mac: run the agent at login](#5-mac-run-the-agent-at-login)
6. [Server: web app](#6-server-web-app)
7. [Server: HTTPS with Caddy](#7-server-https-with-caddy)
8. [First login](#8-first-login)
9. [Verification checklist](#9-verification-checklist)
10. [Updating](#10-updating)
11. [Uninstalling](#11-uninstalling)

## 1. What you need

| Where | What |
| --- | --- |
| Mac (agent) | macOS on Apple Silicon or Intel, about 1 GB free disk space for the speech model, a Claude account that can use Claude Code |
| Linux server (web app) | Any small VPS or home server with Docker, and a domain name pointing at it |
| Both | A free [Tailscale](https://tailscale.com) account, or another private network between the two machines |

The web app is plain Node.js, so it also runs on the Mac itself or anywhere else with Node 22. The rest of this guide
assumes a separate Linux server, which is the setup to use from a phone or a car.

Commands marked **Mac** run in Terminal on the Mac. Commands marked **Server** run over SSH on the server.

## 2. Mac: tools

### Homebrew

Skip this if `brew --version` already works.

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

At the end, the installer prints two commands that add `brew` to your shell. Run them.

### Node.js 22

```sh
brew install node@22
```

`node@22` is "keg-only", which means Homebrew doesn't put it on your PATH. Add it (the path is
`/usr/local/opt/node@22/bin` on Intel Macs):

```sh
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version    # v22.x or newer
```

Any Node.js 22 or newer works, including one from nvm or from the official installer. The repo has an `.nvmrc`.

### Claude Code

Install Claude Code and log in by following the official guide:
<https://code.claude.com/docs/en/setup>. Then check:

```sh
claude --version
```

Start `claude` once in any folder and complete the login. Dashcall uses the same login for the dispatcher and for new
sessions.

### herdr

[herdr](https://herdr.dev) runs your coding agents in persistent terminals. Dashcall uses it to see, read and prompt
your Claude Code sessions.

```sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr --version
```

The installer puts `herdr` in `~/.local/bin`. If `herdr --version` says "command not found", add that folder to your
PATH (`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`).

herdr needs its Claude Code integration to report each session's status and Claude session ID, which Dashcall uses
to find the transcript. Check it, and install it if it isn't there:

```sh
herdr integration status          # look for: claude: current
herdr integration install claude  # only if it isn't installed
```

Run your Claude Code sessions inside herdr from now on: start `herdr` in Terminal, and run `claude` in its panes as
you would in any terminal. Sessions started anywhere else are invisible to Dashcall. herdr keeps running when you
detach, and the agent talks to it in the background. See [herdr.dev](https://herdr.dev) for workspaces, panes and key
bindings. To check what Dashcall will see, run `herdr agent list`.

### Speech: ffmpeg, whisper.cpp and edge-tts

```sh
brew install ffmpeg whisper-cpp
which ffmpeg whisper-cli     # both should print a path
brew list --versions whisper-cpp   # 1.8.3 or newer; if older: brew upgrade whisper-cpp
```

Dashcall uses whisper.cpp's voice activity detection, which needs whisper.cpp 1.7.6 or newer (1.8.3 or newer for the
default VAD model).

Neural voices come from [edge-tts](https://github.com/rany2/edge-tts), which runs in a small Python virtual
environment. You install it in the next step, after cloning. It is optional: without it the agent uses macOS `say`.

## 3. Mac: Dashcall agent

### Clone and download the speech models

```sh
git clone https://github.com/emiralpayar/dashcall.git
cd dashcall
./scripts/download-model.sh     # into models/: ggml-large-v3-turbo-q5_0.bin (about 574 MB)
                                # and the ggml-silero-v6.2.0.bin VAD model (under 1 MB)
```

The VAD (voice activity detection) model makes whisper skip silence and background noise, which it would otherwise
sometimes turn into made-up text. To try a different whisper.cpp model, pass its file name (for example
`./scripts/download-model.sh ggml-base.bin`) and set `DASHCALL_WHISPER_MODEL` to match. A second argument picks
another VAD model; see `DASHCALL_WHISPER_VAD_MODEL` in [CONFIGURATION.md](CONFIGURATION.md).

### Neural voices (optional, recommended)

```sh
python3 -m venv tts/.venv
tts/.venv/bin/pip install -r tts/requirements.txt
```

If `python3` is missing, macOS offers to install the Command Line Tools. You can also run `brew install python`.

### Configure

```sh
cp .env.example .env
openssl rand -hex 32            # copy the output: this is your agent token
```

Open `.env` and set:

| Variable | Value |
| --- | --- |
| `DASHCALL_TOKEN` | The token you just generated. The web app needs the same value. |
| `DASHCALL_BIND` | Keep `127.0.0.1` for now. You change it to the Tailscale IP in step 4. |
| `DASHCALL_DEFAULT_LANGUAGE` | `en` or `tr`. The app sends its own choice, so this only matters for other clients. |
| `DASHCALL_SESSION_COMMAND` | The command that starts a new session. Keep `claude` for now; see the note below. |

Every other variable is optional; see [CONFIGURATION.md](CONFIGURATION.md).

> **About `DASHCALL_SESSION_COMMAND`.** New jobs type this command into a fresh herdr pane. Plain `claude` asks for
> permission before editing files or running commands, so a background task you started from the car stops at the
> first prompt until you answer it in the app. `claude --dangerously-skip-permissions` avoids that, but then the
> session can do anything your user can. Read [SECURITY.md](../SECURITY.md) before choosing.

### Run it

```sh
npm run agent
```

You should see `dashcall agent on 127.0.0.1:7420`. In a second terminal:

```sh
curl -H "Authorization: Bearer <your token>" http://127.0.0.1:7420/api/health
# {"ok":true}
curl -H "Authorization: Bearer <your token>" http://127.0.0.1:7420/api/sessions
# {"sessions":[...]}   your herdr sessions
```

Stop it with Ctrl+C for now.

### Keep the Mac awake

The agent can only answer while the Mac is awake. On a Mac that stays at home, turn on **System Settings → Energy
(or Battery → Options) → Prevent automatic sleeping when the display is off**.

## 4. Tailscale on both machines

The web server has to reach the agent, but the agent must never be on the public internet. Tailscale gives both
machines private addresses that only your devices can reach.

**Mac:** install Tailscale from <https://tailscale.com/download/mac> (or `brew install --cask tailscale`), open it and
log in. Then read its address:

```sh
tailscale ip -4      # e.g. 100.101.102.103
```

If the `tailscale` command isn't found, the address is also shown in the Tailscale menu bar icon.

**Server:**

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Log in with the same account. Back on the **Mac**, set the Tailscale address in `.env`:

```sh
DASHCALL_BIND=100.101.102.103
```

Now the agent is only reachable from your Tailscale network, and no longer from `127.0.0.1`. Restart it
(`npm run agent`) and test from the **server**:

```sh
curl -H "Authorization: Bearer <your token>" http://100.101.102.103:7420/api/health
# {"ok":true}
```

If macOS asks whether `node` may accept incoming connections, allow it.

## 5. Mac: run the agent at login

A LaunchAgent keeps the agent running in the background and restarts it if it crashes.

```sh
mkdir -p logs
cp docs/launchd.example.plist ~/Library/LaunchAgents/com.dashcall.agent.plist
```

Edit `~/Library/LaunchAgents/com.dashcall.agent.plist`:

- Replace `/path/to/node` with the output of `which node`.
- Replace every `/path/to/dashcall` with the full path of your clone (`pwd` in the repo).
- Fix the `PATH` value so it contains the folders of `claude`, `herdr`, `ffmpeg` and `whisper-cli`. Check with
  `which claude herdr ffmpeg whisper-cli`. launchd starts programs with a minimal PATH, so this matters.

Then load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dashcall.agent.plist
tail -f logs/agent.log        # expect: dashcall agent on 100.x.y.z:7420
```

Useful commands:

```sh
launchctl kickstart -k gui/$(id -u)/com.dashcall.agent   # restart, e.g. after editing .env
launchctl bootout gui/$(id -u)/com.dashcall.agent        # stop and unload
launchctl print gui/$(id -u)/com.dashcall.agent | head   # status
```

## 6. Server: web app

Install Docker if needed (see <https://docs.docker.com/engine/install/>), then:

```sh
git clone https://github.com/emiralpayar/dashcall.git
cd dashcall/web
cp .env.example .env
openssl rand -hex 32     # cookie secret
openssl rand -hex 24     # a strong password, or use your password manager
```

Edit `web/.env`:

| Variable | Value |
| --- | --- |
| `DASHCALL_PASSWORD` | Your login password. Long and random: it is the only thing between the internet and your Mac. |
| `DASHCALL_SECRET` | The first `openssl` output. |
| `DASHCALL_AGENT_URL` | `http://<Mac Tailscale IP>:7420`, for example `http://100.101.102.103:7420` |
| `DASHCALL_AGENT_TOKEN` | Exactly the same value as `DASHCALL_TOKEN` on the Mac. |

Start it:

```sh
docker compose up -d --build
docker compose logs -f     # expect: dashcall web on 0.0.0.0:8080 (inside the container)
curl http://127.0.0.1:8080/healthz    # ok
```

The container is only published on `127.0.0.1:8080`, so it isn't reachable from outside until you add HTTPS. To use
another port, set `PORT` in `web/.env`: `docker-compose.yml` reads it and publishes that port on `127.0.0.1` instead.
Use the same port in the reverse proxy below.

**Without Docker:** install Node 22 and run `npm run web` from the repo root. It reads `web/.env` and, like the
container, is only reachable from the same machine: it listens on `127.0.0.1` unless you set `HOST`. Keep
`DASHCALL_TRUST_PROXY=1` only if a reverse proxy sits in front of it, as in the next step.

## 7. Server: HTTPS with Caddy

Browsers only allow microphone access on HTTPS pages, and the login cookie is HTTPS-only. [Caddy](https://caddyserver.com)
gets and renews a certificate automatically.

1. Point a DNS record (for example `dashcall.example.com`) at the server's public IP.
2. Open ports 80 and 443 in the server's firewall.
3. Install Caddy: <https://caddyserver.com/docs/install>.
4. Use [`docs/Caddyfile.example`](Caddyfile.example) as `/etc/caddy/Caddyfile`, with your domain:

   ```
   dashcall.example.com {
   	reverse_proxy 127.0.0.1:8080
   }
   ```

5. Reload: `sudo systemctl reload caddy`.

Using another proxy, such as nginx or Traefik? Make sure it:

- forwards the original `Host` header (for nginx: `proxy_set_header Host $host;`),
- sets `X-Forwarded-For` (for nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`),
- allows request bodies of up to 25 MB (voice recordings) and responses that take up to 2 minutes.

## 8. First login

1. On your phone, open `https://dashcall.example.com` and log in with `DASHCALL_PASSWORD`. The phone doesn't need
   Tailscale: only the server talks to the Mac.
2. Pick **EN** or **TR** in the header.
3. The dot next to the logo turns green when the web app can reach your Mac.
4. On **Drive**, tap the big button and allow microphone access. Ask "What are my sessions doing?"
5. Tip: add the page to your home screen. The login lasts a year, or until you change `DASHCALL_PASSWORD`
   or `DASHCALL_SECRET`.

## 9. Verification checklist

| Check | Command or action | Expected |
| --- | --- | --- |
| Agent is running | `tail logs/agent.log` on the Mac | `dashcall agent on <ip>:7420` |
| Token works | From the server: `curl -H "Authorization: Bearer <token>" http://<mac-ip>:7420/api/health` | `{"ok":true}` |
| Wrong token is rejected | The same command with a different token | `401`, `{"error":"unauthorized","code":"unauthorized"}` |
| herdr is visible | `curl -H "Authorization: Bearer <token>" http://<mac-ip>:7420/api/sessions` | Your sessions |
| Web app is up | `curl https://dashcall.example.com/healthz` | `ok` |
| API needs login | `curl -i https://dashcall.example.com/api/health` | `401`, code `login_required` |
| Server and Mac tokens match | Log in and look at the dot next to the logo | Green. "The Mac rejected the server's token" (`502 agent_auth`) means `DASHCALL_AGENT_TOKEN` differs from `DASHCALL_TOKEN` |
| Speech-to-text works | Tap the talk button and say something | Your words appear on screen |
| Neural voice works | Listen to the answer | A natural voice. A robotic one means edge-tts fell back to `say`; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#the-voice-sounds-robotic-edge-tts-fallback) |
| Dispatcher works | Ask "What are my sessions doing?" | A spoken summary within about 10 to 30 seconds |
| New jobs work | **New job** tab: pick a folder and a small task | A new session appears under **Sessions** |

## 10. Updating

**Mac:**

```sh
cd /path/to/dashcall
git pull
./scripts/download-model.sh   # fetches models a new version needs; skips the ones you have
launchctl kickstart -k gui/$(id -u)/com.dashcall.agent
```

**Server:**

```sh
cd /path/to/dashcall/web
git pull
docker compose up -d --build
```

Check [CHANGELOG.md](../CHANGELOG.md) for renamed or new settings, and compare your `.env` files with the
`.env.example` files.

## 11. Uninstalling

**Mac:**

```sh
launchctl bootout gui/$(id -u)/com.dashcall.agent
rm ~/Library/LaunchAgents/com.dashcall.agent.plist
rm -rf /path/to/dashcall     # also deletes the brain, notifications and logs stored inside it
```

To keep your data, first copy `dispatcher/brain/` and `state/` out of the repo. Uninstall herdr, Tailscale, ffmpeg and
whisper-cpp separately if you no longer need them (for example `brew uninstall whisper-cpp ffmpeg node@22`).

**Server:**

```sh
cd /path/to/dashcall/web
docker compose down --rmi local
rm -rf /path/to/dashcall
```

Then remove the site from your Caddyfile, reload Caddy and delete the DNS record.
