/**
 * xyz-agent extension for pi — Session tree navigation.
 *
 * Exports a factory function that receives the `pi` API and registers
 * the `/xyz-navigate` command. The command handler:
 * 1. Calls `ctx.navigateTree()` to move the session leaf
 * 2. Captures the result (newLeafId, editorText) via closure on `pi.sendMessage`
 * 3. Sends a custom message → intercepted by the sidecar's NavigateInterceptor
 *
 * pi loads this via jiti.import() and calls the default export as
 * `factory(pi)`. The factory must be a function, not an object.
 */

export default function (pi) {
  // Capture sendMessage in closure — ExtensionCommandContext does NOT
  // have sendMessage (only ReplacedSessionContext does), but the pi API
  // object always has it.
  const sendMessage = (payload) => {
    pi.sendMessage({
      customType: "xyz-navigate-result",
      content: JSON.stringify(payload),
    });
  };

  pi.registerCommand("xyz-navigate", {
    description: "Navigate the session tree to a specified entry",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!entryId) {
        sendMessage({
          __xyz_type: "navigate-result",
          cancelled: true,
          newLeafId: null,
          editorText: null,
        });
        return;
      }

      try {
        const result = await ctx.navigateTree(entryId, { summarize: false });
        const newLeafId = ctx.sessionManager.getLeafId();
        sendMessage({
          __xyz_type: "navigate-result",
          cancelled: result.cancelled,
          newLeafId: newLeafId ?? null,
          editorText: result.editorText ?? null,
        });
      } catch {
        // navigateTree 抛出异常时依然上报，避免前端等待 5s 超时
        const leafId = ctx.sessionManager.getLeafId();
        sendMessage({
          __xyz_type: "navigate-result",
          cancelled: true,
          newLeafId: leafId ?? null,
          editorText: null,
        });
      }
    },
  });
}
