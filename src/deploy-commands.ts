import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Registers slash commands with Discord. Run after adding or changing a
 * command's name, description, or options -- Discord caches the schema, so a
 * new command won't appear until this runs.
 *
 *   npm run deploy-commands
 */

const rest = new REST({ version: "10" }).setToken(config.discord.token);

const body = commands.map((c) => c.data.toJSON());

try {
  // Guild-scoped: these appear immediately. Global commands take up to an hour
  // to propagate, which makes the edit/deploy/test loop miserable.
  await rest.put(
    Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId),
    { body },
  );
  log.info(`Registered ${body.length} commands`, {
    guild: config.discord.guildId,
    commands: commands.map((c) => c.data.name).join(", "),
  });
} catch (err) {
  log.error("Command registration failed", { err: String(err) });
  process.exit(1);
}
