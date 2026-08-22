import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_EFFORT, EFFORT_LEVELS } from "./agentopts.js";

/**
 * Environment is validated once, at boot, and never re-read.
 *
 * A bot that rewrites and redeploys itself must fail loudly on bad config
 * rather than limp along: a missing GITHUB_TOKEN discovered halfway through a
 * build leaves a worktree and a pushed branch with no PR to explain them.
 */

/**
 * Load .env when one is present.
 *
 * Under systemd the unit's EnvironmentFile= has already populated process.env,
 * so this is a no-op that reloads identical values. Running locally there is
 * nothing else doing it, and without this every entry point -- `npm run dev`,
 * `deploy-commands`, `npm start` -- sees an empty environment and dies in
 * validation below.
 *
 * process.loadEnvFile is built into Node >= 21.7, so this costs no dependency.
 */
try {
  process.loadEnvFile();
} catch (err) {
  // ENOENT is the normal case in any environment that injects config directly
  // (containers, CI). Anything else is a malformed file worth surfacing.
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error(`Could not read .env: ${String(err)}`);
  }
}

const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
  DISCORD_APP_ID: z.string().min(1, "DISCORD_APP_ID is required"),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID is required"),
  DISCORD_CHANNEL_ID: z.string().min(1, "DISCORD_CHANNEL_ID is required"),
  DISCORD_ADMIN_IDS: z.string().default(""),

  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),

  // Optional. When unset, the Agent SDK falls back to whatever credentials
  // `claude` is logged in with on this machine. See config.agent.authMode.
  ANTHROPIC_API_KEY: z.string().optional(),

  AGENT_MODEL: z.string().default("claude-opus-5"),
  // 60 was a ceiling nothing ever approached -- the most expensive build
  // measured used 82 requests across four review rounds, not one run. A lower
  // bound turns "this is going badly" into a fast, cheap failure instead of a
  // long one. See docs/usage.md.
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(40),

  // Standing reasoning effort for builds; /claude can override it per build.
  AGENT_EFFORT: z.enum(EFFORT_LEVELS).default(DEFAULT_EFFORT),

  // How much of each build session is reachable from the Claude app.
  //   off    - nothing leaves the box
  //   view   - mirrored to claude.ai read-only (autoUploadSessions)
  //   remote - also starts the Remote Control bridge, so you can steer it
  AGENT_SESSION_VISIBILITY: z.enum(["off", "view", "remote"]).default("view"),

  // ---------------------------------------------------------------- chat ---
  // Answering a question put to the bot by mentioning it. Kept apart from the
  // AGENT_* settings on purpose: a build is one long run over a source tree,
  // a chat turn is a short run over nothing, and giving the two the same model
  // and turn ceiling would mean paying build prices to be asked the time.
  CHAT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  CHAT_MODEL: z.string().default("claude-sonnet-5"),
  // Higher than it was when chat could only search and answer: this agent has
  // a shell and is expected to actually finish jobs.
  CHAT_EFFORT: z.enum(EFFORT_LEVELS).default("medium"),
  // Enough to fetch thirty files, write a script and run it. Still a ceiling:
  // a conversational run bills the same as any other.
  CHAT_MAX_TURNS: z.coerce.number().int().positive().default(30),
  // Where conversational agents get their scratch directory. Never the
  // checkout -- see chat.ts. Blank uses a subdirectory of the system temp dir.
  CHAT_WORKSPACE_ROOT: z.string().default(""),
  // How long a Discord channel's session and workspace survive between
  // messages, so a follow-up continues rather than starting over.
  CHAT_CONVERSATION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60 * 1000),
  // Total bytes of agent-produced files attached to one reply. Discord's own
  // ceiling is 10MB on an unboosted guild; this stays under it.
  CHAT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(8_000_000),

  // Optional. Derived from this module's own location by default -- see
  // defaultRepoPath below. Only set it if the checkout genuinely isn't the
  // one this code was loaded from.
  REPO_PATH: z.string().optional(),
  SYSTEMD_UNIT: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // ------------------------------------------------------------- /restock ---
  // Drop alerting is opt-in. It is the only feature that talks to a third party
  // on a timer.
  TARGET_RESTOCK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Used by `/restock check`, which reads a listing's static facts. Pricing and
  // pickup are per-store; the default is a real store and will answer, but it
  // won't be *your* prices.
  TARGET_STORE_ID: z.string().default("1234"),
  TARGET_ZIP: z.string().default(""),
  TARGET_STATE: z.string().default(""),
  // Feeds to relay, comma-separated as `name|url`. Left blank, the defaults
  // below are used.
  TARGET_FEED_URLS: z.string().default(""),
  // Minutes, not seconds. Reddit rate-limits unauthenticated readers hard, and
  // the humans writing these posts are the latency floor regardless.
  TARGET_FEED_POLL_MS: z.coerce.number().int().min(60_000).default(120_000),
});

/**
 * The checkout this code was loaded from.
 *
 * REPO_PATH used to be a required setting, which made it the one value in
 * .env that could not be shared between machines: copying a laptop's .env to a
 * server carried a path that does not exist there, and the first symptom was
 * `git fetch` failing to spawn with an empty error twenty minutes later.
 *
 * Deriving it from `import.meta.url` cannot be wrong: dist/config.js and
 * src/config.ts both sit one level below the repo root, so this resolves
 * correctly whether running compiled or under tsx.
 */
function defaultRepoPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Feeds relayed by /restock, when TARGET_FEED_URLS doesn't override them.
 *
 * Reddit's per-subreddit RSS needs no key and no account. r/pkmntcgdeals is the
 * default because it is where Target drops get called *before* they land --
 * "Target drop has started!" and the recurring midnight-PST window are common
 * knowledge there and available from no endpoint.
 */
const DEFAULT_FEEDS: { name: string; url: string }[] = [
  { name: "r/pkmntcgdeals", url: "https://www.reddit.com/r/pkmntcgdeals/new.rss" },
];

/** `name|url,name|url`. A bare URL is allowed and names itself after its host. */
function parseFeeds(raw: string): { name: string; url: string }[] {
  const entries = csv(raw)
    .map((item) => {
      const [first, second] = item.split("|").map((s) => s.trim());
      const url = second ?? first;
      if (!url || !/^https?:\/\//.test(url)) return null;
      const name = second ? (first ?? url) : new URL(url).hostname;
      return { name, url };
    })
    .filter((f): f is { name: string; url: string } => f !== null);

  return entries.length > 0 ? entries : DEFAULT_FEEDS;
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

const env = parsed.data;

const repoPath = env.REPO_PATH ?? defaultRepoPath();

// Fail here rather than mid-build. A REPO_PATH that doesn't resolve to a git
// checkout makes every git call fail to spawn, and a spawn failure carries no
// stderr -- so the symptom is an empty error message from whichever command
// happened to run first, pointing nowhere near the cause.
if (!existsSync(resolve(repoPath, ".git"))) {
  console.error(
    `REPO_PATH does not look like a git checkout: ${repoPath}\n` +
      (env.REPO_PATH
        ? "It was set explicitly in the environment. Unset it to derive the path " +
          "from this code's own location, which is correct on any machine."
        : "This was derived from the running code's location, which is unexpected.") +
      "\n",
  );
  process.exit(1);
}

export const config = {
  discord: {
    token: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    /**
     * The complete allowlist for privileged actions. Everything that can cause
     * the bot to write or ship code is gated on membership here.
     */
    adminIds: new Set(csv(env.DISCORD_ADMIN_IDS)),
  },
  github: {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
  },
  agent: {
    /**
     * `apiKey`  - metered Anthropic API spend, billed per token.
     * `hostAuth` - inherit whatever `claude` is logged in as on this box.
     *
     * The Agent SDK resolves credentials the same way the CLI does, so the
     * second mode needs no relay: simply leaving ANTHROPIC_API_KEY unset lets
     * the SDK pick up the host's login. See the note in README.md on when
     * that's appropriate -- it is a licensing question, not a technical one.
     */
    authMode: env.ANTHROPIC_API_KEY ? ("apiKey" as const) : ("hostAuth" as const),
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.AGENT_MODEL,
    effort: env.AGENT_EFFORT,
    maxTurns: env.AGENT_MAX_TURNS,
    sessionVisibility: env.AGENT_SESSION_VISIBILITY,
  },
  /**
   * Conversational replies to a mention. See chat.ts for what this agent is
   * allowed to touch, which is almost nothing.
   */
  chat: {
    enabled: env.CHAT_ENABLED,
    model: env.CHAT_MODEL,
    effort: env.CHAT_EFFORT,
    maxTurns: env.CHAT_MAX_TURNS,
    workspaceRoot: env.CHAT_WORKSPACE_ROOT,
    conversationTtlMs: env.CHAT_CONVERSATION_TTL_MS,
    maxUploadBytes: env.CHAT_MAX_UPLOAD_BYTES,
  },
  runtime: {
    repoPath,
    systemdUnit: env.SYSTEMD_UNIT,
    logLevel: env.LOG_LEVEL,
  },
  /**
   * Drop alerting. See feed.ts for why this relays community feeds rather than
   * polling Target directly, and commands/restock.ts for what it won't do.
   */
  target: {
    enabled: env.TARGET_RESTOCK_ENABLED,
    storeId: env.TARGET_STORE_ID,
    zip: env.TARGET_ZIP,
    state: env.TARGET_STATE,
    feeds: parseFeeds(env.TARGET_FEED_URLS),
    poll: {
      baseMs: env.TARGET_FEED_POLL_MS,
      // Jitter so a restart doesn't put every deploy's first poll on the same
      // second of the minute.
      jitterMs: 15_000,
      backoffStartMs: 300_000,
      backoffMaxMs: 3_600_000,
      maxConsecutiveBlocks: 5,
    },
  },
} as const;

/** Privileged actions: /claude, and clicking Approve or Reject on a PR. */
export function isAdmin(userId: string): boolean {
  return config.discord.adminIds.has(userId);
}

if (config.discord.adminIds.size === 0) {
  console.warn(
    "DISCORD_ADMIN_IDS is empty - /claude and PR approval are disabled for everyone. " +
      "Set it to your Discord user ID to enable self-modification.",
  );
}
