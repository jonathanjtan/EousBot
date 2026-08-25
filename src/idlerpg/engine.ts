import {
  BOSS_LOSS_PERCENT,
  BOSS_WIN_PERCENT,
  COLLISION_CRITICAL_ODDS,
  DEFAULT_TUNING,
  EVENT_DAYS,
  HIGH_LEVEL_CHALLENGE_INTERVAL,
  HIGH_LEVEL_QUORUM,
  HIGH_LEVEL_THRESHOLD,
  HOG_MERCY_ODDS,
  NICK_PENALTY_DIVISOR,
  PENALTY_BASE,
  QUEST_COOLDOWN,
  QUEST_DESERTION_COOLDOWN,
  QUEST_DESERTION_TOLL,
  QUEST_MIN_LEVEL,
  QUEST_MIN_TENURE,
  QUEST_PARTY_SIZE,
  QUEST_REWARD,
  QUEST_STEP_ODDS,
  QUEST_TIME_MIN,
  QUEST_TIME_SPREAD,
  STEAL_FROM_LEVEL,
  STEAL_ODDS,
  TEAM_SIZE,
  TEAM_STAKE,
  TIMID_BELOW_LEVEL,
  TOP_LIST_INTERVAL,
  anySlot,
  blessedItemLevel,
  bossGain,
  bossSum,
  criticalDamage,
  criticalFactor,
  damagedItemLevel,
  duration,
  emptyItems,
  eventFires,
  fortunePercent,
  fragileSlot,
  itemSum,
  losses,
  oneIn,
  penalty,
  pick,
  randInt,
  rollBattle,
  rollItemLevel,
  rollUnique,
  shuffle,
  timeToLevel,
  winnings,
  type Rng,
} from "./rules.js";
import {
  CALAMITIES,
  GODSENDS,
  HOG_MERCY,
  HOG_WRATH,
  ITEM_CALAMITY,
  ITEM_GODSEND,
  MAP_QUESTS,
  TIMED_QUESTS,
} from "./flavor.js";
import {
  SLOT_NAMES,
  type Alignment,
  type Announcement,
  type GameState,
  type ItemSlot,
  type Player,
  type Tuning,
} from "./types.js";

/**
 * The game itself: one function that advances the world by some seconds, and a
 * handful that respond to what a player did.
 *
 * Everything here mutates the state it is handed and returns the lines it
 * wants said. Nothing here knows what Discord is -- no client, no channel, no
 * config -- which is what lets the suite run a thousand ticks and assert on
 * the transcript. Delivery is idlerpg/watch.ts's problem.
 *
 * The port is faithful to irpg.pl 3.1.2 in every formula. Where it departs it
 * is because IRC gave the original an input Discord will not: see `tick` on
 * catch-up and `penalizeMessage` on why talking costs a flat rate.
 */

export interface EngineContext {
  rng: Rng;
  /** Epoch ms. */
  now: number;
  tuning: Tuning;
  /**
   * The bot's own name, for when it stands in as an opponent. In the original
   * the bot fights under its IRC nick and cannot be robbed or crit; the same
   * holds here.
   */
  bossName: string;
}

export function newWorld(now: number): GameState {
  return {
    players: {},
    // Six hours before the realm's first quest, same as after any other.
    quest: { kind: "idle", nextAt: Math.floor(now / 1000) + QUEST_COOLDOWN },
    elapsed: 0,
    lastTick: Math.floor(now / 1000),
    paused: false,
  };
}

export function createPlayer(
  userId: string,
  name: string,
  charClass: string,
  ctx: EngineContext,
): Player {
  return {
    userId,
    name,
    charClass,
    level: 0,
    next: timeToLevel(0, ctx.tuning),
    online: true,
    suspended: false,
    alignment: "neutral",
    items: emptyItems(),
    x: randInt(ctx.rng, ctx.tuning.mapX),
    y: randInt(ctx.rng, ctx.tuning.mapY),
    idled: 0,
    createdAt: ctx.now,
    lastLogin: ctx.now,
    penalties: { message: 0, logout: 0, quest: 0, part: 0, nick: 0 },
  };
}

// ------------------------------------------------------------------ helpers ---

function say(text: string): Announcement {
  return { to: "channel", text };
}

function tell(userId: string, text: string, throttleKey?: string): Announcement {
  return throttleKey
    ? { to: "private", userId, text, throttleKey }
    : { to: "private", userId, text };
}

function onlinePlayers(state: GameState): Player[] {
  return Object.values(state.players).filter((p) => p.online);
}

function clockLine(p: Player): string {
  return `**${p.name}** reaches level ${p.level + 1} in ${duration(p.next)}.`;
}

