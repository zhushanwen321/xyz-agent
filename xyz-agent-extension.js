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
  // W5: builtin internal reload command. `/__xyz_reload__` 由 host 在 skill 文件变动时
  // 经 client.prompt 发起（不经 LLM），handler 调 pi ctx.reload() 重扫 skill + 重建 runtime。
  // 双下划线前缀 = 内部命令（前端 W4 internal-command-filter 过滤 `/__` 前缀不显示）。
  pi.registerCommand('__xyz_reload__', {
    description: 'Internal: reload skills/extensions/prompts (triggered by host on skill file change)',
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  pi.registerCommand("xyz-navigate", {
    description: "Navigate the session tree to a specified entry",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!entryId) return;

      await ctx.navigateTree(entryId, { summarize: false });
    },
  });
}
