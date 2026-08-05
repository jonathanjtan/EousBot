import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs a command without a shell. Every argument here is at least partly
 * derived from Discord input (issue titles become branch names), so `execFile`
 * with an argv array is the whole defence against shell metacharacters.
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: config.runtime.repoPath },
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
      signal?: string;
    };

    // `??` was wrong here: a spawn failure (ENOENT for a missing binary or a
    // missing cwd) sets stderr to the empty *string*, which ?? happily keeps,
    // discarding the only useful text. That turned a bad REPO_PATH into
    // "git fetch failed: " with nothing after the colon.
    const detail =
      (e.stderr && e.stderr.trim()) ||
      (e.stdout && e.stdout.trim()) ||
      e.message ||
      "command failed with no output";

    // Spawn failures carry a string code (ENOENT, EACCES); exits carry a
    // number. Keep the distinction visible instead of flattening both to 1.
    const context =
      typeof e.code === "string"
        ? ` (${e.code}${e.code === "ENOENT" ? ` -- missing binary "${cmd}" or missing cwd "${opts.cwd}"` : ""})`
        : e.signal
          ? ` (killed by ${e.signal})`
          : "";

    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: `${detail}${context}`,
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export const git = (args: string[], cwd = config.runtime.repoPath) => run("git", args, { cwd });

