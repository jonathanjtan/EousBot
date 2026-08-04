/**
 * Pure naming helpers. Deliberately free of imports.
 *
 * Everything here turns untrusted Discord input into an identifier some other
 * system has to accept, so it must be testable without booting config (which
 * exits the process when secrets are absent, including in CI).
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
