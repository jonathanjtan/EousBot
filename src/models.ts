import { offerModel } from "./agentopts.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Which model a build runs on when /claude doesn't pick one.
 *
 * AGENT_MODEL names a model that existed when someone last edited the
 * environment, which is how the bot ended up months behind a release. So at
 * boot it asks Anthropic what Opus models exist and adopts the newest one --
 * unless AGENT_MODEL was set by hand, in which case that is the answer and
 * nothing here overrides it.
 *
 * Everything about this is best-effort. The lookup needs an API key, which
 * `hostAuth` deployments don't have; the endpoint can be down; the newest Opus
 * can be one this code has never heard of. Every one of those paths falls back
 * to the configured model, which is a model that works.
 */

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const API_VERSION = "2023-06-01";
/** Long enough for a cold TLS handshake, short enough not to delay login. */
const TIMEOUT_MS = 10_000;

interface ModelEntry {
  id: string;
  display_name?: string;
  created_at?: string;
}

let resolved: string | null = null;

/** The model builds use. Equals config.agent.model until a lookup beats it. */
export function agentModel(): string {
  return resolved ?? config.agent.model;
}

/**
 * Looks up the newest Opus and adopts it as the build default.
 *
 * Called once from ClientReady, before slash commands are synced, so a model
 * discovered here also reaches the /claude choice list. Never throws.
 */
export async function refreshAgentModel(): Promise<void> {
  if (config.agent.modelPinned) {
    log.info("AGENT_MODEL is pinned; skipping model lookup", { model: config.agent.model });
    return;
  }
  if (!config.agent.apiKey) {
    // hostAuth mode: the Agent SDK can borrow the CLI's login, but this
    // endpoint takes an API key and there is none to borrow.
    log.debug("No API key, so no model lookup", { model: config.agent.model });
    return;
  }

  const newest = await latestOpus(config.agent.apiKey);
  if (!newest) return;

  offerModel(newest.display_name ?? newest.id, newest.id);
  if (newest.id === config.agent.model) return;

  resolved = newest.id;
  log.info("Adopted a newer Opus as the build default", {
    was: config.agent.model,
    now: newest.id,
  });
}

async function latestOpus(apiKey: string): Promise<ModelEntry | null> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { "x-api-key": apiKey, "anthropic-version": API_VERSION },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("Model lookup failed", { status: res.status });
      return null;
    }

    const body = (await res.json()) as { data?: ModelEntry[] };
    const opus = (body.data ?? []).filter((m) => typeof m.id === "string" && isOpus(m.id));
    if (opus.length === 0) return null;

    // created_at rather than the id: version numbers in a model id are not a
    // sortable scheme, and there is no promise about the order of the list.
    return opus.sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
  } catch (err) {
    log.warn("Model lookup threw", { err: String(err) });
    return null;
  }
}

/**
 * Opus-tier only, and only the plain aliases.
 *
 * Suffixed ids -- `-fast`, dated snapshots -- are deployment identifiers with
 * their own pricing and availability, not the model the bot means when it says
 * Opus, so a lookup must not silently promote the build default onto one.
 */
function isOpus(id: string): boolean {
  return /^claude-opus-[0-9]+(-[0-9]+)?$/.test(id);
}

function stamp(m: ModelEntry): number {
  const t = Date.parse(m.created_at ?? "");
  return Number.isNaN(t) ? 0 : t;
}
