/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1：同名 override pi 内置 bash 工具 + 前台委托官方工厂 + 工具报错审计 hook（D11）。
 * M2：background 任务核心生命周期——bash background 分支（spawn 后台 + registry +
 * 轮询器单例任务表）、bash_output / bash_kill 工具、进程退出收殓、subagent 降级。
 * 通知接入（M3）/ 白名单与配置体系（M4）/ 孤儿 reap（M5）由后续单元增量交付。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBashOutputToolDefinition } from "./bash-output-tool.ts";
import { createBashKillToolDefinition } from "./bash-kill-tool.ts";
import { createBashOverrideToolDefinition } from "./bash-tool.ts";
import { installProcessExitGuard } from "./background/process-exit-guard.ts";
import { setupToolErrorAudit } from "./tool-error-audit.ts";

export default function baseToolEnhanceExtension(pi: ExtensionAPI): void {
	// 同名 "bash" 覆盖内置工具（pi agent-session _refreshToolRegistry：custom 定义后注册者胜）
	pi.registerTool(createBashOverrideToolDefinition());
	// 查询 / 终止工具（D9：独立小工具，kill 与查询权限语义分离）
	pi.registerTool(createBashOutputToolDefinition());
	pi.registerTool(createBashKillToolDefinition());
	// 进程级收殓（D12）：只认 process 信号/退出，绝不在 session_shutdown / dispose 路径
	installProcessExitGuard();
	// unified-hooks 退役承接：工具报错审计（D11 落点）
	setupToolErrorAudit(pi);
}
