# Security policy

Dashcall lets anyone who is logged in run commands on the host Mac through Claude Code. Please take security issues
seriously and report them privately.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead: open the repository's
[**Security** tab](https://github.com/emiralpayar/dashcall/security) and choose **Report a vulnerability**. Include
steps to reproduce and the impact you expect. You should get a reply within a week.

## Supported versions

Security fixes go into the latest release and the `main` branch.

## Threat model

- **The web login is the perimeter.** Whoever is logged in controls your Claude Code sessions and, through them, your
  Mac. Use a long random `DASHCALL_PASSWORD` and serve the app only over HTTPS.
- **The agent must stay private.** Bind it to a private address (for example Tailscale) and never expose it publicly.
  Every request needs the `DASHCALL_TOKEN` bearer token.
- **The dispatcher may only run the `dashcall` CLI.** Anything it reads, such as session output, research results or
  a misheard transcript, can contain a prompt injection, so it runs `claude -p --permission-mode dontAsk` with Bash
  limited to `dashcall` commands (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-dispatchers-permissions)).
  Through `dashcall` it can still type into your sessions, press keys in them and start new ones.
  `DASHCALL_DISPATCH_UNRESTRICTED=1` turns the restriction off; don't.
- **`DASHCALL_SESSION_COMMAND` decides whether new sessions ask for permissions.** The default `claude` asks. With
  `claude --dangerously-skip-permissions`, background tasks run unattended and can do anything your user can.
- **New sessions only start under `DASHCALL_WORKSPACE_ROOT`** (default: your home directory), checked with resolved
  real paths.
- **Speech:** audio is transcribed locally. Text to be spoken goes to Microsoft's online Edge TTS service unless you
  choose the local voice.

Built-in protections are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model-briefly).

## Scope

In scope:

- Bypassing the web login, the session cookie or the agent's bearer token.
- Cross-site attacks on the web app (CSRF, XSS, clickjacking).
- Making the agent run commands, start sessions outside `DASHCALL_WORKSPACE_ROOT`, or read files you shouldn't be able
  to reach through the API.
- Leaking conversation data, the brain or notifications.

Out of scope, because they are documented, by-design trade-offs:

- A logged-in user being able to control Claude Code sessions.
- What the dispatcher can do through the `dashcall` CLI, including driving your sessions, and anything it can do
  with `DASHCALL_DISPATCH_UNRESTRICTED=1`. Making it run any other command is in scope.
- Prompt injection that requires the attacker to already control a session's content or the user's speech.
