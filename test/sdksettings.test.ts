import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * claude.ai connectors stay out of every agent session.
 *
 * A hostAuth session inherits the account's connectors unless its settings
 * say otherwise, and `settingSources` does not say otherwise. The bot also
 * writes its own code, so a new session added by a build has to fail here
 * rather than rely on a comment.
 */

const { sdkSettings } = await import("../src/sdksettings.ts");

test("sdkSettings turns the connectors off, and callers cannot turn them back on", () => {
  assert.equal(sdkSettings().disableClaudeAiConnectors, true);
  assert.deepEqual(sdkSettings({ autoUploadSessions: true }), {
    autoUploadSessions: true,
    disableClaudeAiConnectors: true,
  });
  assert.equal(sdkSettings({ disableClaudeAiConnectors: false }).disableClaudeAiConnectors, true);
});

test("every agent session in src/ passes sdkSettings", () => {
  const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".ts"),
  );
  let sessions = 0;
  for (const file of files) {
    const source = readFileSync(join("src", file), "utf8");
    const opened = source.match(/\bquery\(\{/g)?.length ?? 0;
    const guarded = source.match(/\bsettings: sdkSettings\(/g)?.length ?? 0;
    assert.equal(
      guarded,
      opened,
      `src/${file} opens ${opened} session(s) but passes sdkSettings ${guarded} time(s)`,
    );
    sessions += opened;
  }
  assert.ok(sessions > 0, "found no query() calls, so the scan is looking in the wrong place");
});
