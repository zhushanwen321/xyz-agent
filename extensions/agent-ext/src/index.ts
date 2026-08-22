/**
 * xyz-agent extension for Pi — session tree navigation.
 *
 * Registers the `/xyz-navigate` command. The command handler calls
 * `ctx.navigateTree()` to move the session leaf.
 *
 * Also registers `/__xyz_reload__` internal command for host-triggered
 * skill/extension reload, and `/__xyz_get_system_prompt__` for the Trace
 * view fetch-current button.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // W5: builtin internal reload command. `/__xyz_reload__` 由 host 在 skill 文件变动时
  // 经 client.prompt 发起（不经 LLM），handler 调 pi ctx.reload() 重扫 skill + 重建 runtime。
  // 双下划线前缀 = 内部命令（前端 W4 internal-command-filter 过滤 `/__` 前缀不显示）。
  pi.registerCommand('__xyz_reload__', {
    description: 'Internal: reload skills/extensions/prompts (triggered by host on skill file change)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await ctx.reload();
    },
  });

  pi.registerCommand("xyz-navigate", {
    description: "Navigate the session tree to a specified entry",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const entryId = args.trim();
      if (!entryId) return;

      await ctx.navigateTree(entryId, { summarize: false });
    },
  });

  // [fetch-current-system-prompt] Trace 视图「现取当前值」通道（session-trace design §3.1
  // 失败路径 / D2）：pi RPC 无 get_system_prompt 命令、getSystemPrompt() 只在 extension
  // API，且现取不能依赖可禁的留痕包（system-prompt-trace 是 feature tier）——挂本
  // infrastructure 包（builtin 不可禁，原根目录 xyz-agent-extension.js 常驻文件随 main
  // 的 agent-ext 包化迁移至此）。host 经 client.prompt 发 /__xyz_get_system_prompt__
  // （双下划线 = 内部命令，前端过滤 /__ 前缀不显示），handler 取当前 system prompt 写
  // xyz:current-system-prompt custom entry（不进 LLM context，零模型侧影响——pi
  // sessionEntryToContextMessages 对 type=custom 落入末尾 return []，session-manager.ts:383-413），
  // runtime 轮询 get_entries(since) 拉到后返回前端（同条 entry 也会作为 DATA 行出现在 trace
  // 台账里，留下取值痕迹）。
  pi.registerCommand("__xyz_get_system_prompt__", {
    description:
      "Internal: append a custom entry with the current system prompt (host-initiated for the Trace view fetch-current button)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const fullText = ctx.getSystemPrompt();
      pi.appendEntry("xyz:current-system-prompt", {
        fullText,
        charCount: fullText.length,
        fetchedAt: new Date().toISOString(),
      });
    },
  });
}
