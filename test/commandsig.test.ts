import assert from "node:assert/strict";
import { test } from "node:test";
import { SlashCommandBuilder } from "discord.js";

/**
 * The slash-command sync re-registers only when commandSignature changes, so
 * a blind spot here is a deploy that edits a command and never reaches
 * Discord, with nothing in the log but "already up to date".
 */

const { commandSignature } = await import("../src/commandsig.ts");

/** The shape of /chat model: a menu inside a subcommand. */
function subcommandMenu(models: string[]) {
  return new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Control the conversational agent")
    .addSubcommand((s) =>
      s
        .setName("model")
        .setDescription("Set the model")
        .addStringOption((o) =>
          o
            .setName("model")
            .setDescription("Pick one")
            .addChoices(...models.map((m) => ({ name: m, value: m }))),
        ),
    )
    .toJSON();
}

/** The shape of /claude: a menu on a top-level option. */
function topLevelMenu(models: string[]) {
  return new SlashCommandBuilder()
    .setName("claude")
    .setDescription("Build a feature request")
    .addStringOption((o) =>
      o
        .setName("model")
        .setDescription("Pick one")
        .addChoices(...models.map((m) => ({ name: m, value: m }))),
    )
    .toJSON();
}

test("a new choice inside a subcommand changes the signature", () => {
  assert.notEqual(
    commandSignature(subcommandMenu(["claude-opus-5"])),
    commandSignature(subcommandMenu(["claude-opus-5-5", "claude-opus-5"])),
  );
});

test("a new choice on a top-level option changes the signature", () => {
  assert.notEqual(
    commandSignature(topLevelMenu(["claude-opus-5"])),
    commandSignature(topLevelMenu(["claude-opus-5-5", "claude-opus-5"])),
  );
});

test("what Discord echoes back for an unchanged command is not a change", () => {
  // A GET of the registered commands: ids, a version, and no `required` on
  // options that are not required.
  const echoed = {
    id: "1",
    application_id: "2",
    version: "3",
    default_member_permissions: null,
    type: 1,
    name: "chat",
    description: "Control the conversational agent",
    options: [
      {
        type: 1,
        name: "model",
        description: "Set the model",
        options: [
          {
            type: 3,
            name: "model",
            description: "Pick one",
            choices: [{ name: "claude-opus-5", value: "claude-opus-5" }],
          },
        ],
      },
    ],
  };
  assert.equal(commandSignature(echoed), commandSignature(subcommandMenu(["claude-opus-5"])));
});
