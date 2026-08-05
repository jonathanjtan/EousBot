import { command as build } from "./build.js";
import { command as eightball } from "./eightball.js";
import { command as ping } from "./ping.js";
import { command as remindme } from "./remindme.js";
import { command as request } from "./request.js";
import { command as revise } from "./revise.js";
import { command as roll } from "./roll.js";
import { command as status } from "./status.js";
import { command as usage } from "./usage.js";
import type { Command } from "./types.js";

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
  build,
  revise,
  roll,
  eightball,
  usage,
  remindme,
];

export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));

export type { Command };