/** Every clock movement goes through here, so none of them can go negative. */
function moveClock(p: Player, delta: number): void {
  p.next = Math.max(0, p.next + delta);
}

function byName(state: GameState, name: string): Player | null {
  const wanted = name.toLowerCase();
  return Object.values(state.players).find((p) => p.name.toLowerCase() === wanted) ?? null;
}

export { byName as findByName };

// ------------------------------------------------------------- player verbs ---

export type JoinResult =
  | { ok: true; player: Player }
  | { ok: false; reason: string };

export function register(
  state: GameState,
  userId: string,
  name: string,
  charClass: string,
  ctx: EngineContext,
): JoinResult {
  if (state.players[userId]) {
    return { ok: false, reason: "You already have a character. `/old-idlerpg whoami` will show it." };
  }
  if (byName(state, name)) {
    return { ok: false, reason: `Somebody is already called ${name}. Pick another name.` };
  }
  const player = createPlayer(userId, name, charClass, ctx);
  state.players[userId] = player;
  return { ok: true, player };
}

export function login(state: GameState, userId: string, ctx: EngineContext): Announcement[] {
  const player = state.players[userId];
  if (!player || (player.online && !player.suspended)) return [];
  player.suspended = false;
  player.online = true;
  // Tenure restarts, so a fresh login waits out the quest eligibility window
  // again. Presence coming back does not do this -- see setPresence.
  player.lastLogin = ctx.now;
  return [
    say(
      `**${player.name}**, the level ${player.level} ${player.charClass}, is idling again. ` +
        `Next level in ${duration(player.next)}.`,
    ),
  ];
}

/**
 * Logging out, and the two penalties it drags with it.
 *
 * The flat cost is the smaller half. If the player was on a quest, leaving
 * ruins it for everyone, and the realm is told exactly whose fault that was --
 * which is the entire social mechanic of the quest system.
 */
export function logout(state: GameState, userId: string, ctx: EngineContext): Announcement[] {
  const player = state.players[userId];
  if (!player || !player.online) return [];

  const out = desertQuest(state, player, ctx);

  const cost = penalty(PENALTY_BASE.logout, player.level, ctx.tuning);
  player.penalties.logout += cost;
  moveClock(player, cost);
  player.online = false;
  // Sticky, so the next presence event cannot undo a logout the player has
  // already been charged for.
  player.suspended = true;

  out.push(
    say(
      `**${player.name}** has stopped idling. ${duration(cost)} added to their clock. ` +
        `Next level in ${duration(player.next)}.`,
    ),
  );
  return out;
}

/**
 * The penalty for talking, which on Discord is most of the game.
 *
 * Billed by the message's length when the bot can see it, exactly as upstream
 * bills an IRC line, and at a flat rate when it cannot. Both paths scale by
 * level, and that scaling is savage. At level 40 a single sentence costs hours,
 * which is what makes speaking a decision.
 *
 * Talking also abandons a quest, which is upstream's rule and not an oversight
 * -- the original runs the same check for a message as for a disconnect. It is
 * the reason a quest makes four people go quiet.
 */
export function penalizeMessage(
  state: GameState,
  userId: string,
  ctx: EngineContext,
  characters?: number,
): Announcement[] {
  const player = state.players[userId];
  if (!player || !player.online) return [];

  const out = desertQuest(state, player, ctx);

  // A character count when the Message Content intent supplies one, which is
  // upstream's rule exactly: an IRC line is billed by its length. Without the
  // intent the bot knows only that a message happened, and falls back to a
  // flat rate. An empty count (an attachment with no text) still costs the
  // flat rate rather than nothing.
  const base = characters && characters > 0 ? characters : PENALTY_BASE.message;
  const cost = penalty(base, player.level, ctx.tuning);
  player.penalties.message += cost;
  moveClock(player, cost);
  // Told privately: a channel line per message would make the penalty louder
  // than the thing it is penalising.
  out.push(
    tell(
      userId,
      `Penalty of ${duration(cost)} added to your clock for speaking. That is what ` +
        `talking costs at level ${player.level}. Next level in ${duration(player.next)}.\n` +
        `_You will not be told again for a while; \`/old-idlerpg whoami\` keeps the running total._`,
      "message-penalty",
    ),
  );
  return out;
}

/**
 * Leaving the server: upstream's `part`, and the dearest penalty in the game.
 *
 * The character is kept rather than deleted. People leave servers and come
 * back, and a game that measures itself in months should not throw away
 * somebody's year because they left for a weekend.
 */
