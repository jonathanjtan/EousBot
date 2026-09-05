import assert from "node:assert/strict";
import { mock, test } from "node:test";

/**
 * A deferred reply is drawn as "<bot> is thinking..." until Discord's LOADING
 * flag is cleared, and only the interaction webhook clears it. #63 moved every
 * progress edit onto the bot token so long builds could outlive the
 * fifteen-minute deadline, and in doing so left healthy runs reading as frozen
 * from start to finish: each line was written, and the placeholder stayed on
 * top of it, because PATCH /channels/:id/messages/:id cannot touch the flag.
 *
 * The routing rule therefore has two halves and both matter: the first write
 * goes through the webhook, and every write after it through the Message.
 */

const { startProgress } = await import("../src/progress.ts");

type Interaction = Parameters<typeof startProgress>[0];

interface Harness {
  interaction: Interaction;
  /** Content sent through the interaction token, which expires. */
  webhook: string[];
  /** Content sent through the bot token, which does not. */
  message: string[];
}

function harness({ tokenExpired = false } = {}): Harness {
  const webhook: string[] = [];
  const message: string[] = [];
  const reply = {
    edit: async (content: string) => void message.push(content),
    channel: null,
  };
  const interaction = {
    fetchReply: async () => reply,
    editReply: async (content: string) => {
      if (tokenExpired) throw new Error("Unknown Webhook");
      webhook.push(content);
    },
    channel: null,
  };
  return { interaction: interaction as unknown as Interaction, webhook, message };
}

/** Lets the timer callback's promise chain settle after a synchronous tick. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("the first line clears the placeholder, and later lines spare the token", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { interaction, webhook, message } = harness();
    const progress = await startProgress(interaction, "**Building #64**");

    progress.update("Starting…");
    mock.timers.tick(4000);
    await settle();

    assert.deepEqual(webhook, ["**Building #64**\n`Starting…`"]);
    assert.deepEqual(message, [], "the webhook has to go first or the flag survives");

    progress.update("Agent is writing code");
    mock.timers.tick(4000);
    await settle();

    assert.equal(webhook.length, 1, "the expiring token is spent once, not per line");
    assert.deepEqual(message, ["**Building #64**\n`Agent is writing code`"]);

    progress.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a run that dies before its first flush still replaces the placeholder", async () => {
  // #64 authenticated, failed, and cleaned up inside twelve seconds -- three
  // flushes short of ever drawing a progress line, so finish() is the first
  // write and carries the whole job of clearing the flag.
  const { interaction, webhook, message } = harness();
  const progress = await startProgress(interaction, "**Building #64**");

  await progress.finish("**#64** failed at `agent`. No pull request was opened.");

  assert.deepEqual(webhook, ["**#64** failed at `agent`. No pull request was opened."]);
  assert.deepEqual(message, []);
});

test("an expired token costs the placeholder, never the text beneath it", async () => {
  const { interaction, webhook, message } = harness({ tokenExpired: true });
  const progress = await startProgress(interaction, "**Building #64**");

  await progress.finish("**#64** built successfully. Review below.");

  assert.deepEqual(webhook, []);
  assert.deepEqual(message, ["**#64** built successfully. Review below."]);
});
