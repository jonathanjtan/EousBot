# EousBot

A Discord bot that takes feature requests, writes its own code, and redeploys
itself — behind a human approval gate.

```
/request  ─────────▶  GitHub Issue                      anyone in the guild
/status   ─────────▶  where each request stands         anyone
/claude N ─────────▶  agent writes code in a worktree   admins only
                          │
                     typecheck + tests must pass
                          │
                          ▼
                     Pull request ──▶ Discord embed
                                          │
                 ┌────────────────────────┼────────────────────┐
                 ▼                        ▼                    ▼
          Request changes             Approve               Reject
       anyone, under 60% usage        admins only          admins only
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
| Who can cause code to be written | `DISCORD_ADMIN_IDS` — `/claude` is admin-only |
| Who can cause code to be *re*written | Anyone, but only while usage is under 60% (`src/usagegate.ts`) |
| Who can cause code to be deployed | The same allowlist, re-checked on button click |
| What the agent may edit | A throwaway git worktree, never the live checkout |
| What reaches `main` | A PR that passed `tsc` and the test suite |
| What the agent may not touch | The approval gate itself (see `src/agent.ts`) |
| Blast radius of a bad generation | A deleted directory and a closed PR |

`/request` is deliberately open — filing an issue costs nothing and spends
nothing. Everything that changes running code is gated on the allowlist.

Requesting changes to an open PR is the one token-spending path that is not:
review is worth more when the people who asked for a feature can say what is
wrong with it. It is bounded instead by usage — a non-admin's revision is
refused unless both the current session window and the weekly window are under
60%, so the reserve an admin needs to finish something stays theirs. **This is
a path that lets someone else's input cause inference on this account's plan,
so read the licensing note below and set `ANTHROPIC_API_KEY` accordingly.**

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

- **Defensible:** `/claude` stays admin-only, so only you can spend your own
  quota. That is your own automation with a Discord trigger — the same shape as
  driving `claude` yourself on a remote box you own.
- **Not defensible:** opening `/claude` to the guild, or adding any path that
  lets someone else's input cause inference on your subscription. At that point
  it is a product served on your rate limits, and it needs its own API key.

If you ever widen who can trigger a build, set `ANTHROPIC_API_KEY` in the same
change. The mode is a one-line config difference; the obligation isn't.

Opening **Request changes** to the guild is exactly such a widening: a
non-admin's feedback now causes inference. The 60% usage ceiling limits how
much of the plan that can consume, but it does not change the licensing
question — run on an API key if the guild is anyone but you.

## Setup

### 1. Discord application

At <https://discord.com/developers/applications>: create an application, add a
bot, copy the token and application ID. Invite it with the `bot` and
`applications.commands` scopes and the **Send Messages** permission.

No privileged intents are required — the bot requests only `Guilds` and
`GuildMessages`, and reads message content solely where Discord exempts it:
messages that mention it, and messages a context menu command is used on. It
cannot read the server's ordinary conversation, which keeps it out of intent
review and limits what a stolen token is worth.

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
`/claude` and approval for everyone, which is the correct failure mode — the bot
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

## Talking to the bot

Mention it and say what you want:

```
@PaimonBot work on #16
@PaimonBot drop the polling watcher, make it a command instead
@PaimonBot looks good, ship it
@PaimonBot #11 use a simpler parser
@PaimonBot what's the weather in Osaka right now?
@PaimonBot what breed is this?          ← with a photo attached
```

Naming an open request after a build word — `work on #16`, `build issue 12`,
`implement #5` — runs the same pipeline `/claude` does, at the configured model
and effort. Use `/claude` when you want to override those.

For feedback it picks the PR from an explicit `#11`, from the message you
replied to, or from the only open PR — and asks if there are several.

**This is a shortcut to the gate, not a way around it.** A build or a revision
runs directly, because the output is a reviewable PR. Approving and
rejecting still post the buttons: prose is ambiguous, and a misread "looks
good, but change X" would deploy code nobody agreed to. The confirmation
states which PR and which action were understood, so a wrong reading is
visible before it costs anything.

