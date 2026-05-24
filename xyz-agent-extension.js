export default {
  onInit(pi) {
    pi.registerCommand("xyz-navigate", {
      description: "Navigate the session tree to a specified entry",
      handler: async (args, ctx) => {
        const entryId = args.trim();
        if (!entryId) return;

        try {
          const result = await ctx.navigateTree(entryId, { summarize: false });
          const payload = JSON.stringify({
            __xyz_type: "navigate-result",
            cancelled: result.cancelled,
            newLeafId: ctx.sessionManager.getLeafId(),
            editorText: result.editorText,
          });
          ctx.sendMessage(payload);
        } catch {
          const payload = JSON.stringify({
            __xyz_type: "navigate-result",
            cancelled: true,
            newLeafId: ctx.sessionManager.getLeafId(),
            editorText: null,
          });
          ctx.sendMessage(payload);
        }
      },
    });
  },
};
