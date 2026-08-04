import { REST } from "discord.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { syncGuildCommands } from "./register.js";

/**
 * Force-registers slash commands with Discord.
 *
 *   npm run deploy-commands
 *
 * The bot syncs commands automatically on every boot, so this is no longer
 * required after adding one. It stays as an escape hatch: run it to re-push
 * the schema without waiting for a restart, or when the automatic sync's
 * comparison has decided nothing changed and you believe otherwise.
 */

const rest = new REST({ version: "10" }).setToken(config.discord.token);

try {
  await syncGuildCommands(rest, { force: true });
} catch (err) {
  log.error("Command registration failed", { err: String(err) });
  process.exit(1);
}
