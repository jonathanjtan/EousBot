import { config } from "./config.js";
import { log } from "./log.js";
import { readActiveMode, saveActiveMode } from "./state.js";

/**
 * Active mode: "someone is watching this one".
 *
 * docs/usage.md ends on the observation that steering a run mid-flight is the
 * interactive session's real cost advantage, and that it is available here and
 * simply off by default. The obstacle to leaving it on permanently is that it
 * uploads every session transcript to claude.ai, which is a poor default for
 * unattended work nobody is looking at.
 *
 * So it becomes a toggle rather than a setting: on when you are around, off
 * when you are not. On, builds open the Remote Control bridge and can be
 * steered from the Claude app; off, they behave exactly as before.
 *
 * Persisted, because the bot restarts itself and forgetting on every deploy
 * would make it useless precisely during the sessions it exists for.
 */

let override: boolean | null = null;

function load(): boolean {
  if (override === null) override = readActiveMode();
  return override;
}

export function isActive(): boolean {
  return load();
}

export function setActive(on: boolean): void {
  override = on;
  saveActiveMode(on);
  log.info("Active mode changed", { active: on });
}

/**
 * The effective session visibility, after the toggle.
 *
 * Active mode can only ever raise visibility, never lower it: someone who has
 * deliberately set AGENT_SESSION_VISIBILITY=off wants nothing leaving the box,
 * and a convenience toggle should not quietly override that.
 */
export function effectiveVisibility(): "off" | "view" | "remote" {
  const configured = config.agent.sessionVisibility;
  if (configured === "off") return "off";
  return isActive() ? "remote" : configured;
}