export function penalizePart(
  state: GameState,
  userId: string,
  ctx: EngineContext,
): Announcement[] {
  const player = state.players[userId];
  if (!player || !player.online) return [];

  const out = desertQuest(state, player, ctx);
  const cost = penalty(PENALTY_BASE.part, player.level, ctx.tuning);
  player.penalties.part += cost;
  moveClock(player, cost);
  player.online = false;

  out.push(
    say(
      `**${player.name}** has left the realm entirely. ${duration(cost)} added to ` +
        `their clock, should they ever come back.`,
    ),
  );
  return out;
}

/**
 * Changing your server nickname.
 *
 * Cheap by comparison, capped harder than anything else, and pointedly *not* a
 * quest desertion -- upstream exempts nick changes from that check, on the
 * reasoning that renaming yourself is not the same as walking away.
 */
export function penalizeNick(
  state: GameState,
  userId: string,
  ctx: EngineContext,
): Announcement[] {
  const player = state.players[userId];
  if (!player || !player.online) return [];

  const ceiling =
    ctx.tuning.penLimit > 0
      ? Math.floor(ctx.tuning.penLimit / NICK_PENALTY_DIVISOR)
      : 0;
  const cost = penalty(PENALTY_BASE.nick, player.level, {
    ...ctx.tuning,
    penLimit: ceiling,
  });
  player.penalties.nick += cost;
  moveClock(player, cost);

  return [
    tell(
      player.userId,
      `Penalty of ${duration(cost)} added to your clock for changing your name. ` +
        `Next level in ${duration(player.next)}.`,
      "nick-penalty",
    ),
  ];
}

/**
 * Follows a player's Discord presence, when presence is what drives idling.
 *
 * Free of penalties, tenure resets and quest desertions, all of which `login`
 * and `logout` still do. On IRC your client stayed connected
 * while you slept, so quitting the channel was a choice worth charging for. On
 * Discord going offline is what a phone does every night, and a game that
 * billed people for sleeping would be unplayable within a week.
 *
 * So presence only decides whether the clock is running. Stopping the clock is
 * the entire cost of being away, which is punishment enough in a game whose
 * only currency is elapsed time.
 */
export function setPresence(
  state: GameState,
  userId: string,
  present: boolean,
): Announcement[] {
  const player = state.players[userId];
  if (!player) return [];
  // A deliberate logout outranks presence until the player takes it back.
  if (player.suspended) return [];
  if (player.online === present) return [];

  player.online = present;
  return [];
}

export function setAlignment(
  state: GameState,
  userId: string,
  alignment: Alignment,
): Announcement[] {
  const player = state.players[userId];
  if (!player) return [];
  if (player.alignment === alignment) return [];
  player.alignment = alignment;
  return [say(`**${player.name}** is now ${alignment}.`)];
}

// ------------------------------------------------------------------- combat ---

/**
 * A battle between a player and an opponent, which may be the bot.
 *
 * The loser's clock is the only thing at stake for the challenger; the winner
 * can additionally land a critical strike (damaging the loser's clock) or take
 * one of their items. Neither happens against the bot -- it has no clock and
 * nothing to steal.
 */
function fight(
  state: GameState,
  me: Player,
  opponent: Player | null,
  ctx: EngineContext,
  options: { verb: string; criticalOdds: number },
): Announcement[] {
  const out: Announcement[] = [];
  const mySum = itemSum(me, true);
  const oppSum = opponent
    ? itemSum(opponent, true)
    : bossSum(Object.values(state.players));
  const oppName = opponent ? opponent.name : ctx.bossName;

  const { myRoll, oppRoll, won } = rollBattle(mySum, oppSum, ctx.rng);
  const score = `[${myRoll}/${mySum}] vs [${oppRoll}/${oppSum}]`;

  if (!won) {
    const cost = opponent
      ? losses(opponent.level, me.next)
      : bossGain(BOSS_LOSS_PERCENT, me.next);
    moveClock(me, cost);
    out.push(
      say(
        `**${me.name}** ${options.verb} **${oppName}** ${score} and lost. ` +
          `${duration(cost)} added to their clock.`,
      ),
      say(clockLine(me)),
    );
    return out;
  }

  const gain = opponent
    ? winnings(opponent.level, me.next)
    : bossGain(BOSS_WIN_PERCENT, me.next);
  moveClock(me, -gain);
  out.push(
    say(
      `**${me.name}** ${options.verb} **${oppName}** ${score} and won. ` +
        `${duration(gain)} removed from their clock.`,
    ),
    say(clockLine(me)),
  );

  if (!opponent) return out;

  if (oneIn(ctx.rng, options.criticalOdds)) {
    const damage = criticalDamage(opponent.next, ctx.rng);
    moveClock(opponent, damage);
    out.push(
      say(
        `**${me.name}** dealt **${opponent.name}** a critical strike. ` +
          `${duration(damage)} added to their clock.`,
      ),
      say(clockLine(opponent)),
    );
    return out;
  }

  // Stealing is checked only when the critical missed, exactly as the original
  // does: a won battle yields at most one bonus, never both.
  if (oneIn(ctx.rng, STEAL_ODDS) && me.level > STEAL_FROM_LEVEL - 1) {
    const slot = anySlot(ctx.rng);
    const swapped = swapIfBetter(me, opponent, slot);
    if (swapped) out.push(say(swapped));
  }

  return out;
}

