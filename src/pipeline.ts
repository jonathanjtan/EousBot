import { implementFeature } from "./agent.js";
import { describeAgentOptions } from "./agentopts.js";
import * as gh from "./github.js";
import { LABELS } from "./github.js";
import { commitAll, createWorktree, diffStat, hasChanges, push, run } from "./git.js";
import { branchNameFor } from "./naming.js";
import { log } from "./log.js";
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

    if (!agentRun.ok) {
      await gh.setStatus(request.number, LABELS.failed);
      await gh.comment(
        request.number,
        `**Build failed** during code generation.\n\n\`\`\`\n${agentRun.error ?? "unknown error"}\n\`\`\``,
      );
      return { kind: "failed", stage: "agent", detail: agentRun.error ?? "unknown", summary: agentRun.summary };
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
