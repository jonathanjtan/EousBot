# EousBot

A Discord bot that takes feature requests, writes its own code, and redeploys
itself — behind a human approval gate.

```
/request  ─────────▶  GitHub Issue                      anyone in the guild
/status   ─────────▶  where each request stands         anyone
/build N  ─────────▶  agent writes code in a worktree   admins only
                          │
                     typecheck + tests must pass
                          │
                          ▼
                     Pull request ──▶ Discord embed      admins only
                                          │
                 ┌────────────────────────┼────────────────────┐
                 ▼                        ▼                    ▼
          Request changes             Approve               Reject
                 │                        │                    │
       agent revises the branch,   merge ▶ pull ▶         close the PR
       re-gated, new embed  ──┐    build ▶ restart
                           ▲  │
                           └──┘   iterate until it's right
```

## Why the gate exists

A bot that accepts arbitrary feature requests from Discord and then writes and
ships its own code is, structurally, a remote code execution endpoint. The
design treats that as the central constraint rather than a footnote:

| Boundary | What enforces it |
|---|---|
| Who can cause code to be written | `DISCORD_ADMIN_IDS` — `/build` is admin-only |
| Who can cause code to be deployed | The same allowlist, re-checked on button click |
| What the agent may edit | A throwaway git worktree, never the live checkout |
| What reaches `main` | A PR that passed `tsc` and the test suite |
| What the agent may not touch | The approval gate itself (see `src/agent.ts`) |
| Blast radius of a bad generation | A deleted directory and a closed PR |

`/request` is deliberately open — filing an issue costs nothing and spends
nothing. Everything that consumes tokens or changes running code is gated.

Two things worth being clear-eyed about:

- **The agent runs with real shell and filesystem access.** The worktree bounds
  *what it edits*, not what it can do. This is containment, not a sandbox. The
  approval gate is the actual control.
- **Button visibility is not authorization.** Anyone who can see the approval
  embed can click it; the allowlist check on the interaction is what stops
  them. Never move that check to message permissions.

## Authentication: API key vs. host login

The Agent SDK resolves credentials the same way the `claude` CLI does, so there
are two modes and **no relay is needed** for either:

| `ANTHROPIC_API_KEY` | Mode | Meaning |
|---|---|---|
| set | `apiKey` | Metered API spend, billed per token |
| unset | `hostAuth` | Inherits whatever `claude` is logged in as on this box |

The bot logs which mode it started in.

**Which is appropriate is a licensing question, not a technical one.** Anthropic
does not permit third-party developers to offer claude.ai login or subscription
rate limits *for their products*. The distinction that matters is who is
causing the inference:

- **Defensible:** `/build` stays admin-only, so only you can spend your own
  quota. That is your own automation with a Discord trigger — the same shape as
  driving `claude` yourself on a remote box you own.
- **Not defensible:** opening `/build` to the guild, or adding any path that
  lets someone else's input cause inference on your subscription. At that point
  it is a product served on your rate limits, and it needs its own API key.

If you ever widen who can trigger a build, set `ANTHROPIC_API_KEY` in the same
change. The mode is a one-line config difference; the obligation isn't.

## Setup

### 1. Discord application

At <https://discord.com/developers/applications>: create an application, add a
bot, copy the token and application ID. Invite it with the `bot` and
`applications.commands` scopes and the **Send Messages** permission.

No privileged intents are required — the bot only requests `Guilds` and is
driven entirely by slash commands and buttons. It never reads message content,
which keeps it out of intent review and limits what a stolen token is worth.

### 2. GitHub token

A fine-grained PAT scoped to **this repository only**:

- Contents: Read and write
- Issues: Read and write
- Pull requests: Read and write

### 3. Local

```bash
npm install
cp .env.example .env    # fill it in
npm run deploy-commands # register slash commands with your guild
npm run dev
```

`DISCORD_ADMIN_IDS` is the entire security boundary. Leaving it empty disables
`/build` and approval for everyone, which is the correct failure mode — the bot
warns at startup when it's unset.

### 4. On the server

```bash
git clone https://github.com/jonathanjtan/EousBot.git ~/EousBot
cp /path/to/your/.env ~/EousBot/.env && chmod 600 ~/EousBot/.env
~/EousBot/infra/install.sh
```

The same `.env` works on a laptop and on the server. `REPO_PATH` derives from
the running code's own location, and `install.sh` sets `SYSTEMD_UNIT` for the
machine.