/**
 * Trades `slot` between the two players, but only in the taker's favour.
 *
 * The loser is not left empty-handed -- they get the winner's old item -- which
 * is why item churn in a long-running realm tends upward for everyone rather
 * than concentrating in one player.
 */
function swapIfBetter(taker: Player, victim: Player, slot: ItemSlot): string | null {
  const theirs = victim.items[slot];
  const mine = taker.items[slot];
  if (!theirs || !mine || theirs.level <= mine.level) return null;

  taker.items[slot] = theirs;
  victim.items[slot] = mine;
  return (
    `In the scuffle **${victim.name}** dropped their level ${theirs.level} ` +
    `${SLOT_NAMES[slot]}. **${taker.name}** took it, leaving their level ` +
    `${mine.level} one behind.`
  );
}

/**
 * Picks a fight for `me` against a random online player, or occasionally the
 * bot.
 *
 * Below level 25 the fight only happens one time in four. The original's reason
 * still applies: early levels are short, so a new character would otherwise
 * spend its first day being repeatedly beaten by people it cannot beat.
 */
export function challenge(
  state: GameState,
  me: Player,
  ctx: EngineContext,
): Announcement[] {
  if (me.level < TIMID_BELOW_LEVEL && !oneIn(ctx.rng, 4)) return [];

  const opponents = onlinePlayers(state).filter((p) => p.userId !== me.userId);
  if (opponents.length === 0) return [];

  // One chance in (opponents + 1) that the challenge is against the bot, so a
  // realm of two sees the house often and a realm of forty almost never.
  const boss = oneIn(ctx.rng, opponents.length + 1);
  const opponent = boss ? null : pick(ctx.rng, opponents);
  if (!boss && !opponent) return [];

  return fight(state, me, opponent, ctx, {
    verb: "challenged",
    criticalOdds: criticalFactor(me.alignment),
  });
}

/** Two players who wandered onto the same square. Same rules, flat crit odds. */
function collide(
  state: GameState,
  me: Player,
  opponent: Player,
  ctx: EngineContext,
): Announcement[] {
  return fight(state, me, opponent, ctx, {
    verb: "came upon",
    criticalOdds: COLLISION_CRITICAL_ODDS,
  });
}

/**
 * Six online players, split three and three, one roll per side.
 *
 * The stake is 20% of the *largest* clock on the challenging side, applied to
 * all three of them -- so a team battle is worth much more to the team's junior
 * members than its senior one, and losing one hurts the seniors least.
 */
function teamBattle(state: GameState, ctx: EngineContext): Announcement[] {
  const pool = onlinePlayers(state);
  if (pool.length < TEAM_SIZE * 2) return [];

  const chosen = shuffle(ctx.rng, [...pool]).slice(0, TEAM_SIZE * 2);
  const ours = chosen.slice(0, TEAM_SIZE);
  const theirs = chosen.slice(TEAM_SIZE);

  const sum = (team: Player[]) => team.reduce((n, p) => n + itemSum(p, true), 0);
  const ourSum = sum(ours);
  const theirSum = sum(theirs);
  const stake = Math.floor(Math.max(...ours.map((p) => p.next)) * TEAM_STAKE);

  const { myRoll, oppRoll, won } = rollBattle(ourSum, theirSum, ctx.rng);
  const names = (team: Player[]) => team.map((p) => `**${p.name}**`).join(", ");
  const score = `[${myRoll}/${ourSum}] vs [${oppRoll}/${theirSum}]`;

  for (const p of ours) moveClock(p, won ? -stake : stake);

  return [
    say(
      `${names(ours)} ${score} team battled ${names(theirs)} and ${won ? "won" : "lost"}. ` +
        `${duration(stake)} ${won ? "removed from" : "added to"} each of their clocks.`,
    ),
  ];
}

// ------------------------------------------------------------------- events ---

/**
 * The hand of God: a large, arbitrary shove, merciful four times in five.
 *
 * Exported because an admin can summon it; the realm is not told which of the
 * two it was going to be beforehand, and neither is the admin.
 */
