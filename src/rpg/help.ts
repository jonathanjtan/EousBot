/**
 * The manual.
 *
 * Written to src/unslop.ts, which is the house style for anything the bot says
 * out loud: no em dashes, no bold on labels, no closing summaries, one idea per
 * sentence. The first version of this file broke most of that and, worse, spent
 * its length explaining design decisions to players who wanted to know what to
 * type. Rationale belongs in the code comments where the next maintainer will
 * find it, not in a help page.
 *
 * Pages are data so the suite can check them: every page fits a Discord
 * message, every command named in one exists, and none of them use the
 * vocabulary unslop.ts bans.
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
    "You send a character out, walk away, and come back to a result.",
    "",
    "Start here:",
    "```",
    "/idlerpg start class:mage race:orc",
    "/idlerpg adventures",
    "/idlerpg adventure difficulty:3",
    "```",
    "Then leave. The channel pings you when it finishes. Run `/idlerpg claim` to collect.",
    "",
    "The dice are rolled when you claim, not when you leave.",
    "",
    "Do not grind difficulty 1. Over 72 hours, taking the safest option every time",
    "reaches level 10. Choosing well reaches 12.8. The rightmost column of",
    "`/idlerpg adventures` is expected coin per hour. Pick the biggest number.",
    "",
    "`/idlerpg help topic:<name>` for anything below.",
  ],
};

const ADVENTURING: HelpPage = {
  topic: "adventuring",
  summary: "Difficulty, odds, and how far to reach",
  body: [
    "```",
    "/idlerpg adventures              the menu, with odds and payouts",
    "/idlerpg adventure difficulty:N  go",
    "/idlerpg status                  how long is left",
    "/idlerpg claim                   collect",
    "```",
    "An adventure takes difficulty times 30 minutes. Difficulty 3 is 90 minutes.",
    "Difficulty 20 is 10 hours, which is a run you start before bed.",
    "",
    "You can attempt anything up to your level plus 2.",
    "",
    "Your odds come from your gear first, how far you reached second, and your",
    "class third. Gear matters most, so the right answer changes as you play.",
    "",
    "Rewards grow faster than the clock does, which is why reaching up pays. The",
    "best difficulty is neither the safest nor the highest. At level 1 take 3. At",
    "level 20 you will have unlocked 22 and should be taking about 15.",
    "",
    "A failed adventure costs you the time and nothing else.",
  ],
};

const CHARACTER: HelpPage = {
  topic: "character",
  summary: "Classes, races, levels and tiers",
  body: [
    "Your class is the choice that matters. Each does one thing, and it grows at",
    "levels 5, 12, 20 and 30.",
    "",
    "```",
    "warrior    protection        mage       damage",
    "ranger     better odds       ritualist  experience",
    "raider     coin              thief      steals coin after a win",
    "```",
    "Race is smaller and permanent.",
    "",
    "```",
    "human  +8% experience     elf       +4 odds",
    "dwarf  +10% coin          orc       +6 attack",
    "revenant  +6 protection",
    "```",
    "Your starting kit is 10 power, so flat bonuses are large early. Orc is +6 on",
    "a base of 10. A mage or orc build feels stronger for the first few hours. The",
    "percentage classes pass them later.",
    "",
    "```",
    "/idlerpg classes    what each class does",
    "/idlerpg races      what each race does",
    "/idlerpg profile    your sheet",
    "/idlerpg top        the leaderboards",
    "```",
    "There are six leaderboards: level, coin, power, adventures, duels and favour.",
  ],
};

const GEAR: HelpPage = {
  topic: "gear",
  summary: "Items, crates, the backpack and the market",
  body: [
    "You have two slots, a weapon and armour. Their sum is your combat number.",
    "Battles are a roll under it. There is no attack rating and no hit points.",
    "",
    "```",
    "/idlerpg item open rarity:common     open a crate",
    "/idlerpg item backpack               what you are carrying",
    "/idlerpg item equip item:12          wear something",
    "/idlerpg item sell item:12           sell one",
    "/idlerpg item sellall keep_above:40  sell the junk",
    "/idlerpg item give player:@x coin:500",
    "```",
    "Anything better than what you are wearing equips itself. You never need to",
    "run equip for an obvious upgrade.",
    "",
    "Five rarities: common, uncommon, rare, magic, legendary. A beginner's crate",
    "can still produce a legendary.",
    "",
    "The market is player to player, and usually beats the shop price.",
    "```",
    "/idlerpg market list",
    "/idlerpg market sell item:12 price:5000",
    "/idlerpg market buy listing:3",
    "```",
    "Five listings each at most.",
  ],
};

const GODS: HelpPage = {
  topic: "gods",
  summary: "Sacrifice, favour, and what to do with gear you cannot wear",
  body: [
    "Sacrificing an item earns favour, and favour permanently improves your odds",
    "on every adventure. An item is worth more on an altar than at the shop, so",
    "unless you need coin now, sacrifice it.",
    "",
    "```",
    "/idlerpg god list",
    "/idlerpg god follow god:forge",
    "/idlerpg god sacrifice items:3 7 12",
    "/idlerpg god status",
    "```",
    "Favour is capped, so it improves your odds up to a ceiling.",
    "",
    "Your first oath is free. Changing gods later costs half your favour in coin,",
    "and the favour itself follows you.",
  ],
};

const GUILDS: HelpPage = {
  topic: "guilds",
  summary: "Guilds, alliances and raid bosses",
  body: [
    "```",
    "/idlerpg guild create name:The Wall",
    "/idlerpg guild join name:The Wall",
    "/idlerpg guild info",
    "/idlerpg guild deposit coin:5000",
    "/idlerpg guild upgrade                raises the member cap",
    "/idlerpg guild battle name:Rivals stake:5000",
    "```",
    "Founding one costs coin. Anyone can deposit into the bank. Only the leader",
    "and officers can withdraw.",
    "",
    "Alliances are flat. One guild flies under another's banner.",
    "`/idlerpg guild ally name:Banner`",
    "",
    "Raids are open to everyone, guild or not.",
    "```",
    "/idlerpg raid call     summon a boss and seed the pot",
    "/idlerpg raid hit      swing at it",
    "/idlerpg raid status",
    "```",
    "The pot splits by damage dealt, so hitting early and often pays. There is no",
    "cooldown. The limits are the boss's health and a six hour window.",
  ],
};

const CONTESTS: HelpPage = {
  topic: "contests",
  summary: "Duels, the arena, tournaments, chess and werewolf",
  body: [
    "```",
    "/idlerpg duel player:@someone stake:250",
    "/idlerpg tournament open buy_in:1000    then join, then run",
    "/idlerpg arena open buy_in:500          then join, then run",
    "```",
    "A tournament is a bracket, so the best gear usually wins. The arena is a",
    "free for all where gear helps less. Both take a buy in and pay one winner.",
    "",
    "Chess is its own command, and real chess. Moves are coordinates.",
    "```",
    "/chess challenge player:@someone stake:1000",
    "/chess move move:e2e4                   promote with e7e8q",
    "/chess board",
    "```",
    "Werewolf is its own command too. Roles arrive by DM, and the host calls each",
    "phase.",
    "```",
    "/werewolf open · join · start",
    "/werewolf night player:@x               then the host calls dawn",
    "/werewolf vote player:@x                then the host calls dusk",
    "```",
    "Both have their own help: `/chess help` and `/werewolf help`.",
    "",
    "Nothing takes another player's coin until they press a button.",
  ],
};

const MONEY: HelpPage = {
  topic: "money",
  summary: "The shop, wagers, marriage and where coin goes",
  body: [
    "The shop sells crates and nothing else.",
    "`/idlerpg store list` and `/idlerpg store buy rarity:rare count:2`",
    "",
    "Crates cost more than what falls out of them sells for. Buying crates to",
    "resell loses money. Buy them for the chance at gear you can wear.",
    "",
    "Wagers pay fair odds. There is no house edge.",
    "```",
    "/idlerpg bet flip stake:500 call:heads",
    "/idlerpg bet dice stake:100 guess:3 sides:6    pays 5 to 1",
    "```",
    "Marriage gives both of you a bonus. Courting spends coin and raises it for",
    "the pair.",
    "```",
    "/idlerpg marry propose player:@someone",
    "/idlerpg marry court coin:5000",
    "```",
    "Quiz games pay small amounts.",
    "`/idlerpg trivia` and `/idlerpg maths difficulty:3`",
  ],
};

const ADMIN: HelpPage = {
  topic: "admin",
  summary: "Operator controls, for admins only",
  body: [
    "Restricted to the bot's admins. Every one of these announces itself in the",
    "channel.",
    "",
    "```",
    "/idlerpg admin grant player:@x coin:5000     negative takes it away",
    "/idlerpg admin setlevel player:@x level:20",
    "/idlerpg admin spawn player:@x value:100 rarity:rare kind:weapon",
    "/idlerpg admin reset player:@x               deletes the character",
    "/idlerpg admin clear                         unstick a raid or tournament",
    "/idlerpg admin event kind:bounty             two hours, realm wide",
    "/idlerpg admin season                        the same, four times longer",
    "```",
    "Events multiply what adventures pay for everyone at once: double coin, double",
    "experience, or more crates.",
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
    .map((p) => `\`${p.topic}\` ${p.summary}`)
    .join("\n");
  return [...page.body, "", "Other topics:", index].join("\n");
}
