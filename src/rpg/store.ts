import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { newGame } from "./engine.js";
import { emptyCrates } from "./rules.js";
import { RARITIES, type Character, type GameState } from "./types.js";

/**
 * The world, on disk.
 *
 * Same shape and same reasoning as idlerpg/store.ts: a JSON file held in
 * memory, written atomically, and never silently replaced when it fails to
 * parse. Its own file because the two games are separate worlds that happen to
 * share a process, and a bug in one must not be able to eat the other.
 */

const storePath = join(config.runtime.repoPath, "state", "rpg.json");

let cache: GameState | null = null;
let dirty = false;

/** Fills in whatever a schema change added. A save from an older build is normal. */
function hydrate(raw: Partial<GameState>): GameState {
  const characters: Record<string, Character> = {};
  for (const [id, saved] of Object.entries(raw.characters ?? {})) {
    if (!saved || typeof saved !== "object") continue;
    const crates = emptyCrates();
    for (const rarity of RARITIES) {
      const held = saved.crates?.[rarity];
      if (typeof held === "number") crates[rarity] = held;
    }
    characters[id] = {
      ...saved,
      userId: saved.userId ?? id,
      race: saved.race ?? "human",
      god: saved.god ?? null,
      favor: saved.favor ?? 0,
      guildId: saved.guildId ?? null,
      spouse: saved.spouse ?? null,
      loveScore: saved.loveScore ?? 0,
      crates,
      backpack: Array.isArray(saved.backpack) ? saved.backpack : [],
      expedition: saved.expedition ?? null,
      nextItemId: saved.nextItemId ?? 1,
      stats: {
        won: saved.stats?.won ?? 0,
        lost: saved.stats?.lost ?? 0,
        duelsWon: saved.stats?.duelsWon ?? 0,
        duelsLost: saved.stats?.duelsLost ?? 0,
      },
    };
  }
  return {
    characters,
    guilds: raw.guilds ?? {},
    market: Array.isArray(raw.market) ? raw.market : [],
    nextListingId: raw.nextListingId ?? 1,
    raid: raw.raid ?? null,
    tournament: raw.tournament ?? null,
    arena: raw.arena ?? null,
    event: raw.event ?? null,
    chess: Array.isArray(raw.chess) ? raw.chess : [],
    nextChessId: raw.nextChessId ?? 1,
    werewolf: raw.werewolf ?? null,
  };
}

export function world(): GameState {
  if (cache) return cache;
  try {
    cache = hydrate(JSON.parse(readFileSync(storePath, "utf8")) as Partial<GameState>);
    log.info("RPG world loaded", { characters: Object.keys(cache.characters).length });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Never fall back to an empty world on a parse error: that is somebody's
      // save being deleted without anyone being told.
      throw new Error(`RPG save is unreadable (${storePath}): ${String(err)}`);
    }
    cache = newGame();
    log.info("RPG world created");
  }
  return cache;
}

export function touch(): void {
  dirty = true;
}

export function flush(force = false): void {
  if (!cache || (!dirty && !force)) return;
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tmp, storePath);
  dirty = false;
}

/**
 * Saves immediately.
 *
 * Unlike the IRC game there is no tick to piggyback a periodic write on, so
 * every mutation flushes. The file is small and the write is a rename; the
 * alternative is losing an adventure to a deploy, which players notice.
 */
export function save(): void {
  touch();
  try {
    flush();
  } catch (err) {
    log.error("Could not save the RPG world", { err: String(err) });
  }
}

export function reset(): void {
  cache = null;
  dirty = false;
}
