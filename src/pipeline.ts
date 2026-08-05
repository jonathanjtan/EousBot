import { fetchUsage, implementFeature, reviseFeature } from "./agent.js";
import { describeAgentOptions } from "./agentopts.js";
import * as gh from "./github.js";
import { LABELS } from "./github.js";
import {
  commitAll,
  createWorktree,
  createWorktreeOnBranch,
  diffStat,
  hasChanges,
  mergeBaseInto,
  push,
  run,
} from "./git.js";
import { branchNameFor, revisionRoundsFromPrBody, sessionIdFromPrBody } from "./naming.js";
import { log } from "./log.js";
import { usageReminderSubscribers } from "./state.js";
import type { AgentOptions } from "./agentopts.js";
import type { FeatureRequest } from "./github.js";

/**
 * The build pipeline: request in, reviewable pull request out.
 *
 *   worktree -> agent writes code -> install -> typecheck -> test -> PR
 *
 * The validation gate is the point. An agent's own claim that it finished is
 * not evidence; `tsc` and the test suite are. Anything that fails here becomes
 * a comment on the issue instead of a PR, so a bad generation costs a build
 * and nothing else.
 */

export type BuildOutcome =
  | {
      kind: "opened";
      prNumber: number;
      prUrl: string;
      summary: string;
      diffStat: string;
      costUsd: number | null;
      sessionId: string | null;
    }
  | { kind: "no-changes"; summary: string }
  | { kind: "failed"; stage: string; detail: string; summary: string };

export type ReviseOutcome =
  | {
      kind: "revised";
      prNumber: number;
      prUrl: string;
      summary: string;
      diffStat: string;
      costUsd: number | null;
      sessionId: string | null;
      /** Which review round this was; the fourth costs far more than the first. */
      round: number;
    }
  | { kind: "no-changes"; summary: string }
  | { kind: "failed"; stage: string; detail: string; summary: string };

export interface BuildProgress {
  (stage: string, detail?: string): void;
}


interface Gate {
  name: string;
  args: string[];
}

// Ordered cheapest-first: no point running the test suite if tsc already failed.
const GATES: Gate[] = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "test", args: ["test", "--if-present"] },
];

function tail(text: string, lines = 40): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Running the agent is by far the biggest thing this bot does to its usage
 * limits, and fetchUsage memoizes the reset times it reads. Reading them once
 * afterwards is what keeps /remindme's schedule current without anything
 * polling for it; nobody is waiting on the answer, so it runs alongside the
 * rest of the build.
 */
function refreshUsageAfterAgentRun(): void {
  if (usageReminderSubscribers().length === 0) return;
  void fetchUsage().catch((err) =>
    log.warn("Could not refresh usage after an agent run", { err: String(err) }),
  );
}

