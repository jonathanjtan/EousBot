/**
 * The manual.
 *
 * This should have shipped with the first commit and did not. The reasoning at
 * the time was that Discord surfaces a description per command natively, which
 * is true and irrelevant: a one-line tooltip on each of sixty-eight subcommands
 * does not tell anybody that reaching two difficulties above your level is
 * correct, that unwearable items are worth more on an altar than at the shop,
 * or that buying crates is a coin sink rather than a strategy. Those are the
 * things a player needs and none of them fit in a tooltip.
 *
 * Pages are data rather than prose scattered through handlers, so the suite can
 * check two things that matter: every page fits in a Discord message, and every
 * command a page mentions actually exists. That second test is the point --
 * hand-written help rots the moment a command is renamed, and rotted help is
 * worse than none because it is confidently wrong.
 */

export interface HelpPage {
  topic: string;
  /** One line, shown in the topic index. */
  summary: string;
  body: string[];
}

const OVERVIEW: HelpPage = {
  topic: "overview",
  summary: "What the game is, and your first ten minutes",
  body: [
    "**Idle RPG** — you send a character out, walk away, and come back to a result.",
    "",
    "There is nothing to click while you wait. The whole game is the *decision* you",
    "make before you leave: how far to reach, and what to spend the takings on.",
    "",
    "**Your first ten minutes**",
    "```",
    "/idlerpg start class:mage race:orc",
    "/idlerpg adventures",
    "/idlerpg adventure difficulty:3",
    "```",
    "Then leave. Come back and run `/idlerpg claim`.",
    "",
    "The dice are rolled on **claim**, not on dispatch — if the outcome were decided",
    "when you left, the wait would be theatre.",
    "",
    "**The one thing people get wrong:** don't grind difficulty 1. Reach up. Measured",
    "over 72 hours, grinding the safest option reaches level 10; choosing well reaches",
    "12.8. The rightmost column of `/idlerpg adventures` is expected coin per hour —",
    "pick the biggest number.",
    "",
    "`/idlerpg help topic:<name>` for anything below.",
  ],
};

const ADVENTURING: HelpPage = {
  topic: "adventuring",
  summary: "Difficulty, odds, and how far to reach",
  body: [
    "**Adventuring**",
    "```",
    "/idlerpg adventures            the menu, with real odds and payouts",
    "/idlerpg adventure difficulty:N  go",
    "/idlerpg status                how long is left",
    "/idlerpg claim                 collect",
    "```",
    "An adventure takes **difficulty × 30 minutes**. Difficulty 3 is ninety minutes;",
    "difficulty 20 is ten hours, which is a set-it-before-bed run.",
    "",
    "You can attempt anything up to **your level + 2**, so there is always a choice.",
    "",
    "**Odds** come from three things, in descending order of how much they matter:",
    "what you are carrying, how far above your level you reached, and your class.",
    "Gear dominates deliberately — it is the thing that changes as you play, so the",
    "right answer moves with it.",
    "",
    "**Rewards grow faster than time does.** That is what makes reaching up correct,",
    "and it is why the best difficulty is not the safest one. But it is not the",
    "highest one either: the reach penalty means the optimum sits somewhere in the",
    "middle and climbs as your gear improves. At level 1 take 3. At level 20 you will",
    "have unlocked 22 and should be taking about 15.",
    "",
    "A failed adventure costs you the time and nothing else. No coin, no gear.",
  ],
};

const CHARACTER: HelpPage = {
  topic: "character",
  summary: "Classes, races, levels and tiers",
  body: [
    "**Classes** are the load-bearing choice. Each does exactly one thing, and it",
    "grows at levels 5, 12, 20 and 30.",
    "",
    "`warrior` protection · `mage` damage · `ranger` better odds",
    "`ritualist` experience · `raider` coin · `thief` steals coin after a win",
    "",
    "**Races** are deliberately smaller — you pick both with no information about",
    "either, so only one of them is allowed to matter much.",
    "",
    "`human` +8% XP · `elf` +4 odds · `dwarf` +10% coin · `orc` +6 attack",
    "`revenant` +6 protection",
    "",
    "**Worth knowing early:** your starting kit is only 5+5 power, so flat bonuses",
    "are enormous at first — `orc` alone is +6 on a base of 10. A `mage`/`orc` will",
    "feel far stronger for the first few hours than a percentage build. The",
    "percentage classes pass them later.",
    "",
    "```",
    "/idlerpg classes    what each class does",
    "/idlerpg races      what each race does",
    "/idlerpg profile    your sheet",
    "/idlerpg top        the leaderboards",
    "```",
    "There are six leaderboards, not one — level, coin, power, adventures, duels and",
    "favour — so people who play differently are not all losing.",
  ],
};