export function handOfGod(
  state: GameState,
  ctx: EngineContext,
  target?: Player,
): Announcement[] {
  const player = target ?? pick(ctx.rng, onlinePlayers(state));
  if (!player) return [];

  const merciful = randInt(ctx.rng, HOG_MERCY_ODDS) !== 0;
  const amount = Math.floor(((5 + randInt(ctx.rng, 71)) / 100) * player.next);
  const line = pick(ctx.rng, merciful ? HOG_MERCY : HOG_WRATH) ?? "the sky moved";

  moveClock(player, merciful ? -amount : amount);
  return [
    say(
      `For **${player.name}**, ${line}. ${duration(amount)} ` +
        `${merciful ? "removed from" : "added to"} their clock.`,
    ),
    say(clockLine(player)),
  ];
}

/** A misfortune: one time in ten it damages an item, otherwise it costs time. */
function calamity(state: GameState, ctx: EngineContext): Announcement[] {
  const player = pick(ctx.rng, onlinePlayers(state));
  if (!player) return [];

  if (oneIn(ctx.rng, 10)) {
    const slot = fragileSlot(ctx.rng);
    const item = player.items[slot];
    if (!item) return [];
    item.level = damagedItemLevel(item.level);
    return [
      say(
        `**${player.name}** ${ITEM_CALAMITY[slot]}. Their ${SLOT_NAMES[slot]} ` +
          `loses 10% of its effectiveness.`,
      ),
    ];
  }

  const cost = Math.floor((fortunePercent(ctx.rng) / 100) * player.next);
  moveClock(player, cost);
  const line = pick(ctx.rng, CALAMITIES) ?? "had a bad day";
  return [
    say(`**${player.name}** ${line}. This calamity cost them ${duration(cost)}.`),
    say(clockLine(player)),
  ];
}

/** The mirror of a calamity, and twice as frequent. */
function godsend(state: GameState, ctx: EngineContext): Announcement[] {
  const player = pick(ctx.rng, onlinePlayers(state));
  if (!player) return [];

  if (oneIn(ctx.rng, 10)) {
    const slot = fragileSlot(ctx.rng);
    const item = player.items[slot];
    if (!item) return [];
    item.level = blessedItemLevel(item.level);
    return [
      say(
        `**${player.name}** ${ITEM_GODSEND[slot]}. Their ${SLOT_NAMES[slot]} ` +
          `gains 10% effectiveness.`,
      ),
    ];
  }

  const gain = Math.floor((fortunePercent(ctx.rng) / 100) * player.next);
  moveClock(player, -gain);
  const line = pick(ctx.rng, GODSENDS) ?? "had a good day";
  return [
    say(`**${player.name}** ${line}. This godsend gained them ${duration(gain)}.`),
    say(clockLine(player)),
  ];
}

/** Two of the good are rewarded together. Being good is a group activity. */
function goodness(state: GameState, ctx: EngineContext): Announcement[] {
  const good = onlinePlayers(state).filter((p) => p.alignment === "good");
  if (good.length < 2) return [];

  const pair = shuffle(ctx.rng, [...good]).slice(0, 2);
  const percent = 5 + randInt(ctx.rng, 8);
  const out: Announcement[] = [
    say(
      `${pair.map((p) => `**${p.name}**`).join(" and ")} kept faith with their god, ` +
        `and ${percent}% of their time is taken off their clocks.`,
    ),
  ];
  for (const p of pair) {
    p.next = Math.floor(p.next * (1 - percent / 100));
    out.push(say(clockLine(p)));
  }
  return out;
}

/**
 * The evil counterpart, and pointedly not its equal.
 *
 * Half the time an evil player steals from a good one -- and only from a good
 * one. The other half their own god turns on them. That asymmetry is the price
 * of evil's better critical odds; the 10% combat penalty is the rest of it.
 */
function evilness(state: GameState, ctx: EngineContext): Announcement[] {
  const online = onlinePlayers(state);
  const evil = online.filter((p) => p.alignment === "evil");
  const me = pick(ctx.rng, evil);
  if (!me) return [];

  if (oneIn(ctx.rng, 2)) {
    const good = online.filter((p) => p.alignment === "good");
    const target = pick(ctx.rng, good);
    if (!target) return [];
    const slot = anySlot(ctx.rng);
    const theirs = target.items[slot];
    const mine = me.items[slot];
    if (!theirs || !mine || theirs.level <= mine.level) {
      return [
        tell(
          me.userId,
          `You crept up on ${target.name}'s ${SLOT_NAMES[slot]} and found it worse ` +
            `than your own. You went back to bed.`,
        ),
      ];
    }
    me.items[slot] = theirs;
    target.items[slot] = mine;
    return [
      say(
        `**${me.name}** stole **${target.name}**'s level ${theirs.level} ` +
          `${SLOT_NAMES[slot]} while they slept, leaving a level ${mine.level} one ` +
          `in its place.`,
      ),
    ];
  }

  const percent = 1 + randInt(ctx.rng, 5);
  const cost = Math.floor(me.next * (percent / 100));
  moveClock(me, cost);
  return [
    say(`**${me.name}** was forsaken by their evil god. ${duration(cost)} added to their clock.`),
    say(clockLine(me)),
  ];
}