**Always re-run `install.sh` after copying `.env` over — never just restart.**
A plain restart skips the `SYSTEMD_UNIT` rewrite, and the bot will then merge
and build a self-deploy without ever restarting into it.

The installer sets up a systemd **user** service. That choice is load-bearing:
`systemctl --user restart` needs no sudo, so the bot can restart itself without
being granted passwordless sudo — a far larger privilege than "restart
yourself". It also enables linger, so the service survives you logging out.

## Hosting

EousBot is cheap and easy to host. A Discord bot is an *outbound* WebSocket to
Discord's gateway, so it needs **zero inbound ports** — nothing to expose, no
firewall rule to open, no reverse proxy.

Requirements are modest:

| | |
|---|---|
| OS | Any Linux with systemd (user services + linger) |
| Node | 22 or newer |
| `claude` CLI | On `PATH` and logged in, unless you set `ANTHROPIC_API_KEY` |
| Disk | Enough for a `node_modules` per concurrent build worktree |
| Always-on | Builds and self-deploys only happen while the process is up |

A small burstable instance suits it well: the bot idles on a WebSocket and
spikes only during `npm install` and `tsc`, which is exactly the workload
burst credits are designed for. Sharing a box with other work is fine — it is
not resource-hungry between builds.

Two things that bite when hosting on a machine you already use for something
else:

- **Anything that powers the machine down stops the bot.** Scheduled shutdowns
  on cloud dev boxes are the usual culprit, and they are easy to forget about
  because they were configured for a different purpose.
- **Reprovisioning scripts can undo the installer.** If the host is built from
  a script that also manages its own systemd units or shutdown schedules,
  re-running it may need `install.sh` run again afterwards.

## Iterating on a pull request

**Request changes** opens a modal for feedback, then puts the agent back on the
same branch with it. The revision passes the same `tsc` and test gates as the
original, pushes to the existing branch so the PR updates in place, and posts a
fresh approval prompt. Repeat as often as you like.

Two details that make this better than rejecting and rebuilding:

- **The agent resumes its original session.** The session id is written into
  every PR body, so it is recovered from GitHub rather than tracked locally.
  Resuming means the agent still knows *why* it made its first choices instead
  of inferring them from the diff. If the session is gone, it falls back to a
  fresh one — the prompt carries the full context either way, so resume is an
  improvement rather than a dependency.
- **A failed revision leaves the PR alone.** The previously pushed commit
  already passed the gates, so nothing is pushed unless the revision passes
  too. You never lose a working version to a bad follow-up.

Feedback is treated as a genuine change request but does not outrank the
agent's ground rules: asked to weaken the approval gate, it declines that part,
does the rest, and says so.

## Adding commands

Drop a module in `src/commands/` exporting a `Command`, then register it in
`src/commands/index.ts`. The registry uses explicit imports rather than
directory globbing so that a command added by the agent shows up in the PR diff
instead of appearing by filesystem side effect.

The bot re-registers commands with Discord on every boot, but only when they
actually differ from what Discord already has — so a new command written by
the agent appears by itself after the self-deploy restart, and an unchanged
set costs one read per boot rather than a write.

`npm run deploy-commands` still exists as an escape hatch: it force-pushes the
schema without waiting for a restart.

## Operating

```bash
journalctl --user -u eousbot.service -f    # follow logs
systemctl --user restart eousbot.service   # manual restart
systemctl --user stop eousbot.service      # stop; also halts self-deploys
```

`/ping` reports the running commit, which is the fastest way to confirm a
self-deploy actually landed.

If generated code crash-loops, systemd gives up after 5 restarts in 60 seconds
and leaves the unit stopped rather than churning. Recover by hand:

```bash
cd ~/EousBot
git log --oneline -5
git revert <bad-commit> && npm ci && npm run build
systemctl --user reset-failed eousbot.service
systemctl --user start eousbot.service
```

## Layout

```
src/
  index.ts        gateway client, interaction router, allowlist enforcement
  config.ts       env validation; exits on bad config
  commands/       slash commands + the registry
  agent.ts        Claude Agent SDK wrapper and its system prompt
  pipeline.ts     worktree → agent → typecheck → test → PR
  selfdeploy.ts   merge → pull → build → restart
  approval.ts     approval embed and button custom-ID codec
  github.ts       issues, labels, pull requests
  git.ts          worktree lifecycle, shell-free command execution
  naming.ts       pure helpers (no imports, so tests need no secrets)
  state.ts        the one fact that must outlive a restart
infra/
  install.sh      install/update on an existing Linux box
  eousbot.service systemd user unit
```
