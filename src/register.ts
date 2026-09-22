import { Routes, type REST } from "discord.js";
import { commandSignature, type CommandShape } from "./commandsig.js";
import { commands, messageCommands } from "./commands/index.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Registering slash commands with Discord.
 *
 * This is the last link in the self-modification chain. The bot can write a
 * new command, pass its own gates, merge, rebuild, and restart into the new
 * code -- and the command still will not appear, because Discord serves the
 * command list from a schema it caches, not from the running process. Without
 * an automatic sync, every agent-authored command needs a human to run a
 * script, which defeats the point.
 *
 * Guild-scoped rather than global: guild commands appear immediately, global
 * ones take up to an hour to propagate.
 */

/** Everything registered with Discord, slash and context menu alike. */
function allPayloads(): CommandShape[] {
  return [
    ...commands.map((c) => c.data.toJSON()),
    ...messageCommands.map((c) => c.data.toJSON()),
  ] as CommandShape[];
}

function localSignatures(): string[] {
  return allPayloads().map(commandSignature).sort();
}

/**
 * Registers commands if, and only if, they differ from what Discord already
 * has. Returns whether a write happened.
 *
 * The check matters because the bot restarts on every self-deploy: an
 * unconditional PUT would spend a command-registration rate limit on each one
 * for no reason.
 */
export async function syncGuildCommands(
  rest: REST,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const route = Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId);
  const body = allPayloads();

  if (!opts.force) {
    try {
      const existing = (await rest.get(route)) as CommandShape[];
      const remote = existing.map(commandSignature).sort();
      const local = localSignatures();

      if (remote.length === local.length && remote.every((sig, i) => sig === local[i])) {
        log.debug("Slash commands already up to date", { count: local.length });
        return false;
      }

      log.info("Slash commands differ from Discord; re-registering", {
        registered: existing.map((c) => c.name).join(", ") || "(none)",
        local: allPayloads().map((c) => c.name).join(", "),
      });
    } catch (err) {
      // A read failure should not block the write -- registering anyway is the
      // safe direction, since the cost is one redundant call.
      log.warn("Could not read existing commands; registering anyway", { err: String(err) });
    }
  }

  await rest.put(route, { body });
  log.info(`Registered ${body.length} commands`, {
    guild: config.discord.guildId,
    commands: body.map((c) => c.name).join(", "),
  });
  return true;
}