const GEAR: HelpPage = {
  topic: "gear",
  summary: "Items, crates, the backpack and the market",
  body: [
    "**Gear** is two slots — a weapon and armour — and their sum is your entire",
    "combat statistic. There is no attack rating or hit points; battles are a roll",
    "under that number.",
    "",
    "```",
    "/idlerpg item open rarity:common   open a crate",
    "/idlerpg item backpack             what you are carrying",
    "/idlerpg item equip item:12        wear something",
    "/idlerpg item sell item:12         sell one",
    "/idlerpg item sellall keep_above:40  sell the junk",
    "/idlerpg item give player:@x coin:500  hand something over",
    "```",
    "**Anything better than what you are wearing equips itself.** You never need to",
    "run `equip` for an obvious upgrade.",
    "",
    "Five rarities — common, uncommon, rare, magic, legendary — and rarity is a",
    "*tilt* rather than a gate, so a beginner's crate can still produce a legendary.",
    "",
    "**The market** is player-to-player, and usually a better price than the shop:",
    "```",
    "/idlerpg market list",
    "/idlerpg market sell item:12 price:5000",
    "/idlerpg market buy listing:3",
    "```",
    "Five listings each at most, so the board stays readable.",
  ],
};

const GODS: HelpPage = {
  topic: "gods",
  summary: "Sacrifice, favour, and why not to sell everything",
  body: [
    "**Gods exist so an item you cannot wear has a second use.**",
    "",
    "Without them, every drop in the wrong slot is just coin and the only question is",
    "how fast you walk to the shop. Sacrificing converts it into favour instead, and",
    "favour permanently improves the odds on every adventure you ever run.",
    "",
    "```",
    "/idlerpg god list",
    "/idlerpg god follow god:forge",
    "/idlerpg god sacrifice items:3 7 12",
    "/idlerpg god status",
    "```",
    "An item is worth **more on an altar than at the shop**, so unless you need the",
    "coin right now, sacrificing is usually the better trade.",
    "",
    "Favour is capped, so it improves your odds up to a ceiling rather than forever.",
    "The first oath is free; changing gods later costs half your favour *in coin*,",
    "and the favour itself follows you.",
  ],
};

const GUILDS: HelpPage = {
  topic: "guilds",
  summary: "Guilds, alliances and raid bosses",
  body: [
    "**Guilds** are the part that needs other people.",
    "",
    "```",
    "/idlerpg guild create name:The Wall",
    "/idlerpg guild join name:The Wall",
    "/idlerpg guild info",
    "/idlerpg guild deposit coin:5000",
    "/idlerpg guild upgrade          raises the member cap, from the bank",
    "/idlerpg guild battle name:Rivals stake:5000",
    "```",
    "Founding one costs coin. The **bank** takes deposits from anyone but pays out",
    "only to the leader and officers, which is the whole reason it is interesting.",
    "",
    "**Alliances** are flat — one guild flies under another's banner:",
    "`/idlerpg guild ally name:Banner`",
    "",
    "**Raids** are realm-wide and anyone can join, guild or not:",
    "```",
    "/idlerpg raid call     summon a boss, and seed the pot",
    "/idlerpg raid hit      swing at it",
    "/idlerpg raid status   how it is going",
    "```",
    "The pot **splits by damage dealt**, so turning up early and often pays. There is",
    "no per-player cooldown — the only limit is the boss's health and the six-hour",
    "window before it escapes.",
  ],
};