The parser (`src/intent.ts`) checks for change-request markers *before*
approval words, so "lgtm, though can you rename the module" is feedback rather
than a green light. The build pattern is anchored at the start of the message
and has to name a number right after the verb, so "looks good but build the
config from env, see #11" stays feedback about #11 rather than becoming a build
of it. Anything it can't classify becomes feedback too — it fails
toward the reversible outcome by construction, and the tests cover that case
specifically.

### Asking it things

A mention that is simply a question gets answered — by a full Claude Code
agent, not a chatbot. `src/chat.ts` runs the real tool set (Bash, Read, Write)
at `bypassPermissions`, in a scratch workspace, and **anything it leaves in
that workspace is attached to the reply**. Ask it to turn thirty image links
into a collage and it writes a script, runs it, and hands back a JPEG.

That shape was arrived at the hard way. The first version had two tools —
`WebSearch` and `WebFetch` — and when asked for exactly that collage it
correctly reported it couldn't, which is what no Claude Code session would ever
say. Building a bespoke tool per request is a losing race.

The channel is the conversation: a follow-up resumes the same session and finds
the same workspace, so "now crop it" means something. It takes an explicit
`@` — replying to the bot pings it, and treating that as a fresh question meant
every reply to an answer started one. `/stop` reaches a chat run via its own
slot in `src/running.ts`, kept separate so a question asked mid-build can't
overwrite the build's handle and leave it unstoppable.

Resuming replays the whole transcript on every turn, so a session left to grow
is a bill that grows with it, and the idle TTL never fires in a channel that
keeps talking. Sessions therefore roll over at `CHAT_SESSION_MAX_TURNS` or
`CHAT_SESSION_MAX_AGE_MS`, whichever comes first, keeping the workspace and its
files. `/chat status` shows what a channel is carrying, `/chat reset` drops it,
and `/chat model` / `/chat effort` set per-channel overrides.

**What actually bounds this agent:**

| | |
|---|---|
| Who can reach it | `DISCORD_ADMIN_IDS`, at every entry point. This is the control. |
| Where it writes | A per-conversation scratch dir under `CHAT_WORKSPACE_ROOT` |
| How long it runs | `CHAT_MAX_TURNS`, and `/stop` |
| What it reads | Anything the bot's Unix user can read |

That last row is the honest one. **The workspace is hygiene, not a security
boundary** — it runs as the same user as the bot, so `.env` and the host's
`claude` credentials are reachable by an agent that has been talked into it.
The allowlist bounds who can *ask*; it does not bound what the agent *reads*,
and through the context menu and web tools it reads quoted messages,
screenshots and web pages that other people wrote. The system prompt treats all
of that as hostile input, because it is the only thing that does.

If this ever needs to be safe rather than merely gated — anything wider than
one trusted admin — it wants its own Unix user or a container, not a longer
system prompt.

### Asking about someone else's message

Replying to a post and mentioning the bot does *not* let it see that post. This
is a Discord boundary, not a bug: `MESSAGE_CONTENT` is a privileged intent, and
apps without it "receive empty values in fields that contain user-inputted
content" — `content`, `embeds`, `attachments`. Crucially that restriction
"affects the HTTP API endpoints your app is permitted to call" too, so fetching
the message you replied to returns it emptied. The exceptions are messages the
app sent, DMs, messages that mention it, and **the message a context menu
command is used on**.

That last exception is the way in. **Right-click any message → Apps → Ask
EousBot**, type a question (or leave it blank), and the bot gets that message's
full text and images without the privileged intent:

```
right-click a photo → Apps → Ask EousBot → "what breed is this?"
```

`src/commands/ask.ts` captures the message at right-click time and stashes it
for the modal, because it genuinely cannot be fetched again — re-reading the
same message by ID from the modal submit returns it blank. The stash is
in-memory with a 15-minute TTL, matching Discord's interaction token lifetime;
a restart in between asks you to right-click again rather than guessing.

The quoted message reaches the model fenced and labelled as third-party data,
with the closing tag neutralised so it can't break out of its own fence. It is
someone else's writing, delivered to an agent, which is exactly the shape
prompt injection takes.

