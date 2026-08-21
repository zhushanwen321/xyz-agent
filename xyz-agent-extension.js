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
  // [fetch-current-system-prompt] Trace 视图「现取当前值」通道（design §3.1 失败路径 /
  // D2）：pi RPC 无 get_system_prompt 命令、getSystemPrompt() 只在 extension API，且现取
  // 不能依赖可禁的留痕包（system-prompt-trace 是 feature tier）——故挂本常驻文件扩展
  // （--extension 强制注入，不可禁）。host 经 client.prompt 发 /__xyz_get_system_prompt__
  // （双下划线 = 内部命令，前端 W4 过滤 /__ 前缀不显示），handler 取当前 system prompt
  // 写 xyz:current-system-prompt custom entry（不进 LLM context，零模型侧影响），
  // runtime 轮询 get_entries(since) 拉到后返回前端（同条 entry 也会作为 DATA 行出现在
  // trace 台账里，留下取值痕迹）。
  pi.registerCommand("__xyz_get_system_prompt__", {
    description:
      "Internal: append a custom entry with the current system prompt (host-initiated for the Trace view fetch-current button)",
    handler: async (_args, ctx) => {
      const fullText = ctx.getSystemPrompt();
      pi.appendEntry("xyz:current-system-prompt", {
        fullText,
        charCount: fullText.length,
        fetchedAt: new Date().toISOString(),
      });
    },
  });

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
