import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/**
 * Settings every Agent SDK session starts with, whatever else it asks for.
 *
 * hostAuth borrows the box's claude.ai login, and the login brings the
 * account's claude.ai connectors with it: Robinhood, Google Drive, Google
 * Calendar, Credit Karma. They come from the account rather than a settings
 * file, so `settingSources` never reached them. Measured 2026-09-22: every
 * chat and build session was offered eight connectors, including sessions
 * reading web pages and other people's messages, and one past session had
 * called Robinhood.
 *
 * Applied last, so no caller's settings can turn the connectors back on.
 * test/sdksettings.test.ts fails if a `query()` in src/ skips this.
 */
export function sdkSettings(extra: Settings = {}): Settings {
  return { ...extra, disableClaudeAiConnectors: true };
}