**Chat is the fall-through; the review path requires positive evidence.** That
is the reverse of how this first shipped, and the reversal was earned: with
`revise` as the default, "fetch me the latest threads off /vt/" resolved to a
pull request and answered *"there are no open pull requests to act on"*. Five
of six ordinary requests misrouted that way — partly the fall-through, partly
because `REVISION_MARKERS` is a list of ordinary English verbs (`add`, `use`,
`change`, `remove`) that collide with almost any task. "add subtitles to this
clip" is not feedback on a pull request.

A message reaches the review path only via a reply to one of the bot's *review*
messages, an explicit `#11`, or approve/reject vocabulary that means nothing
outside a review. Note "review messages", not "the bot's messages" — replying
to an answer is how a conversation continues, and treating that as PR context
sent every follow-up to the revision agent.

The cost asymmetry points the same way: reading a task as feedback spends a
build and opens a PR nobody wanted; reading feedback as a task costs a retype.
And if the parser does pick `revise` when no PR can be resolved, the mention
handler answers it as chat rather than refusing — a revision with nothing to
revise is a misread, not an error.

Chat takes no inflight lock, so a question during a build is just a question.
It is serialised per person instead, so a double-ping can't pay twice.

**It is admin-only, and that is a billing decision rather than a safety one.**
Chat can't reach anything a build can. But in `hostAuth` mode every answer is
billed against the host account's Claude login, and `DISCORD_ADMIN_IDS` is the
only thing bounding who can spend it. Opening it to the whole guild means
setting a real `ANTHROPIC_API_KEY` in the same change — and note the usage gate
in `src/usagegate.ts` is a percentage-of-limits check, not a rate limiter.
Turn the feature off entirely with `CHAT_ENABLED=false`; see the `Chat` block
in `.env.example` for the model, effort, turn and web-search settings.

**No privileged intent is needed.** Discord delivers full content for messages
that mention an app even without `MessageContent`, so the bot reads what is
addressed to it and nothing else. It still cannot see the server's ordinary
conversation, and a stolen token still cannot scrape channel history.

## Iterating on a pull request

**Request changes** on the approval embed — or `/revise <pr>` for any open PR —
opens a modal for feedback, then puts the agent back on the same branch with it.

The command exists because a button only lives on the message that carried it:
embeds scroll away, channels get purged, and a PR opened before the button
shipped never had one. `/revise` reaches any open PR regardless.

Both are open to everyone, unlike approving and rejecting: whoever asked for a
feature is usually the one who can tell it is wrong. Because a revision spends
tokens, a non-admin's is refused unless the session and weekly usage windows
are both under 60% — the refusal names the window that is full and when it
resets. Admins are never gated.

The revision passes the same `tsc` and test gates as the
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

## Keeping token burn down

`docs/usage.md` measures where a build's tokens actually go, across every
feature this bot has shipped. The short version: cost is quadratic in turns,
because each turn re-reads the whole accumulated context — so anything that
adds turns, or adds tokens early, gets multiplied by every turn after it.

What the code does about it:

| | |
|---|---|
| `settingSources: ['project']` | Keeps the host account's global MCP tools and skills out of every request prefix |
| Revision rounds are stamped and counted | The fourth round is the most expensive; it should not also be the least visible |
| `AGENT_MAX_TURNS` defaults to 40 | A build that needs more is usually a request that should have been split |
| `/stop` | Interrupts a run mid-flight — the single biggest lever, and the one interactive sessions have had all along |

`/stop` is safe by construction: nothing is pushed until the gates pass, so an
interrupted run leaves the PR untouched and costs only what it had spent.

Watching a build live from the Claude app is **not** possible — Remote Control
attaches to interactive sessions, and an SDK-driven build is not one.
`docs/usage.md` records what was measured and the two architectural routes that
would work, so it doesn't get re-attempted.

## Drop alerts

`/restock` pings you when a Pokémon drop gets called. Off unless
`TARGET_RESTOCK_ENABLED=true`.

