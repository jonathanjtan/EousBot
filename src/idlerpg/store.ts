import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { newWorld } from "./engine.js";
import { emptyItems } from "./rules.js";
import { ITEM_SLOTS, WORLD_EVENTS, type GameState, type Player } from "./types.js";

/**
 * The realm, on disk.
 *
 * Its own file rather than a corner of state.ts, and held in memory rather than
 * re-read per access, because the two stores have opposite shapes: state.ts
 * holds a few dozen bytes touched a few times an hour and can afford a
 * read-modify-write per call, while this is every player's full record mutated
 * several times a second by the tick.
 *
 * Still JSON, still no SQLite, for state.ts's reason -- a native module would
 * have to compile on the VM during cloud-init -- and for one of its own: the
 * original kept its database as a flat text file that an operator could open
 * and repair, and that property is worth keeping in a game that will accrue
 * years of somebody's idling.
 */

const storePath = join(config.runtime.repoPath, "state", "idlerpg.json");

let cache: GameState | null = null;
let dirty = false;

/**
 * Fills in anything a schema change added.
 *
 * A save from an older build is the normal case for a bot that redeploys
 * itself mid-game, and losing a realm to a missing field would be the single
 * worst bug this feature could have.
 */
function hydrate(raw: Partial<GameState>, now: number): GameState {
  const fresh = newWorld(now);
  const players: Record<string, Player> = {};

  for (const [id, saved] of Object.entries(raw.players ?? {})) {
    if (!saved || typeof saved !== "object") continue;
    const items = emptyItems();
    for (const slot of ITEM_SLOTS) {
      const item = saved.items?.[slot];
      if (item && typeof item.level === "number") {
        items[slot] = { level: item.level, unique: item.unique ?? null };
      }
    }
    const penalties = { message: 0, logout: 0, quest: 0, part: 0, nick: 0 };
    for (const kind of ["message", "logout", "quest", "part", "nick"] as const) {
      const seconds = saved.penalties?.[kind];
      if (typeof seconds === "number") penalties[kind] = seconds;
    }
    players[id] = {
      ...saved,
      userId: saved.userId ?? id,
      suspended: saved.suspended ?? false,
      items,
      penalties,
    };
  }

  // A realm saved before the tally existed starts counting from zero rather
  // than claiming its events never fired -- see eventReport, which says so.
  const events = fresh.events;
  for (const kind of WORLD_EVENTS) {
    const saved = raw.events?.[kind];
    if (!saved) continue;
    events[kind] = {
      count: typeof saved.count === "number" ? saved.count : 0,
      lastAt: typeof saved.lastAt === "number" ? saved.lastAt : 0,
    };
  }

  return {
    players,
    quest: raw.quest ?? fresh.quest,
    elapsed: raw.elapsed ?? 0,
    lastTick: raw.lastTick ?? fresh.lastTick,
    paused: raw.paused ?? false,
    events,
    // Carried, or the bot's own redeploys would restart the two-day window
    // every time and the boosted rate would never end.
    hogBoostUntil: typeof raw.hogBoostUntil === "number" ? raw.hogBoostUntil : undefined,
  };
}

export function world(now = Date.now()): GameState {
  if (cache) return cache;
  try {
    cache = hydrate(JSON.parse(readFileSync(storePath, "utf8")) as Partial<GameState>, now);
    log.info("Idle RPG realm loaded", {
      players: Object.keys(cache.players).length,
      online: Object.values(cache.players).filter((p) => p.online).length,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Deliberately not falling back to a fresh world on a parse error: a
      // corrupt file that gets silently replaced is a realm deleted without
      // anyone being told. Refusing to start the game leaves the file intact
      // for somebody to look at.
      throw new Error(`Idle RPG save is unreadable (${storePath}): ${String(err)}`);
    }
    cache = newWorld(now);
    log.info("Idle RPG realm created");
  }
  return cache;
}

/** Marks the in-memory realm as needing a flush. Cheap; call it freely. */
export function touch(): void {
  dirty = true;
}

/** Writes if anything changed. Called on the tick's own schedule, and at exit. */
export function flush(force = false): void {
  if (!cache || (!dirty && !force)) return;
  mkdirSync(dirname(storePath), { recursive: true });
  // Write-then-rename, as state.ts does: a restart racing a half-written file
  // would lose the realm rather than one announcement.
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tmp, storePath);
  dirty = false;
}

/** Drops the in-memory copy. Only for tests and for an admin-forced reload. */
export function reset(): void {
  cache = null;
  dirty = false;
}
