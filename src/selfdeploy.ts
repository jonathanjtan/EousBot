import { config } from "./config.js";
import * as gh from "./github.js";
import { LABELS } from "./github.js";
import { currentSha, git, run } from "./git.js";
import { describe, held } from "./inflight.js";
import { log } from "./log.js";
import { setPendingAnnouncement } from "./state.js";

/**
 * Merge, pull, build, restart.
 *
 * This is the only path by which agent-written code reaches the running bot,
 * and it runs exclusively from an allowlisted human's button click. Everything
 * before it produces reviewable artifacts; everything here is irreversible.
 *
 * The restart is delegated to systemd rather than performed in-process: a
 * process cannot cleanly replace its own code, but it can exit and let a
 * supervisor start the new build. The announcement of what happened is
 * therefore written to disk *before* exiting, and delivered by the next boot.
 */

export type DeployOutcome =
  | { kind: "restarting"; sha: string }
  | { kind: "deployed-no-restart"; sha: string }
  | { kind: "failed"; stage: string; detail: string };

export interface DeployProgress {
  (stage: string, detail?: string): void;
}

function tail(text: string, lines = 30): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

export async function approveAndDeploy(opts: {
  prNumber: number;
  issueNumber: number | null;
  title: string;
  approvedBy: string;
  approvedByName: string;
  channelId: string;
  onProgress?: DeployProgress;
}): Promise<DeployOutcome> {
  const onProgress = opts.onProgress ?? (() => {});

  // A deploy restarts the service, which SIGTERMs any agent mid-run: its
  // worktree is orphaned, its Discord message freezes at the last progress
  // edit, and minutes of work are gone with no explanation. Refuse rather
  // than race.
  const busy = held();
  if (busy) {
    return {
      kind: "failed",
      stage: "precheck",
      detail: `${describe(busy)} is still running. Deploying now would restart the bot and kill it. Try again when it finishes.`,
    };
  }

  // Re-check mergeability at click time. The PR may have gone stale, been
  // closed, or picked up a conflict since the approval prompt was posted.
  onProgress("Checking pull request");
  const pr = await gh.getPullRequest(opts.prNumber);
  if (pr.state !== "open") {
    return { kind: "failed", stage: "precheck", detail: `PR #${opts.prNumber} is ${pr.state}, not open.` };
  }
  if (pr.mergeable === false) {
    return { kind: "failed", stage: "precheck", detail: `PR #${opts.prNumber} has conflicts and cannot be merged.` };
  }

  onProgress("Merging");
  let sha: string;
  try {
    const merged = await gh.mergePullRequest(
      opts.prNumber,
      `${opts.title} (#${opts.prNumber})`,
    );
    sha = merged.sha;
  } catch (err) {
    return { kind: "failed", stage: "merge", detail: err instanceof Error ? err.message : String(err) };
  }

  if (opts.issueNumber !== null) {
    await gh.setStatus(opts.issueNumber, LABELS.shipped).catch(() => undefined);
  }

  onProgress("Pulling merged code");
  const branch = pr.base.ref;
  const fetched = await git(["fetch", "origin", branch]);
  if (!fetched.ok) return { kind: "failed", stage: "fetch", detail: tail(fetched.stderr) };

  // Hard reset rather than merge: the deploy checkout is a mirror of origin,
  // never a place where work happens, so divergence is corruption, not history.
  const reset = await git(["reset", "--hard", `origin/${branch}`]);
  if (!reset.ok) return { kind: "failed", stage: "reset", detail: tail(reset.stderr) };

  onProgress("Installing dependencies");
  // Dev dependencies are REQUIRED here: the bot compiles itself on deploy, and
  // typescript is a devDependency. `--omit=dev` succeeds, strips tsc, and then
  // `npm run build` dies with "sh: 1: tsc: not found" one step later -- a
  // failure that points at the build and is actually caused by the install.
  const install = await run("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: config.runtime.repoPath,
    timeoutMs: 10 * 60_000,
  });
  if (!install.ok) {
    // A lockfile the agent changed can defeat `npm ci`; fall back rather than
    // stranding a merged commit unbuilt.
    const full = await run("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: config.runtime.repoPath,
      timeoutMs: 10 * 60_000,
    });
    if (!full.ok) return { kind: "failed", stage: "install", detail: tail(full.stderr) };
  }

  onProgress("Compiling");
  const built = await run("npm", ["run", "build"], {
    cwd: config.runtime.repoPath,
    timeoutMs: 10 * 60_000,
  });
  if (!built.ok) {
    // The PR typechecked in a clean worktree, so reaching here means the merge
    // itself broke the build. Leave the tree as-is for a human to inspect.
    return { kind: "failed", stage: "build", detail: tail(`${built.stdout}\n${built.stderr}`) };
  }

  const deployedSha = await currentSha();
  log.info("Self-deploy built successfully", { sha: deployedSha, pr: opts.prNumber });

  if (!config.runtime.systemdUnit) {
    return { kind: "deployed-no-restart", sha: deployedSha };
  }

  // Written before the restart, delivered after it.
  setPendingAnnouncement({
    channelId: opts.channelId,
    prNumber: opts.prNumber,
    issueNumber: opts.issueNumber,
    title: opts.title,
    expectedSha: deployedSha,
    approvedBy: opts.approvedByName,
    at: new Date().toISOString(),
  });

  onProgress("Restarting");
  log.info("Restarting via systemd", { unit: config.runtime.systemdUnit });

  // `restart` from inside the unit would have systemd kill this process
  // mid-call. `--no-block` returns immediately and lets the exit below be the
  // clean shutdown, rather than a SIGKILL during an await.
  const restart = await run(
    "systemctl",
    ["--user", "restart", "--no-block", config.runtime.systemdUnit],
    { cwd: config.runtime.repoPath, timeoutMs: 30_000 },
  );
  if (!restart.ok) {
    return { kind: "failed", stage: "restart", detail: tail(restart.stderr) };
  }

  return { kind: "restarting", sha: deployedSha };
}

export async function rejectPullRequest(opts: {
  prNumber: number;
  issueNumber: number | null;
  rejectedByName: string;
  reason?: string;
}): Promise<void> {
  const reason = opts.reason?.trim()
    ? `Rejected by ${opts.rejectedByName} via Discord: ${opts.reason.trim()}`
    : `Rejected by ${opts.rejectedByName} via Discord.`;

  await gh.closePullRequest(opts.prNumber, reason);

  if (opts.issueNumber !== null) {
    // Back to the request pile, not closed -- a rejected generation doesn't
    // mean the feature was a bad idea, just that this attempt at it was.
    await gh.setStatus(opts.issueNumber, LABELS.failed).catch(() => undefined);
    await gh
      .comment(opts.issueNumber, `Generated pull request #${opts.prNumber} was rejected. ${reason}`)
      .catch(() => undefined);
  }
}