```
/restock watch keyword:target      ping me when a drop post mentions this word
/restock list
/restock unwatch keyword:target
/restock check item:<url|number>   read one Target listing right now
/restock sources                   which feeds, and are they healthy
```

**It alerts. It does not buy.** Target's terms prohibit automated purchasing, and
the anti-bot on checkout is what gets an account and a card banned. The part a
person actually loses a drop on isn't clicking — it's finding out forty minutes
late — so that's the part this deletes.

### Why it relays feeds instead of polling Target

Because there is nothing to poll. Measured, not assumed:

| Source | Host | Result |
|---|---|---|
| Product page HTML | `www.target.com` (Fastly) | **200** from anywhere. Title, purchase limit, seller, release date. |
| Live price + stock | `redsky.target.com` | **403 + CAPTCHA challenge**, identically from Azure and from residential. |

The page also sets `isProductDetailServerSideRenderPriceEnabled: false` and
carries no JSON-LD and no `og:availability`, so the HTML holds *no* stock signal
at all. Stock exists only behind the challenged endpoint. That challenge is
keyed on the request rather than the network, so no other host fixes it and
neither does waiting — and satisfying it is deliberately out of scope.

What works instead is other people. r/pkmntcgdeals posts "Target drop has
started!" minutes before it surfaces anywhere else, and the recurring
midnight-PST window is common knowledge there and available from no endpoint. So
`/restock watch` matches a keyword against public RSS and relays hits, product
links included. Reading an RSS feed is also something feeds are *for*, which the
alternative was not.

`/restock check` still reads a listing directly — it just reports the static
half, and says plainly when live stock is unreadable rather than looking like an
item that never restocked.

Target's own **Notify me when it's back** button remains the best first-party
option for a specific item.

### Feeds and rate limiting

Defaults to r/pkmntcgdeals; override with `TARGET_FEED_URLS` as
`name|url,name|url`. One timer for all sources, polled every ~2 minutes with
jitter, doubling backoff on any 429/403 up to an hour.

Reddit rate-limits unauthenticated readers hard — two requests back to back was
enough to earn a 429 while building this — so the interval is minutes, not
seconds, and the bot sends a descriptive User-Agent. Nothing is gained by going
faster: the humans writing these posts are the latency floor, not the feed.

The first poll after a fresh install only primes the dedupe list, so a new
install doesn't relay 25 old posts as if they were live drops. Both the
subscriptions and the seen-entry ids live in `state/eousbot.json`, so a
self-deploy landing mid-drop doesn't replay the channel.

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

`/usage` reports the plan limits builds run against. Why a build through
Discord costs more of them than the same change made in an interactive session
is measured and explained in [docs/usage.md](docs/usage.md).

## Layout

```
src/
  index.ts        gateway client, interaction router, allowlist enforcement
  config.ts       env validation; exits on bad config
  commands/       slash commands + the registry
  agent.ts        Claude Agent SDK wrapper and its system prompt
  chat.ts         Claude Code in a scratch workspace, reachable from Discord
  commands/ask.ts "Ask EousBot" on a right-clicked message
  unslop.ts       house style, injected into the chat system prompt
  intent.ts       reading intent from a mention (no imports, so tests are cheap)
  mention.ts      the @mention entry point: chat, build, revise, approve
  pipeline.ts     worktree → agent → typecheck → test → PR
  selfdeploy.ts   merge → pull → build → restart
  approval.ts     approval embed and button custom-ID codec
  github.ts       issues, labels, pull requests
  git.ts          worktree lifecycle, shell-free command execution
  naming.ts       pure helpers (no imports, so tests need no secrets)
  state.ts        the facts that must outlive a restart
  feed.ts         drop-feed parsing, matching, dedupe, backoff (pure)
  feedwatch.ts    the feed polling timer and the Discord side
  target.ts       parsing a Target listing (pure)
  targetapi.ts    fetching one, and the CAPTCHA wall behind live stock
  listing.ts      rendering what we can read about a listing (pure)
infra/
  install.sh      install/update on an existing Linux box
  eousbot.service systemd user unit
```
