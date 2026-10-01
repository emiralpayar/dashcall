# The `dashcall` CLI

`agent/bin/dashcall` is the tool the dispatcher uses to act on your sessions and manage its brain. The agent puts
`agent/bin` first on the dispatcher's `PATH`, and [`dispatcher/CLAUDE.md`](../dispatcher/CLAUDE.md) tells it which
commands to use.

You can use it yourself too, for debugging or scripting. Run it from the repo root on the Mac, with the same
environment as the agent, so it finds the same brain and state files:

```sh
node --env-file=.env agent/bin/dashcall sessions
```

Output is JSON, or plain text for `screen`, `last`, `dirs` and `brain`. Errors print `ERROR: <message>` to stderr and exit with
status 1. `dashcall` with no arguments, or `dashcall help`, prints the usage; an unknown command prints it to stderr
and exits with status 1.

## Sessions

| Command | What it does |
| --- | --- |
| `dashcall sessions [--all]` | Running Claude Code sessions in herdr. Muted ones are hidden unless you pass `--all`. |
| `dashcall recent [hours] [--all]` | Sessions active in the last `hours` (default 48), including finished ones, up to 25 |
| `dashcall screen <pane> [lines]` | Recent terminal output of a session (default 120 lines) |
| `dashcall last <pane>` | The full last assistant message of a session |
| `dashcall send <pane> <text...>` | Send a prompt to a session. This also unmutes it. The text is required; an empty one is a usage error. |
| `dashcall keys <pane> <key...>` | Send keys: `esc` (interrupt), `enter`, `ctrl+c`, `up`, `down`, `tab`, `shift+tab`, `1`, `2`, `3`. Only these keys are accepted, the same list as the API; anything else is a usage error that lists them. |
| `dashcall new <dir> <prompt...>` | Start a new Claude Code session in `<dir>` (`~/name` works) and give it the prompt |
| `dashcall dirs` | Folders directly under `DASHCALL_WORKSPACE_ROOT` (default: your home directory), most recently modified first |

The dispatcher's own sessions are always left out.

## Background tasks

A background task ends with a notification: when the watched session finishes, gets stuck or closes, the agent asks
the dispatcher for a short spoken summary. See [ARCHITECTURE.md](ARCHITECTURE.md#flow-background-tasks-watches).

| Command | What it does |
| --- | --- |
| `dashcall task <dir> <prompt...>` | Start a new session in `<dir>` **and** watch it |
| `dashcall watch <pane> [label...]` | Watch an existing session and notify when it finishes its current work. The label defaults to the terminal title. |
| `dashcall watches` | Background tasks still waiting |
| `dashcall unwatch <id>` | Stop watching (the watch is marked `cancelled`) |

`task` and `watch` store `DASHCALL_JOB_ID`, `DASHCALL_CONVERSATION_ID` and `DASHCALL_LANGUAGE` from the environment.
That way the summary goes back into the right conversation, in the right language. When you run them by hand, these
are empty and the summary starts a new conversation in the default language.

## Brain

The brain is the dispatcher's persistent memory: a JSON file (`DASHCALL_BRAIN_FILE`, by default
`dispatcher/brain/brain.json`) with three lists. The agent adds a compact version of it to the dispatcher's system
prompt on every question, so the dispatcher always knows what's in it. You can also edit it in the app's **Brain**
view.

| List | What goes in it | Example |
| --- | --- | --- |
| **Memory** | Durable facts and preferences: project nicknames, how you like reports, people and their roles | "api" means ~/code/my-api |
| **Notes** | Notes and reminders for you, with relative dates resolved to real ones | Call the bank on 2026-10-02 |
| **Muted** | Sessions or whole projects the dispatcher should stop mentioning | A long-running side project |

| Command | What it does |
| --- | --- |
| `dashcall brain` | Show memory, open notes and the muted list, exactly as the dispatcher sees them |
| `dashcall remember <text...>` | Store a long-term fact or preference |
| `dashcall note <text...>` | Add a note or reminder |
| `dashcall notes [--all]` | List open notes (`--all` includes done ones) |
| `dashcall done <note-id>` | Mark a note done |
| `dashcall forget <id\|mute-key>` | Delete a memory, note or mute |
| `dashcall mute <sessionId\|folder> [label...]` | Stop mentioning a session (by its Claude session ID) or a whole project (by folder name) |
| `dashcall unmute <key>` | The same as `forget`, for mutes |

How muting matches: a key that looks like a session ID (a UUID) mutes that one session. Any other key is a folder: a
name such as `my-api` (or `code/my-api`) mutes every session whose folder path has it as whole path segments, ignoring
case, so `api` mutes `~/code/api` and its subfolders but not `~/rapid-x` or `~/api-server`; a path such as
`~/code/my-api` mutes that folder and everything inside it. Muted sessions are hidden from `sessions` and `recent`
(with `--all`, `mutedBy` shows which key muted each one), and shown under "Muted" in the app. Sending a session a
prompt removes its session-ID mute automatically; folder mutes stay until you remove them.

Items get short random IDs, such as `a1b2c3`. The file is plain JSON, so you can back it up, or edit it while the agent
isn't writing to it. If an edit leaves it invalid, nothing is lost: the brain reads as empty (with a warning) until you
fix it, and the next change moves your copy to `brain.json.corrupt-<time>` instead of overwriting it
([recovering it](TROUBLESHOOTING.md#the-brain-or-notifications-suddenly-look-empty)).