export interface Worktree {
  path: string;
  branch: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated worktree for the agent to write in.
 *
 * The agent gets real filesystem and shell access, so this is containment
 * rather than a sandbox: it bounds *what the agent edits* to a throwaway
 * checkout, keeping the running bot's own tree untouched while it works.
 * A bad generation costs a deleted directory, not a broken deployment.
 */
export async function createWorktree(branch: string, baseBranch: string): Promise<Worktree> {
  const path = join(config.runtime.repoPath, ".worktrees", branch.replace(/\//g, "_"));

  await rm(path, { recursive: true, force: true });
  // Drop any stale registration left by a previous crashed build.
  await git(["worktree", "prune"]);
  await git(["branch", "-D", branch]).catch(() => undefined);

  const fetched = await git(["fetch", "origin", baseBranch]);
  if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr}`);

  const created = await git(["worktree", "add", "-b", branch, path, `origin/${baseBranch}`]);
  if (!created.ok) throw new Error(`git worktree add failed: ${created.stderr}`);

  log.info("Worktree created", { branch, path });

  return {
    path,
    branch,
    cleanup: async () => {
      await git(["worktree", "remove", "--force", path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await git(["worktree", "prune"]).catch(() => undefined);
      log.debug("Worktree cleaned up", { branch });
    },
  };
}

/**
 * Creates a worktree on an *existing* remote branch, for revising an open PR.
 *
 * The difference from createWorktree matters: that one starts from the base
 * branch, which is right for a new feature and wrong for a revision. Revising
 * has to build on what the agent already wrote, or the reviewer's feedback
 * arrives at a tree that no longer contains the thing being critiqued.
 */
export async function createWorktreeOnBranch(branch: string): Promise<Worktree> {
  const path = join(config.runtime.repoPath, ".worktrees", branch.replace(/\//g, "_"));

  await rm(path, { recursive: true, force: true });
  await git(["worktree", "prune"]);
  // Drop the local ref so the worktree tracks the remote's current tip rather
  // than a stale local copy from the build that created it.
  await git(["branch", "-D", branch]);

  const fetched = await git(["fetch", "origin", branch]);
  if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr}`);

  const created = await git(["worktree", "add", "-b", branch, path, `origin/${branch}`]);
  if (!created.ok) throw new Error(`git worktree add failed: ${created.stderr}`);

  log.info("Worktree created on existing branch", { branch, path });

  return {
    path,
    branch,
    cleanup: async () => {
      await git(["worktree", "remove", "--force", path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await git(["worktree", "prune"]).catch(() => undefined);
      log.debug("Worktree cleaned up", { branch });
    },
  };
}

/**
 * Merges the base branch into a worktree, reporting any conflicted files.
 *
 * Keeping this in the harness rather than the agent's hands is deliberate.
 * Merging is a git *write*, which the agent is told not to perform, so a
 * branch that had fallen behind main left it with an impossible task -- and it
 * improvised, which is worse than either outcome. The harness merges; the
 * agent only edits the conflicted files, which is ordinary work it is allowed
 * to do; the harness commits the result.
 *
 * GIT_EDITOR=true matters more than it looks: `git merge` opens an editor for
 * the merge message, and a child process with a pipe for stdin that nobody
 * writes to blocks until the timeout rather than failing.
 */
export async function mergeBaseInto(
  worktreePath: string,
  baseBranch: string,
): Promise<{ merged: true } | { merged: false; conflicts: string[] }> {
  const fetched = await git(["fetch", "origin", baseBranch], worktreePath);
  if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr}`);

  const merge = await run(
    "git",
    ["-c", "core.editor=true", "merge", "--no-edit", `origin/${baseBranch}`],
    { cwd: worktreePath, env: { ...process.env, GIT_EDITOR: "true" }, timeoutMs: 120_000 },
  );

  if (merge.ok) {
    log.info("Base merged cleanly", { baseBranch });
    return { merged: true };
  }

  const unmerged = await git(["diff", "--name-only", "--diff-filter=U"], worktreePath);
  const conflicts = unmerged.stdout.trim().split("\n").filter(Boolean);

  if (conflicts.length === 0) {
    // Failed for some reason other than conflicts; abort so the tree is not
    // left half-merged for the agent to trip over.
    await git(["merge", "--abort"], worktreePath).catch(() => undefined);
    throw new Error(`git merge failed without conflicts: ${merge.stderr}`);
  }

  log.info("Base merged with conflicts", { baseBranch, conflicts });
  return { merged: false, conflicts };
}

export async function hasChanges(worktreePath: string): Promise<boolean> {
  const res = await git(["status", "--porcelain"], worktreePath);
  return res.stdout.trim().length > 0;
}

export async function diffStat(worktreePath: string, baseBranch: string): Promise<string> {
  const res = await git(["diff", "--stat", `origin/${baseBranch}`, "--"], worktreePath);
  return res.stdout.trim();
}

export async function commitAll(worktreePath: string, message: string): Promise<void> {
  const added = await git(["add", "-A"], worktreePath);
  if (!added.ok) throw new Error(`git add failed: ${added.stderr}`);

  const commit = await git(
    ["commit", "--author", "EousBot <eousbot@users.noreply.github.com>", "-m", message],
    worktreePath,
  );
  if (!commit.ok) throw new Error(`git commit failed: ${commit.stderr}`);
}

/**
 * Pushes the agent's branch, authenticating with GITHUB_TOKEN.
 *
 * The box clones anonymously (the repo is public), so nothing on disk can
 * authenticate a *write*. Rather than persisting a credential, this supplies
 * an inline credential helper for the single invocation and passes the token
 * through the environment.
 *
 * The token deliberately does not go in the URL or in argv: both would put it
 * in `ps` output and, for the URL form, in .git/config afterwards. git spawns
 * the helper through a shell itself, so no shell is involved on our side.
 */
export async function push(worktreePath: string, branch: string): Promise<void> {
  const helper =
    '!f() { echo "username=x-access-token"; echo "password=$EOUS_GITHUB_TOKEN"; }; f';

  const res = await run(
    "git",
    [
      // Clear any inherited helper first, so a misconfigured global helper
      // can't answer before ours does.
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "push",
      "--force-with-lease",
      "origin",
      `${branch}:${branch}`,
    ],
    {
      cwd: worktreePath,
      env: { ...process.env, EOUS_GITHUB_TOKEN: config.github.token },
    },
  );

  if (!res.ok) {
    // Never surface stderr verbatim without scrubbing: git echoes the remote
    // URL on failure, and a future switch to a token-bearing URL would leak it
    // straight into a Discord message.
    const scrubbed = res.stderr.replace(/https:\/\/[^@\s]+@/g, "https://***@");
    throw new Error(`git push failed: ${scrubbed}`);
  }
}

export async function currentSha(cwd = config.runtime.repoPath): Promise<string> {
  const res = await git(["rev-parse", "HEAD"], cwd);
  return res.stdout.trim();
}