export async function buildFeature(
  request: FeatureRequest,
  onProgress: BuildProgress = () => {},
  agentOptions: AgentOptions = {},
): Promise<BuildOutcome> {
  const baseBranch = await gh.defaultBranch();
  const branch = branchNameFor(request.number, request.title);

  await gh.setStatus(request.number, LABELS.building);
  onProgress("Preparing isolated worktree", branch);

  const worktree = await createWorktree(branch, baseBranch);

  try {
    // The agent needs installed deps to run typecheck and tests meaningfully.
    onProgress("Installing dependencies");
    const install = await run("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: worktree.path,
      timeoutMs: 10 * 60_000,
    });
    if (!install.ok) {
      // A lockfile mismatch on the base branch is a repo problem, not the
      // agent's; fall back rather than failing the request for it.
      log.warn("npm ci failed, falling back to npm install", { code: install.code });
      const fallback = await run("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: worktree.path,
        timeoutMs: 10 * 60_000,
      });
      if (!fallback.ok) {
        return { kind: "failed", stage: "install", detail: tail(fallback.stderr), summary: "" };
      }
    }

    onProgress("Agent is writing code", `issue #${request.number}`);
    const agentRun = await implementFeature({
      request,
      worktreePath: worktree.path,
      agentOptions,
      onProgress: (note) => onProgress("Agent progress", note),
    });

    refreshUsageAfterAgentRun();

    if (!agentRun.ok) {
      // A deliberate /stop is not a failure and should not read as one; the
      // request goes back on the pile rather than getting a scary label.
      const stopped = agentRun.error === "STOPPED";
      await gh.setStatus(request.number, stopped ? LABELS.request : LABELS.failed);
      if (!stopped) {
        await gh.comment(
          request.number,
          `**Build failed** during code generation.\n\n\`\`\`\n${agentRun.error ?? "unknown error"}\n\`\`\``,
        );
      }
      return {
        kind: "failed",
        stage: stopped ? "stopped" : "agent",
        detail: stopped
          ? `Stopped after ${agentRun.turns} turns` +
            (agentRun.costUsd !== null ? ` and $${agentRun.costUsd.toFixed(3)}` : "") +
            `. Nothing was pushed.`
          : (agentRun.error ?? "unknown"),
        summary: agentRun.summary,
      };
    }

    if (!(await hasChanges(worktree.path))) {
      await gh.setStatus(request.number, LABELS.failed);
      await gh.comment(
        request.number,
        `**No changes produced.** The agent ran to completion but left the working tree clean.\n\n${agentRun.summary}`,
      );
      return { kind: "no-changes", summary: agentRun.summary };
    }

    // Re-install: the agent may have added a dependency to package.json.
    onProgress("Reinstalling after agent changes");
    await run("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: worktree.path,
      timeoutMs: 10 * 60_000,
    });

    for (const gate of GATES) {
      onProgress(`Running ${gate.name}`);
      const result = await run("npm", gate.args, { cwd: worktree.path, timeoutMs: 10 * 60_000 });
      if (!result.ok) {
        const detail = tail(`${result.stdout}\n${result.stderr}`);
        await gh.setStatus(request.number, LABELS.failed);
        await gh.comment(
          request.number,
          `**Build failed** at \`${gate.name}\`. No pull request was opened.\n\n\`\`\`\n${detail}\n\`\`\``,
        );
        log.warn("Validation gate failed", { issue: request.number, gate: gate.name });
        return { kind: "failed", stage: gate.name, detail, summary: agentRun.summary };
      }
    }

    onProgress("Committing and pushing");
    const stat = await diffStat(worktree.path, baseBranch);
    await commitAll(worktree.path, `${request.title}\n\nImplements #${request.number}.`);
    await push(worktree.path, branch);

    const prBody = [
      agentRun.summary || "_The agent produced no summary._",
      "",
      "---",
      "",
      `Closes #${request.number}`,
      "",
      "<details><summary>Diff stat</summary>",
      "",
      "```",
      stat,
      "```",
      "",
      "</details>",
      "",
      `Generated by EousBot with \`${describeAgentOptions(agentRun.model, agentRun.effort)}\`` +
        ` (\`${agentRun.turns}\` turns` +
        (agentRun.costUsd !== null ? `, $${agentRun.costUsd.toFixed(3)}` : "") +
        "). Typecheck and tests passed before this PR was opened." +
        (agentRun.sessionId ? `\n\nAgent session \`${agentRun.sessionId}\`.` : ""),
    ].join("\n");

    const pr = await gh.openPullRequest({
      branch,
      baseBranch,
      title: `${request.title} (#${request.number})`,
      body: prBody,
    });

    await gh.setStatus(request.number, LABELS.needsReview);
    await gh.comment(request.number, `Pull request opened: ${pr.url}`);

    log.info("PR opened", { issue: request.number, pr: pr.number });

    return {
      kind: "opened",
      prNumber: pr.number,
      prUrl: pr.url,
      summary: agentRun.summary,
      diffStat: stat,
      costUsd: agentRun.costUsd,
      sessionId: agentRun.sessionId,
    };
  } catch (err) {
    // Every *handled* failure above clears the building label on its way out.
    // An unhandled throw -- push auth, a network blip -- would otherwise leave
    // the issue reading "building" forever, which /status reports as a live
    // build that no longer exists.
    await gh.setStatus(request.number, LABELS.failed).catch(() => undefined);
    await gh
      .comment(
        request.number,
        `**Build crashed.** No pull request was opened.\n\n\`\`\`\n${String(err).slice(0, 1500)}\n\`\`\``,
      )
      .catch(() => undefined);
    throw err;
  } finally {
    // The branch lives on the remote now; the local worktree is disposable.
    await worktree.cleanup();
  }
}

/**
 * Revises an open pull request from reviewer feedback.
 *
 * Deliberately the same shape as buildFeature, and deliberately subject to the
 * same gates: a revision that no longer typechecks is worse than the version
 * being critiqued, so "the reviewer asked for it" is not a reason to skip the
 * checks. Pushing to the existing branch updates the PR in place, which keeps
 * the whole conversation -- original diff, feedback, revision -- in one place
 * on GitHub rather than scattered across abandoned PRs.
 */