const CONTESTS: HelpPage = {
  topic: "contests",
  summary: "Duels, the arena, tournaments, chess and werewolf",
  body: [
    "**Duels** — one on one, both stake coin:",
    "`/idlerpg duel player:@someone stake:250`",
    "",
    "**Tournaments** — a bracket, decided by gear:",
    "`/idlerpg tournament open buy_in:1000` then `join`, then `run`",
    "",
    "**The arena** — a free-for-all, and deliberately *not* the tournament. A bracket",
    "rewards the strongest character and everyone knows who that is beforehand; the",
    "arena is a lottery gear only nudges, so the two are worth having separately:",
    "`/idlerpg arena open buy_in:500` then `join`, then `run`",
    "",
    "**Chess** is its own command, and real chess — moves in coordinates:",
    "```",
    "/chess challenge player:@someone stake:1000",
    "/chess move move:e2e4        promote with e7e8q",
    "/chess board",
    "```",
    "**Werewolf** is its own command too. Roles arrive by DM; the host calls the",
    "phases, so nothing ends at 3am for whoever was asleep:",
    "```",
    "/werewolf open · join · start",
    "/werewolf night player:@x   then the host calls dawn",
    "/werewolf vote player:@x    then the host calls dusk",
    "```",
    "**Nothing takes another person's coin without them pressing a button.**",
  ],
};

const MONEY: HelpPage = {
  topic: "money",
  summary: "The shop, wagers, marriage and where coin goes",
  body: [
    "**The shop** sells crates and nothing else:",
    "`/idlerpg store list` · `/idlerpg store buy rarity:rare count:2`",
    "",
    "Crates are priced **above** what falls out of them. The shop is a coin sink and",
    "a way to turn a windfall into a chance at gear — if buying crates were profitable",
    "the only correct move would be to buy them forever.",
    "",
    "**Wagers** are at exactly fair odds, with no house edge:",
    "```",
    "/idlerpg bet flip stake:500 call:heads",
    "/idlerpg bet dice stake:100 guess:3 sides:6   pays 5 to 1",
    "```",
    "**Marriage** is a shared bonus rather than a transfer. Courting burns coin and",
    "raises a percentage that applies to *both* of you:",
    "```",
    "/idlerpg marry propose player:@someone",
    "/idlerpg marry court coin:5000",
    "```",
    "**Quiz games**, for small money:",
    "`/idlerpg trivia` · `/idlerpg maths difficulty:3`",
  ],
};

const ADMIN: HelpPage = {
  topic: "admin",
  summary: "Operator controls (admins only)",
  body: [
    "**Admin controls.** Restricted to the bot's admin allowlist, and everything is",
    "announced in the channel — an admin quietly handing themselves a legendary has",
    "broken the game for everyone else, and the cheapest defence is that it is",
    "visible.",
    "",
    "```",
    "/idlerpg admin grant player:@x coin:5000     negative takes it away",
    "/idlerpg admin setlevel player:@x level:20",
    "/idlerpg admin spawn player:@x value:100 rarity:rare kind:weapon",
    "/idlerpg admin reset player:@x               deletes the character",
    "/idlerpg admin clear                         unstick a raid or tournament",
    "/idlerpg admin event kind:bounty             a two-hour realm-wide modifier",
    "/idlerpg admin season                        a much longer one",
    "```",
    "**Events** multiply what adventures pay for everyone at once — double coin,",
    "double experience, or more crates. Seasons are the same thing, four times as",
    "long, meant to be a week the server remembers.",
  ],
};

export const HELP_PAGES: readonly HelpPage[] = [
  OVERVIEW,
  ADVENTURING,
  CHARACTER,
  GEAR,
  GODS,
  GUILDS,
  CONTESTS,
  MONEY,
  ADMIN,
];

export const HELP_TOPICS = HELP_PAGES.map((p) => p.topic);

export function helpPage(topic: string | null): string {
  const page = HELP_PAGES.find((p) => p.topic === topic) ?? OVERVIEW;
  const index = HELP_PAGES.filter((p) => p.topic !== page.topic)
    .map((p) => `\`${p.topic}\` — ${p.summary}`)
    .join("\n");
  return [...page.body, "", "**Other topics**", index].join("\n");
}
