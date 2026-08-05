# Why a build costs more than the same work done interactively

Short answer: it is not imagination. A feature built through Discord burns
noticeably more of the shared Claude limits than the same feature typed into an
interactive `claude` session would, and the reasons are structural rather than
mysterious. This document records what was measured, what explains it, and
which levers would actually move the number.

The measurements below were taken before any of it was fixed. The levers at the
end have since been applied — see that section for what changed and where — so
read the numbers as the starting point, not the current state.

## What was measured

Every agent run leaves a transcript under
`~/.claude/projects/<slugified-worktree-path>/*.jsonl`, one JSON object per
message, each assistant message carrying its own `usage` block. Summing those
(deduplicated by message ID -- a message with several content blocks appears
more than once) gives the real per-build token accounting.

Ten builds, 2026-08-04 to 2026-08-05 -- every feature this bot has shipped,
excluding the in-progress run that produced this file. `cc` is cache-creation
input, `cr` is cache-read input, `out` is output:

| build | requests | cc | cr | out |
| --- | --- | --- | --- | --- |
| add-lenny | 12 | 22,773 | 264,513 | 7,559 |
| create-an-8ball-command | 12 | 23,341 | 271,627 | 6,330 |
| hoyohell (redo) | 16 | 33,198 | 416,649 | 6,942 |
| add-a-roll-command | 19 | 48,460 | 425,853 | 16,143 |
| dial-down-effort-default | 16 | 29,823 | 444,976 | 6,990 |
| add-a-usage-feature | 33 | 55,568 | 1,421,742 | 16,714 |
| update-change-request-workflow | 41 | 71,407 | 2,334,759 | 28,040 |
| create-a-hoyohell-command | 44 | 91,021 | 2,687,803 | 49,117 |
| remindme | 82 | 353,755 | 5,201,111 | 40,455 |
| allow-custom-model-effort | 29 | 306,774 | 6,562,308 | 21,281 |
| **total** | **304** | **1,036,120** | **20,031,341** | **199,571** |

Two things stand out immediately. Input dwarfs output by a hundred to one --
that is normal for any agentic loop and is not the interesting part. The
interesting part is the spread: the cheapest build read 264k tokens of context
across its whole life, the most expensive read 6.5M. Same repository, same
model, same system prompt. A twenty-five-fold range.

The expensive builds are not the ones with the most code in them. They are the
ones that went through several rounds of review feedback.

## Why builds cost what they do

### Context is re-read on every single turn, so cost is quadratic in turns

Each turn sends the entire accumulated conversation back. A session that has
read six files and run the test suite twice carries all of that on turn twenty
as well as on turn seven. Average context per request, measured:

- `add-lenny`, 12 requests: 24k tokens per request
- `remindme`, 82 requests: 68k tokens per request
- `allow-custom-model-effort`, 29 requests: 237k per request, peaking at 314k

This is the mechanism behind everything below. Anything that adds turns, or
adds tokens early in a session, gets multiplied by every turn that follows.

### Every build starts cold, and nothing is ever reused between builds

`buildFeature` creates a throwaway worktree (`src/pipeline.ts:103`) and
`runAgent` opens a brand-new session in it. That means a fresh project
directory, a fresh transcript, and no prompt cache to hit. The agent re-reads
`agent.ts`, `config.ts`, `pipeline.ts` and `index.ts` from scratch on every
build, because as far as it is concerned it has never seen them.

Interactively, five small tasks in an afternoon share one warm session: you
pay for the exploration once and the next four tasks read it back at cache
prices. Through Discord, five requests are five cold sessions, each paying
full price to learn the same repository again. Cold-start cache creation
itself is small -- 6.5k to 8.7k tokens for the system prompt and tool
definitions -- but the re-exploration that follows it is not.

### Revisions resume a session that has gone cold, and compound

`reviseFeature` resumes the original session when the PR body records its ID.
That is the right call for output quality, and it does mean the second round
starts from an already-large transcript rather than a fresh one.

What it cannot avoid is the clock. A review round happens minutes or hours
after the build, long past any prompt-cache TTL, so resuming re-writes the
whole accumulated transcript as cache-creation input at 1.25x the base input
rate before the first new token is generated. Measured on `remindme`, each
cold re-entry into that session re-wrote more than the last: 35k, then 58k,
then 79k, then 91k tokens, paid up front, four times, for one feature.

That is the honest explanation for the two outliers in the table. Both had
several rounds of feedback; both ended up carrying a context several times
larger than any single-shot build ever reaches.

There is also a failure mode worth knowing about: if a resume fails and the
error text matches `looksLikeMissingSession` (`src/agent.ts:225`), the
revision is retried from scratch in a fresh session (`src/agent.ts:216`). The
retry is deliberate and correct when the session really is gone. The regex is
broad -- `/session|resume|not found|no such/i` -- so an unrelated failure
whose message merely contains the word "session" costs a second full agent run
for one revision.

### The agent is required to run the gates, and a human never is

The system prompt tells the agent that `npm run typecheck` and `npm test` must
both pass and that it has to run them itself. The harness then re-runs both
(`src/pipeline.ts:69`) because the agent's own claim is not evidence.

