import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadRenameConfig, saveRenameConfig } from "./pure.js";

/**
 * 解析 /auto-rename 参数并执行开关操作。读/写 `<agentDir>/config/rename-session.json` 的 enabled 字段。
 *
 * 用法：
 *   /auto-rename         — 查看当前状态
 *   /auto-rename on      — 开启
 *   /auto-rename off     — 关闭
 *
 * 收口自旧版「auto-rename-enabled 文件存在性」开关机制：开关状态落进 config.enabled，
 * 与 model / maxTitleLength 统一在一份配置文件里管理。
 */
export function executeAutoRenameCommand(args: string): string {
	const trimmed = args.trim().toLowerCase();

	if (trimmed === "" || trimmed === "status") {
		const { enabled } = loadRenameConfig();
		const state = enabled ? "已开启 ✓" : "已关闭 ✗";
		return `自动重命名会话：${state}\n用法：/auto-rename on | off | status`;
	}

	if (trimmed === "on" || trimmed === "enable") {
		const result = saveRenameConfig({ ...loadRenameConfig(), enabled: true });
		return result.success ? "已开启：自动重命名会话" : `设置失败：${result.error}`;
	}

	if (trimmed === "off" || trimmed === "disable") {
		const result = saveRenameConfig({ ...loadRenameConfig(), enabled: false });
		return result.success ? "已关闭：自动重命名会话" : `设置失败：${result.error}`;
	}

	return `未知参数 "${args.trim()}"。\n用法：/auto-rename on | off | status`;
}

/** 注册 /auto-rename 命令。 */
export function registerAutoRenameCommand(pi: ExtensionAPI): void {
	pi.registerCommand("auto-rename", {
		description: "控制自动重命名会话功能。/auto-rename [on|off|status]",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trimStart().toLowerCase();
			const opts = [
				{ label: "on", value: "on", description: "开启自动重命名" },
				{ label: "off", value: "off", description: "关闭自动重命名" },
				{ label: "status", value: "status", description: "查看当前状态" },
			];
			return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(executeAutoRenameCommand(args), "info");
		},
	});
}
