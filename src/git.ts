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
    const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
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

export async function push(worktreePath: string, branch: string): Promise<void> {
  const res = await git(["push", "--force-with-lease", "origin", `${branch}:${branch}`], worktreePath);
  if (!res.ok) throw new Error(`git push failed: ${res.stderr}`);
}

export async function currentSha(cwd = config.runtime.repoPath): Promise<string> {
  const res = await git(["rev-parse", "HEAD"], cwd);
  return res.stdout.trim();
}
