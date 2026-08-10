/**
 * Structured Output Extension — 条件激活的 schema 校验工具 + hook
 *
 * 激活模式：
 *   - 日常 pi（interactive / 普通 print）：不设置 PI_WORKFLOW_SCHEMA，扩展不注册工具
 *   - workflow 子进程：agent-pool 设置 PI_WORKFLOW_SCHEMA=<json>，扩展注册工具 + hook
 *
 * Hook 机制（仅 workflow 模式）：
 *   turn_end 时检查模型是否调用了 structured-output 工具。
 *   如果没调 → 通过 pi.sendUserMessage() 注入 steering message 强制调用。
 *   最多重试 2 次，防止无限循环。
 *
 * 模块拆分（M4）：实现体分布于 ajv-validator.ts（编译缓存）/
 * schema-guards.ts（形态守卫）/ execute.ts（校验编排）/ tool-definition.ts（工具定义）/
 * workflow-hook.ts（hook + RetryState）。本文件仅剩 entry 装配与 re-export。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { executeStructuredOutput } from "./execute.js";
import { createToolDefinition, ENV_SCHEMA } from "./tool-definition.js";
import { RetryState, setupWorkflowHook } from "./workflow-hook.js";

/** Pi Extension API — properly typed via ExtensionAPI from pi-coding-agent SDK */
type PiAPI = ExtensionAPI;

// re-export 供测试与外部直接调用（import 路径 ../src/index.js 保持稳定）
export { executeStructuredOutput, createToolDefinition, RetryState };

// ── Extension entry ────────────────────────────────────────────

export default function structuredOutputExtension(pi: PiAPI): void {
	const schemaEnv = process.env[ENV_SCHEMA];

	// Always register the tool so it's available in all sessions (interactive, workflow, etc.)
	pi.registerTool(createToolDefinition());

	if (schemaEnv) {
		// ── Workflow 模式：额外注册 hook 强制调用 ──
		setupWorkflowHook(pi, schemaEnv);
	}
}
