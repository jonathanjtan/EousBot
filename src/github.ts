import { Octokit } from "@octokit/rest";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * GitHub is the source of truth for feature requests and for the review record.
 *
 * Issues carry the request; PRs carry the generated code; labels carry status.
 * Nothing about a request's lifecycle lives only in Discord, so the audit trail
 * survives the bot losing its state file, its VM, or its mind.
 */

export const LABELS = {
  request: "feature-request",
  building: "status:building",
  needsReview: "status:needs-review",
  failed: "status:build-failed",
  shipped: "status:shipped",
} as const;

/** Every status label, so we can clear before setting a new one. */
const STATUS_LABELS: string[] = [
  LABELS.building,
  LABELS.needsReview,
  LABELS.failed,
  LABELS.shipped,
];

const octokit = new Octokit({ auth: config.github.token });
const repo = { owner: config.github.owner, repo: config.github.repo };

export interface FeatureRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  status: string | null;
  requestedBy: string | null;
  url: string;
  createdAt: string;
}

function statusOf(labels: { name?: string }[]): string | null {
  for (const l of labels) {
    if (l.name && STATUS_LABELS.includes(l.name)) return l.name;
  }
  return null;
}

/** Pulled back out of the issue body so /status can credit the requester. */
function requesterOf(body: string | null | undefined): string | null {
  return body?.match(/^_Requested by <@(\d+)>/m)?.[1] ?? null;
}

export async function createFeatureRequest(opts: {
  title: string;
  description: string;
  discordUserId: string;
  discordUsername: string;
}): Promise<FeatureRequest> {
  const body = [
    `_Requested by <@${opts.discordUserId}> (\`${opts.discordUsername}\`) via Discord._`,
    "",
    opts.description,
  ].join("\n");

  const { data } = await octokit.issues.create({
    ...repo,
    title: opts.title,
    body,
    labels: [LABELS.request],
  });

  log.info("Feature request filed", { issue: data.number, by: opts.discordUsername });

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    state: data.state === "closed" ? "closed" : "open",
    status: null,
    requestedBy: opts.discordUserId,
    url: data.html_url,
    createdAt: data.created_at,
  };
}

export async function listFeatureRequests(
  includeClosed = false,
): Promise<FeatureRequest[]> {
  const { data } = await octokit.issues.listForRepo({
    ...repo,
    labels: LABELS.request,
    state: includeClosed ? "all" : "open",
    sort: "created",
    direction: "desc",
    per_page: 25,
  });

  // listForRepo returns PRs as issues too; a PR is never a feature request.
  return data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state === "closed" ? ("closed" as const) : ("open" as const),
      status: statusOf(
        (i.labels ?? []).map((l) => (typeof l === "string" ? { name: l } : l)),
      ),
      requestedBy: requesterOf(i.body),
      url: i.html_url,
      createdAt: i.created_at,
    }));
}

export async function getFeatureRequest(
  number: number,
): Promise<FeatureRequest | null> {
  try {
    const { data } = await octokit.issues.get({ ...repo, issue_number: number });
    if (data.pull_request) return null;
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state === "closed" ? "closed" : "open",
      status: statusOf(
        (data.labels ?? []).map((l) => (typeof l === "string" ? { name: l } : l)),
      ),
      requestedBy: requesterOf(data.body),
      url: data.html_url,
      createdAt: data.created_at,
    };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** Replaces whichever status label is present, leaving other labels intact. */
export async function setStatus(issueNumber: number, status: string): Promise<void> {
  const { data } = await octokit.issues.get({ ...repo, issue_number: issueNumber });
  const keep = (data.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((n) => n && !STATUS_LABELS.includes(n));

  await octokit.issues.setLabels({
    ...repo,
    issue_number: issueNumber,
    labels: [...keep, status],
  });
}

export async function comment(issueNumber: number, body: string): Promise<void> {
  await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body });
}

export async function openPullRequest(opts: {
  branch: string;
  title: string;
  body: string;
  baseBranch: string;
}): Promise<{ number: number; url: string }> {
  const { data } = await octokit.pulls.create({
    ...repo,
    head: opts.branch,
    base: opts.baseBranch,
    title: opts.title,
    body: opts.body,
  });
  return { number: data.number, url: data.html_url };
}

/** Open PRs, used to work out which one a bare mention is about. */
export async function listOpenPullRequests(): Promise<{ number: number; title: string }[]> {
  const { data } = await octokit.pulls.list({ ...repo, state: "open", per_page: 20 });
  return data.map((p) => ({ number: p.number, title: p.title }));
}

export async function getPullRequest(number: number) {
  const { data } = await octokit.pulls.get({ ...repo, pull_number: number });
  return data;
}

/**
 * Squash-merges the PR. Returns the merge commit the bot should be running
 * after redeploy, so the post-restart announcement can prove it actually
 * landed on the new code rather than just having restarted.
 */
export async function mergePullRequest(
  number: number,
  commitTitle: string,
): Promise<{ sha: string }> {
  const { data } = await octokit.pulls.merge({
    ...repo,
    pull_number: number,
    merge_method: "squash",
    commit_title: commitTitle,
  });
  if (!data.merged) throw new Error(`GitHub declined to merge PR #${number}: ${data.message}`);
  return { sha: data.sha };
}

/** Used to stamp revision rounds into a PR body, which is where they're counted from. */
export async function updatePullRequestBody(number: number, body: string): Promise<void> {
  await octokit.pulls.update({ ...repo, pull_number: number, body });
}

export async function closePullRequest(number: number, reason: string): Promise<void> {
  await octokit.issues.createComment({ ...repo, issue_number: number, body: reason });
  await octokit.pulls.update({ ...repo, pull_number: number, state: "closed" });
}

export async function defaultBranch(): Promise<string> {
  const { data } = await octokit.repos.get({ ...repo });
  return data.default_branch;
}

/**
 * Ensures the labels we rely on exist; GitHub 422s on setting unknown labels.
 *
 * Lists first and creates only what's missing. Blindly creating and swallowing
 * the 422 also works, but Octokit logs every rejected call, so each boot
 * printed five API errors that looked like a problem and weren't.
 */
export async function ensureLabels(): Promise<void> {
  const colors: Record<string, string> = {
    [LABELS.request]: "0e8a16",
    [LABELS.building]: "fbca04",
    [LABELS.needsReview]: "1d76db",
    [LABELS.failed]: "d73a4a",
    [LABELS.shipped]: "5319e7",
  };

  const existing = new Set<string>();
  try {
    const { data } = await octokit.issues.listLabelsForRepo({ ...repo, per_page: 100 });
    for (const l of data) existing.add(l.name);
  } catch (err) {
    log.warn("Could not list labels; will attempt creates", { err: String(err) });
  }

  const missing = Object.entries(colors).filter(([name]) => !existing.has(name));
  if (missing.length === 0) {
    log.debug("All labels present");
    return;
  }

  for (const [name, color] of missing) {
    try {
      await octokit.issues.createLabel({ ...repo, name, color });
      log.info("Created label", { name });
    } catch (err) {
      // Still tolerate 422: a concurrent boot may have created it first.
      if ((err as { status?: number }).status !== 422) throw err;
    }
  }
}