// ------------------------------------------------------------------- quests ---

/**
 * Ends the current quest if `player` is on it, charging everyone for it.
 *
 * The deserter pays a level-scaled penalty and every other player in the realm
 * pays a flat fifteen minutes. Making the innocent pay is the point. It turns a
 * quest into four people willing each other to stay put.
 */
function desertQuest(state: GameState, player: Player, ctx: EngineContext): Announcement[] {
  const quest = state.quest;
  if (quest.kind === "idle" || !quest.questers.includes(player.userId)) return [];

  const out: Announcement[] = [
    say(
      `**${player.name}** abandoned the quest, and the gods have taken it out on ` +
        `everybody. The realm is fifteen minutes further from where it was going.`,
    ),
  ];

  for (const other of onlinePlayers(state)) {
    const toll =
      other.userId === player.userId
        ? penalty(PENALTY_BASE.quest, other.level, ctx.tuning)
        : QUEST_DESERTION_TOLL;
    other.penalties.quest += toll;
    moveClock(other, toll);
  }

  state.quest = {
    kind: "idle",
    nextAt: Math.floor(ctx.now / 1000) + QUEST_DESERTION_COOLDOWN,
  };
  return out;
}

/** Players eligible to be sent on a quest: high level, and not freshly logged in. */
function questCandidates(state: GameState, ctx: EngineContext): Player[] {
  return onlinePlayers(state).filter(
    (p) =>
      p.level >= QUEST_MIN_LEVEL && ctx.now - p.lastLogin > QUEST_MIN_TENURE * 1000,
  );
}

function beginQuest(state: GameState, ctx: EngineContext): Announcement[] {
  const eligible = questCandidates(state, ctx);
  if (eligible.length < QUEST_PARTY_SIZE) return [];

  const party = shuffle(ctx.rng, [...eligible]).slice(0, QUEST_PARTY_SIZE);
  const names = party.map((p) => `**${p.name}**`);
  const roster = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  if (oneIn(ctx.rng, 2)) {
    const text = pick(ctx.rng, TIMED_QUESTS) ?? "wait";
    const endsAt =
      Math.floor(ctx.now / 1000) + QUEST_TIME_MIN + randInt(ctx.rng, QUEST_TIME_SPREAD);
    state.quest = {
      kind: "time",
      questers: party.map((p) => p.userId),
      text,
      endsAt,
    };
    return [
      say(
        `${roster} have been chosen by the gods to ${text}. ` +
          `The quest ends in ${duration(endsAt - Math.floor(ctx.now / 1000))}.`,
      ),
    ];
  }

  const text = pick(ctx.rng, MAP_QUESTS) ?? "walk";
  const p1 = { x: randInt(ctx.rng, ctx.tuning.mapX), y: randInt(ctx.rng, ctx.tuning.mapY) };
  const p2 = { x: randInt(ctx.rng, ctx.tuning.mapX), y: randInt(ctx.rng, ctx.tuning.mapY) };
  state.quest = { kind: "map", questers: party.map((p) => p.userId), text, stage: 1, p1, p2 };
  return [
    say(
      `${roster} have been chosen by the gods to ${text}. They must reach ` +
        `[${p1.x}, ${p1.y}], then [${p2.x}, ${p2.y}]. \`/old-idlerpg map\` shows where they are.`,
    ),
  ];
}

function completeQuest(state: GameState, ctx: EngineContext): Announcement[] {
  const quest = state.quest;
  if (quest.kind === "idle") return [];

  const party = quest.questers
    .map((id) => state.players[id])
    .filter((p): p is Player => p !== undefined);

  for (const p of party) p.next = Math.floor(p.next * (1 - QUEST_REWARD));
  state.quest = { kind: "idle", nextAt: Math.floor(ctx.now / 1000) + QUEST_COOLDOWN };

  const names = party.map((p) => `**${p.name}**`).join(", ");
  return [
    say(
      `${names} completed their quest. A quarter of their remaining burden is gone.`,
    ),
    ...party.map((p) => say(clockLine(p))),
  ];
}

// ---------------------------------------------------------------------- map ---

function wrap(value: number, max: number): number {
  if (value > max) return 0;
  if (value < 0) return max;
  return value;
}

