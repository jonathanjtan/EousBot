import { Routes, type REST } from "discord.js";
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

/**
 * A comparable shape covering the fields that actually affect what Discord
 * serves.
 *
 * Discord's responses carry fields the local payload never sets (`id`,
 * `application_id`, `version`, permission defaults), so comparing whole
 * objects reports a difference on every boot. Projecting both sides through
 * the same narrow shape is what makes "has anything really changed?"
 * answerable.
 */
function signature(cmd: {
  name?: string;
  description?: string;
  type?: number;
  options?: unknown[];
}): string {
  const options = (cmd.options ?? []).map((raw) => {
    const o = raw as { name?: string; description?: string; type?: number; required?: boolean };
    return {
      name: o.name,
      description: o.description,
      type: o.type,
      // Discord echoes this back explicitly; builders omit it when false.
      required: o.required ?? false,
    };
  });

  // Defaulted rather than passed through: builders omit `type` for a slash
  // command while Discord echoes back 1, and an unnormalised comparison would
  // report a difference on every boot and re-register forever.
  return JSON.stringify({
    name: cmd.name,
    type: cmd.type ?? 1,
    description: cmd.description ?? "",
    options,
  });
}

/** Everything registered with Discord, slash and context menu alike. */
function allPayloads(): Parameters<typeof signature>[0][] {
  return [
    ...commands.map((c) => c.data.toJSON()),
    ...messageCommands.map((c) => c.data.toJSON()),
  ] as Parameters<typeof signature>[0][];
}

function localSignatures(): string[] {
  return allPayloads().map(signature).sort();
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
      const existing = (await rest.get(route)) as Parameters<typeof signature>[0][];
      const remote = existing.map(signature).sort();
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
