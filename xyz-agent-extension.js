/**
 * xyz-agent extension for pi — Session tree navigation.
 *
 * Exports a factory function that receives the `pi` API and registers
 * the `/xyz-navigate` command. The command handler calls `ctx.navigateTree()`
 * to move the session leaf. The sidecar detects the result by checking
 * pi's state after the prompt resolves.
 *
 * NOTE: We intentionally do NOT call pi.sendMessage() here — custom messages
 * get persisted to the session file and appear as chat bubbles in the UI.
 * Instead, the sidecar checks get_state after the prompt resolves.
 */

export default function (pi) {
  pi.registerCommand("xyz-navigate", {
    description: "Navigate the session tree to a specified entry",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!entryId) return;

      await ctx.navigateTree(entryId, { summarize: false });
    },
  });
}
