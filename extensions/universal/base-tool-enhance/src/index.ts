/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1 单元（设计文档 §5 M1 行）：同名 override pi 内置 bash 工具 + 前台委托
 * 官方工厂保持等价 + 工具报错审计 hook（迁自 unified-hooks，D11）。
 * background 模式 / 白名单 / 配置体系由 M2-M5 单元增量交付。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBashOverrideToolDefinition } from "./bash-tool.ts";
import { setupToolErrorAudit } from "./tool-error-audit.ts";

export default function baseToolEnhanceExtension(pi: ExtensionAPI): void {
	// 同名 "bash" 覆盖内置工具（pi agent-session _refreshToolRegistry：custom 定义后注册者胜）
	pi.registerTool(createBashOverrideToolDefinition());
	// unified-hooks 退役承接：工具报错审计（D11 落点）
	setupToolErrorAudit(pi);
}