export async function revisePullRequest(
  opts: {
    prNumber: number;
    feedback: string;
    requestedBy: string;
  },
  onProgress: BuildProgress = () => {},
  agentOptions: AgentOptions = {},
): Promise<ReviseOutcome> {
  const pr = await gh.getPullRequest(opts.prNumber);
  if (pr.state !== "open") {
    return {
      kind: "failed",
      stage: "precheck",
      detail: `PR #${opts.prNumber} is ${pr.state}, not open.`,
      summary: "",
    };
  }

  const branch = pr.head.ref;
  const issueNumber = Number(pr.body?.match(/Closes #(\d+)/)?.[1] ?? NaN);
  const request = Number.isInteger(issueNumber)
    ? await gh.getFeatureRequest(issueNumber)
    : null;

  if (!request) {
    return {
      kind: "failed",
      stage: "precheck",
      detail: `Could not find the feature request behind PR #${opts.prNumber}.`,
      summary: "",
    };
  }

  const priorSessionId = sessionIdFromPrBody(pr.body);
  await gh.setStatus(request.number, LABELS.building);

  onProgress("Checking out the PR branch", branch);
  const worktree = await createWorktreeOnBranch(branch);

  try {
    // Sync with base before anything else. A branch that has fallen behind is
    // the common reason a revision is asked for at all, and resolving that is
    // the harness's job: merging is a git write, which the agent is told not
    // to do. Conflicts are handed to it as files to edit, which it may.
    onProgress("Merging the base branch");
    const merge = await mergeBaseInto(worktree.path, pr.base.ref);
    const conflicts = merge.merged ? [] : merge.conflicts;
    if (conflicts.length > 0) {
      onProgress("Base merge conflicted", `${conflicts.length} file(s) for the agent to resolve`);
    }

    onProgress("Installing dependencies");
    const install = await run("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: worktree.path,
      timeoutMs: 10 * 60_000,
    });
    if (!install.ok) {
      await run("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: worktree.path,
        timeoutMs: 10 * 60_000,
      });
    }

    onProgress("Agent is revising", priorSessionId ? "resuming prior session" : "fresh session");
    const agentRun = await reviseFeature({
      request,
      worktreePath: worktree.path,
      feedback: opts.feedback,
      priorSummary: pr.body?.split("\n---")[0] ?? "",
      priorSessionId,
      conflicts,
      agentOptions,
      onProgress: (note) => onProgress("Agent progress", note),
    });

    refreshUsageAfterAgentRun();

    if (!agentRun.ok) {
      await gh.setStatus(request.number, LABELS.needsReview);
      return {
        kind: "failed",
        stage: "agent",
        detail: agentRun.error ?? "unknown",
        summary: agentRun.summary,
      };
    }

    if (conflicts.length === 0 && !(await hasChanges(worktree.path))) {
      // The PR is untouched and still reviewable, so this is not a failure --
      // it just means the feedback produced no edit. Skipped when a merge is
      // in progress: bailing there would abandon the tree mid-merge.
      await gh.setStatus(request.number, LABELS.needsReview);
      return { kind: "no-changes", summary: agentRun.summary };
    }

    onProgress("Reinstalling after agent changes");
    await run("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: worktree.path,
      timeoutMs: 10 * 60_000,
    });

    for (const gate of GATES) {
      onProgress(`Running ${gate.name}`);
      const result = await run("npm", gate.args, { cwd: worktree.path, timeoutMs: 10 * 60_000 });
      if (!result.ok) {
        const detail = tail(`${result.stdout}\n${result.stderr}`);
        // Leave the PR at needs-review: the previously pushed commit still
        // passed, so the branch on GitHub is not what just broke.
        await gh.setStatus(request.number, LABELS.needsReview);
        await gh.comment(
          request.number,
          `**Revision failed** at \`${gate.name}\`. PR #${opts.prNumber} is unchanged.\n\n\`\`\`\n${detail}\n\`\`\``,
        );
        return { kind: "failed", stage: gate.name, detail, summary: agentRun.summary };
      }
    }

    onProgress("Committing and pushing");
    const baseBranch = pr.base.ref;
    const stat = await diffStat(worktree.path, baseBranch);
    await commitAll(worktree.path, `Revise: ${opts.feedback.split("\n")[0]?.slice(0, 60) ?? "review feedback"}`);
    await push(worktree.path, branch);

    // Stamp the round into the PR body. It makes the count recoverable next
    // time, and puts the compounding cost where a reviewer sees it before
    // asking for round five rather than after.
    const round = revisionRoundsFromPrBody(pr.body) + 1;
    const roundNote =
      `\n\n_Revision ${round}` +
      (agentRun.costUsd !== null ? `, $${agentRun.costUsd.toFixed(3)}` : "") +
      `: ${opts.feedback.split("\n")[0]?.slice(0, 120) ?? ""}_`;
    await gh
      .updatePullRequestBody(opts.prNumber, `${pr.body ?? ""}${roundNote}`)
      .catch((err) => log.warn("Could not stamp the revision round", { err: String(err) }));

    await gh.comment(
      request.number,
      [
        `**Revised** on feedback from ${opts.requestedBy}:`,
        "",
        `> ${opts.feedback.replace(/\n/g, "\n> ")}`,
        "",
        agentRun.summary,
      ].join("\n"),
    );
    await gh.setStatus(request.number, LABELS.needsReview);

    log.info("PR revised", { pr: opts.prNumber, issue: request.number });

    return {
      kind: "revised",
      prNumber: opts.prNumber,
      prUrl: pr.html_url,
      summary: agentRun.summary,
      diffStat: stat,
      costUsd: agentRun.costUsd,
      sessionId: agentRun.sessionId ?? priorSessionId,
      round,
    };
  } catch (err) {
    await gh.setStatus(request.number, LABELS.needsReview).catch(() => undefined);
    throw err;
  } finally {
    await worktree.cleanup();
  }
}