/**
 * One second of map movement for everybody, and any fight that results.
 *
 * Idle players stagger one square in each axis at random and fight whoever they
 * land on. Questers on a map quest walk straight toward their waypoint, and
 * cannot be made to fight -- their quest is hard enough.
 *
 * The collision check is odds-scaled by population (`oneIn(online)`), so a
 * crowded map does not turn into a permanent brawl.
 */
function stepMap(state: GameState, ctx: EngineContext): Announcement[] {
  const online = onlinePlayers(state);
  if (online.length === 0) return [];

  const quest = state.quest;
  const out: Announcement[] = [];

  if (quest.kind === "map") {
    const target = quest.stage === 1 ? quest.p1 : quest.p2;
    const party = quest.questers
      .map((id) => state.players[id])
      .filter((p): p is Player => p !== undefined);

    for (const p of party) {
      if (!oneIn(ctx.rng, QUEST_STEP_ODDS)) continue;
      if (p.x !== target.x) p.x += p.x < target.x ? 1 : -1;
      if (p.y !== target.y) p.y += p.y < target.y ? 1 : -1;
    }

    if (party.every((p) => p.x === target.x && p.y === target.y)) {
      if (quest.stage === 1) {
        quest.stage = 2;
        out.push(
          say(
            `The questers have reached [${quest.p1.x}, ${quest.p1.y}]. ` +
              `On to [${quest.p2.x}, ${quest.p2.y}].`,
          ),
        );
      } else {
        out.push(...completeQuest(state, ctx));
        return out;
      }
    }

    // Everyone else still wanders, but with the map quest running nobody
    // fights: the original suspends collisions for the duration.
    const questing = new Set(quest.questers);
    for (const p of online) {
      if (questing.has(p.userId)) continue;
      p.x = wrap(p.x + randInt(ctx.rng, 3) - 1, ctx.tuning.mapX);
      p.y = wrap(p.y + randInt(ctx.rng, 3) - 1, ctx.tuning.mapY);
    }
    return out;
  }

  /** Square key -> who is standing there and whether they have fought already. */
  const occupied = new Map<string, { player: Player; battled: boolean }>();

  for (const p of online) {
    p.x = wrap(p.x + randInt(ctx.rng, 3) - 1, ctx.tuning.mapX);
    p.y = wrap(p.y + randInt(ctx.rng, 3) - 1, ctx.tuning.mapY);

    const key = `${p.x},${p.y}`;
    const sitting = occupied.get(key);
    if (sitting && !sitting.battled && sitting.player.userId !== p.userId) {
      if (oneIn(ctx.rng, online.length)) {
        sitting.battled = true;
        out.push(...collide(state, p, sitting.player, ctx));
      }
      continue;
    }
    occupied.set(key, { player: p, battled: false });
  }

  return out;
}

// --------------------------------------------------------------------- tick ---

/** Fires once per `interval` of game time, whatever the tick length happens to be. */
function crossed(elapsed: number, seconds: number, interval: number): boolean {
  return Math.floor(elapsed / interval) > Math.floor((elapsed - seconds) / interval);
}

/**
 * Level-up: a new clock, an item, and a fight.
 *
 * All three are the original's, and the order matters -- the item is found
 * before the challenge, so a lucky find can win the fight it triggered.
 */
function levelUp(state: GameState, player: Player, ctx: EngineContext): Announcement[] {
  player.level += 1;
  player.next = timeToLevel(player.level, ctx.tuning);

  const out: Announcement[] = [
    say(
      `**${player.name}**, the ${player.charClass}, has attained level ${player.level}. ` +
        `Next level in ${duration(player.next)}.`,
    ),
    ...findItem(player, ctx),
    ...challenge(state, player, ctx),
  ];
  return out;
}

/**
 * Rolls an item for a level-up.
 *
 * Reported privately, as the original does: the realm learns what you are
 * carrying only by fighting you, which is most of what makes fighting
 * interesting.
 */
export function findItem(player: Player, ctx: EngineContext): Announcement[] {
  const ordinary = rollItemLevel(player.level, ctx.rng);
  const unique = rollUnique(player, ordinary, ctx.rng);

  if (unique) {
    player.items[unique.def.slot] = { level: unique.level, unique: unique.def.name };
    return [
      tell(
        player.userId,
        `The light of the gods falls on you. You have found ${unique.def.name}, ` +
          `a level ${unique.level} ${SLOT_NAMES[unique.def.slot]}. ${unique.def.blurb}`,
      ),
    ];
  }

  const slot = anySlot(ctx.rng);
  const held = player.items[slot];
  if (!held) return [];

  if (ordinary > held.level) {
    player.items[slot] = { level: ordinary, unique: null };
    return [
      tell(
        player.userId,
        `You found a level ${ordinary} ${SLOT_NAMES[slot]}. Yours was level ` +
          `${held.level}, so luck is with you.`,
      ),
    ];
  }
  return [
    tell(
      player.userId,
      `You found a level ${ordinary} ${SLOT_NAMES[slot]}. Yours is level ` +
        `${held.level}, so you leave it where it lies.`,
    ),
  ];
}

