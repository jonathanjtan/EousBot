import { command as ask } from "./ask.js";
import { command as avatar } from "./avatar.js";
import { command as bugcat } from "./bugcat.js";
import { command as chat } from "./chat.js";
import { command as chess } from "./chess.js";
import { command as claude } from "./claude.js";
import { command as eightball } from "./eightball.js";
import { command as embed } from "./embed.js";
import { command as hoyohell } from "./hoyohell.js";
import { command as idlerpg } from "./idlerpg.js";
import { command as lenny } from "./lenny.js";
import { command as ping } from "./ping.js";
import { command as remindme } from "./remindme.js";
import { command as request } from "./request.js";
import { command as restock } from "./restock.js";
import { command as revise } from "./revise.js";
import { command as roll } from "./roll.js";
import { command as rpg } from "./rpg.js";
import { command as smash } from "./smash.js";
import { command as status } from "./status.js";
import { command as stock } from "./stock.js";
import { command as stop } from "./stop.js";
import { command as strip } from "./strip.js";
import { command as usage } from "./usage.js";
import { command as werewolf } from "./werewolf.js";
import type { Command, MessageCommand } from "./types.js";

/**
 * The command registry.
 *
 * Explicit imports rather than directory globbing: the agent adding a command
 * has to edit this file, which makes every new command visible in the PR diff
 * instead of appearing by filesystem side effect.
 */
export const commands: Command[] = [
  ping,
  request,
  status,
  claude,
  stop,
  revise,
  roll,
  eightball,
  usage,
  remindme,
  lenny,
  hoyohell,
  stock,
  smash,
  bugcat,
  avatar,
  idlerpg,
  rpg,
  chess,
  werewolf,
  strip,
  embed,
  restock,
  chat,
];

export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));

/**
 * Message context menu commands -- the "Apps" submenu on a right-clicked
 * message. Registered alongside the slash commands, routed separately because
 * Discord delivers them as a different interaction type.
 */
export const messageCommands: MessageCommand[] = [ask];

export const messageCommandsByName = new Map(messageCommands.map((c) => [c.data.name, c]));

export type { Command, MessageCommand };
