/**
 * xyz-agent extension for Pi — session tree navigation.
 *
 * Registers the `/xyz-navigate` command. The command handler calls
 * `ctx.navigateTree()` to move the session leaf.
 *
 * Also registers `/__xyz_reload__` internal command for host-triggered
 * skill/extension reload.
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
}