/** The realm's top three, announced every ten hours. */
export function topPlayers(state: GameState, limit = 3): Player[] {
  return Object.values(state.players)
    .sort((a, b) => b.level - a.level || a.next - b.next)
    .slice(0, limit);
}

/**
 * Advances the world by `seconds`.
 *
 * `seconds` is real elapsed time, not the timer interval, and the caller is
 * expected to cap it -- see idlerpg/watch.ts. Crediting real time means a
 * one-minute deploy restart costs nobody a minute of idling, which matters
 * rather a lot in a bot that redeploys itself; capping it means a day-long
 * outage does not hand every player a free day.
 */
export function tick(state: GameState, seconds: number, ctx: EngineContext): Announcement[] {
  // Advanced before the pause check. If a paused realm left
  // lastTick behind, the delta would keep growing and the whole of it (up to
  // the caller's cap) would be credited the instant somebody unpaused --
  // handing everyone ten free minutes for the privilege of being frozen.
  state.lastTick = Math.floor(ctx.now / 1000);
  if (state.paused || seconds <= 0) return [];

  const out: Announcement[] = [];
  const online = onlinePlayers(state);
  if (online.length === 0) {
    // Time still passes for the schedules, or a realm that empties overnight
    // would come back owing itself a burst of quests and roll calls.
    state.elapsed += seconds;
    return out;
  }

  state.elapsed += seconds;

  const evil = online.filter((p) => p.alignment === "evil").length;
  const good = online.filter((p) => p.alignment === "good").length;

  if (eventFires(ctx.rng, EVENT_DAYS.handOfGod, online.length, seconds)) {
    out.push(...handOfGod(state, ctx));
  }
  if (eventFires(ctx.rng, EVENT_DAYS.teamBattle, online.length, seconds)) {
    out.push(...teamBattle(state, ctx));
  }
  if (eventFires(ctx.rng, EVENT_DAYS.calamity, online.length, seconds)) {
    out.push(...calamity(state, ctx));
  }
  if (eventFires(ctx.rng, EVENT_DAYS.godsend, online.length, seconds)) {
    out.push(...godsend(state, ctx));
  }
  if (eventFires(ctx.rng, EVENT_DAYS.evilness, evil, seconds)) {
    out.push(...evilness(state, ctx));
  }
  if (eventFires(ctx.rng, EVENT_DAYS.goodness, good, seconds)) {
    out.push(...goodness(state, ctx));
  }

  // The map advances one square per second of game time, as it does in the
  // original. Bounded by the caller's catch-up cap.
  for (let i = 0; i < seconds; i += 1) {
    out.push(...stepMap(state, ctx));
  }

  const quest = state.quest;
  const nowSeconds = Math.floor(ctx.now / 1000);
  if (quest.kind === "idle" && nowSeconds >= quest.nextAt) {
    out.push(...beginQuest(state, ctx));
  } else if (quest.kind === "time" && nowSeconds >= quest.endsAt) {
    out.push(...completeQuest(state, ctx));
  }

  if (crossed(state.elapsed, seconds, TOP_LIST_INTERVAL)) {
    const top = topPlayers(state);
    if (top.length > 0) {
      out.push(
        say(
          [
            "**Idle RPG top players**",
            ...top.map(
              (p, i) =>
                `${i + 1}. **${p.name}**, level ${p.level} ${p.charClass}, ` +
                `next level in ${duration(p.next)}`,
            ),
          ].join("\n"),
        ),
      );
    }
  }

  if (crossed(state.elapsed, seconds, HIGH_LEVEL_CHALLENGE_INTERVAL)) {
    const high = online.filter((p) => p.level > HIGH_LEVEL_THRESHOLD);
    if (high.length / online.length > HIGH_LEVEL_QUORUM) {
      const champion = pick(ctx.rng, high);
      if (champion) out.push(...challenge(state, champion, ctx));
    }
  }

  // Clocks move last, so an event this tick is reflected in the level-up it
  // may just have caused.
  for (const player of online) {
    player.next -= seconds;
    player.idled += seconds;
    while (player.next < 1) {
      out.push(...levelUp(state, player, ctx));
    }
  }

  return out;
}
