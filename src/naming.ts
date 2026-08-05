/**
 * Pure string helpers. Deliberately free of imports.
 *
 * That constraint is the point, not an accident: anything reachable from a
 * test must not pull in config.ts, which exits the process when secrets are
 * absent -- including in CI. Put logic worth testing here, and keep the
 * modules that import config free of logic worth testing.
 */

/**
 * Turns an issue title into something git will accept as a ref, anchored with
 * the issue number so two similarly-titled requests can't collide.
 *
 * The character class is an allowlist rather than an escape: titles arrive
 * straight from Discord, and `..`, spaces, and shell metacharacters all have
 * meaning to git or to the commands that consume the branch name.
 */
export function branchNameFor(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `eous/${issueNumber}-${slug || "request"}`;
}

/**
 * Recovers the agent's session id from a pull request body.
 *
 * The build pipeline writes it there, which makes GitHub the store for it and
 * means revising a PR needs no local bookkeeping: the branch comes from the
 * PR, the issue from its body, and the session from here. A revision can then
 * resume the original conversation rather than re-deriving the reasoning
 * behind the code it is being asked to change.
 */
export function sessionIdFromPrBody(body: string | null | undefined): string | null {
  return body?.match(/Agent session `([0-9a-fA-F-]{8,})`/)?.[1] ?? null;
}