That is the correct design for unattended work, and it is not free. Every
build, however trivial, ends with at least two full command round-trips whose
output enters the context and is then re-read on every subsequent turn. Typing
the same one-line change interactively, you would usually skip both.

### Nothing stops a run early

`maxTurns` was the *only* stop condition: builds run unattended, so there was
no one to read three paragraphs of exploration and say "yes, that file, just
change the constant". Interactive sessions get interrupted constantly, and
every interruption is turns not taken.

This was the most fixable finding in the document, and it is now fixed —
`/stop` and `/active` exist because of it. See **Active mode** below.

Effort was already dialled back from the SDK default to `medium` for exactly
this reason (see `DEFAULT_EFFORT` in `src/agentopts.ts`), which is why recent
single-shot builds sit in the 16-request, 440k-token band rather than higher.

### A failed gate burns everything and buys nothing

If typecheck or tests fail in the harness, the worktree is destroyed, no PR is
opened, and the entire token cost of that build is spent on a comment
explaining the failure. Retrying starts cold again. Interactively that same
failure costs one more turn in a session that already has all the context.

### Build sessions inherit the host CLI's whole environment

`runAgent` does not set `settingSources`, and the SDK's documented default is
"all sources are loaded (matches CLI defaults)". In `hostAuth` mode the
session also inherits the logged-in account's claude.ai connectors. So a build
dispatched to add a Discord command comes up with whatever MCP servers, skills
and plugins the host account happens to have configured -- in the session that
wrote this document, roughly ninety MCP tools across Robinhood, Google Drive,
Google Calendar and Credit Karma, plus ten skills, none of which a Discord bot
will ever call.

Tool and skill descriptions live in the request prefix, so their cost is not
paid once. It is paid on every turn of every build, and it lands at the front
of the context where it is guaranteed to be re-read the most. Interactively
this is invisible: you chose those connectors, and you are the one using them.

## What is *not* the cause

Two things look like they should be expensive and are not, so that they can be
ruled out rather than re-investigated:

- **`fetchUsage`** (`src/agent.ts`) opens a session per call, including once
  after every agent run. It streams no input and no turn ever runs, so it
  costs process spawn time and zero tokens.
- **The usage-reset watcher** (`src/usagewatch.ts`) polls nothing. It arms a
  timer from reset times that a reading already carried.

## Levers, most effective first

All of these are now applied. What follows is what was done and where, so the
next measurement can tell which of them actually moved the number.

1. **`settingSources: ['project']` on the build query** (`src/agent.ts`).
   Omitting the field loaded every filesystem settings source, so each build
   inherited the host account's global MCP servers and skills — roughly ninety
   tool schemas — in the prefix of every request of every turn. Applied as
   `['project']` rather than the `[]` originally suggested: the repository has
   no `.claude/` today so the saving is identical, but a `CLAUDE.md` added
   later reaches the agent without a code change.

   Worth measuring rather than assuming: in `hostAuth` mode the account's
   claude.ai connectors may not be governed by this setting at all. The next
   transcript sample will show whether the prefix actually shrank.

2. **Review rounds are counted and surfaced.** Each revision stamps
   `_Revision N, $cost_` into the PR body, and from round three Discord says
   plainly that a rebuild from a sharper request is often cheaper than another
   round. Nothing is blocked — the point is that the fourth round was the most
   expensive one *and* the least visible.

3. **`looksLikeMissingSession` now requires both halves** (`src/naming.ts`):
   the error must mention a session *and* mention absence. The old pattern
   matched any error containing "session", so an unrelated failure bought a
   second full agent run. Covered by `test/usage-levers.test.ts`.

4. **`AGENT_MAX_TURNS` defaults to 40** (`src/config.ts`), and hitting the
   ceiling now says so instead of surfacing as a bare subtype — the work is
   half-done and the whole run is paid for, which is worth naming.

5. **Active mode** (`/active`) turns on Remote Control for builds while
   someone is around, and **`/stop`** interrupts a run from Discord. This was
   the last lever, and it turned out to be the largest behavioural one: see
   below.

## Active mode

The section above lists "nothing stops a run early" as a cost driver in its own
right, because every remaining turn re-reads the entire accumulated context. A
run that is visibly going nowhere gets *more* expensive the longer nobody stops
it, and unattended builds had no stop condition but `maxTurns`.

`/stop` interrupts the agent mid-run through the SDK's `interrupt()`. It is
safe by construction: nothing is pushed until the gates pass, so an interrupted
run leaves the PR untouched and costs only what it had already spent. A stopped
build is reported as stopped rather than failed, and its request returns to the
queue rather than being labelled broken.

`/active on` opens the Remote Control bridge for new builds, so a run can be
steered from the Claude app instead of watched through Discord progress text.
It is a toggle rather than a setting because it uploads session transcripts to
claude.ai, which is the wrong default for runs nobody is watching. It can only
raise visibility: `AGENT_SESSION_VISIBILITY=off` still wins, since someone who
set that wants nothing leaving the box.

Together these are the interactive session's real advantage, which is not a
cheaper model or a shorter prompt — it is a human who interrupts.
