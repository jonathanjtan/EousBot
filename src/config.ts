import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EFFORT_LEVELS } from "./agentopts.js";

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
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(60),

  // Optional. Standing reasoning effort for builds; /build can override it per
  // build. Unset leaves the Agent SDK's own default in place.
  AGENT_EFFORT: z.enum(EFFORT_LEVELS).optional(),

  // How much of each build session is reachable from the Claude app.
  //   off    - nothing leaves the box
  //   view   - mirrored to claude.ai read-only (autoUploadSessions)
  //   remote - also starts the Remote Control bridge, so you can steer it
  AGENT_SESSION_VISIBILITY: z.enum(["off", "view", "remote"]).default("view"),

  // Optional. Derived from this module's own location by default -- see
  // defaultRepoPath below. Only set it if the checkout genuinely isn't the
  // one this code was loaded from.
  REPO_PATH: z.string().optional(),
  SYSTEMD_UNIT: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
    effort: env.AGENT_EFFORT ?? null,
    maxTurns: env.AGENT_MAX_TURNS,
    sessionVisibility: env.AGENT_SESSION_VISIBILITY,
  },
  runtime: {
    repoPath,
    systemdUnit: env.SYSTEMD_UNIT,
    logLevel: env.LOG_LEVEL,
  },
} as const;

/** Privileged actions: /build, and clicking Approve or Reject on a PR. */
export function isAdmin(userId: string): boolean {
  return config.discord.adminIds.has(userId);
}

if (config.discord.adminIds.size === 0) {
  console.warn(
    "DISCORD_ADMIN_IDS is empty - /build and PR approval are disabled for everyone. " +
      "Set it to your Discord user ID to enable self-modification.",
  );
}
