/**
 * 生产装配层（W5 集成层）。
 *
 * P3 收口：classifier 的 model 解析改走 llm-shared resolveModel（三源合并含 OAuth/env/auth.json），
 * 废弃自读 models.json。'auto' 保留作 scoped 别名（向后兼容），scoped 空时 fallback
 * available（CL-scoped-fallback）。
 *
 * C1a 收口：classifier 的 LLM 调用改走 llm-shared callLLM（凭证 getApiKeyAndHeaders +
 * completeSimple + stopReason 归一化都在 callLLM 内部完成），删除 getApiProvider +
 * streamSimple（@ts-ignore 随之消除）。
 *
 *  - createProductionClassifier(ctx)：装配 ClassifierDeps（resolveModel 注入走 ctx.modelRegistry，
 *    callLLM 注入闭包捕获 ctx）。
 *  - createPipelineDeps(approvalCtx, ctx)：装配完整 CheckPermissionDeps。
 *
 * 设计：createProductionClassifier 接受 ExtensionContext（model 解析 + 凭证都绑 ctx.modelRegistry），
 * 每次调用创建独立 classifier（无模块级单例——modelRegistry 绑 ctx，单例跨 ctx 不安全，
 * 见 CL-classifier-singleton；createClassifier 是纯对象装配无成本）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callLLM, resolveModel as resolveModelShared, type ModelSelector } from "@zhushanwen/pi-llm-shared";

import { type ApprovalContext, requestUserApproval } from "./approval.js";
import { analyzeBashStructure } from "./ast/index.js";
import { createClassifier } from "./classifier/index.js";
import type { CheckPermissionDeps } from "./pipeline.js";
import { getDefaultRules, matchRulesForArgv } from "./rules/index.js";

// ──────────────────────── toSelector（'auto'→scoped 向后兼容，C2） ────────────────────────

/**
 * 把 ClassifierConfig.model 字符串映射为 llm-shared ModelSelector。
 *
 * - 'auto' → { type: 'scoped' }：读 settings.json enabledModels 取首个可用 model
 *   （用户显式排序），取代旧的 findCheapestModel（cost 排序）。
 * - 其余视为 'provider/model-id' → { type: 'ref', ref: modelSpec }：精确匹配。
 *
 * 注：toSelector 只负责 selector 映射；'auto' 的向后兼容（scoped 空 fallback available）
 * 在下方 resolveModel 注入层处理（CL-scoped-fallback），toSelector 本身不感知 fallback。
 */
export function toSelector(modelSpec: string): ModelSelector {
	if (modelSpec === "auto") return { type: "scoped" };
	return { type: "ref", ref: modelSpec };
}

// ──────────────────────── createProductionClassifier ────────────────────────

/**
 * 创建生产环境 AI Classifier。
 *
 * resolveModel 注入（C3，含 scoped-null fallback available CL-scoped-fallback）：
 *  1. toSelector(config.model) → selector
 *  2. resolveModelShared(ctx, selector) → model（scoped 走 enabledModels，ref 走 find + hasConfiguredAuth）
 *  3. scoped 返回 null → fallback resolveModelShared(ctx, {type:'available'})（getAvailable 首个，
 *     等价旧 auto「有 apiKey 的首个」，向后兼容）
 *  4. model 仍 null → 返回 null（fail-closed）
 *
 * callLLM 注入（C1a）：闭包捕获 ctx，把 llm-shared callLLM 绑定为 classifier 的 LLM 调用。
 * 凭证获取（getApiKeyAndHeaders）在 callLLM 内部完成（C1a 收口后不再在 resolveModel 层预检）。
 */
export function createProductionClassifier(ctx: ExtensionContext): {
	classifyRisk: ReturnType<typeof createClassifier>["classifyRisk"];
} {
	return createClassifier({
		resolveModel: async (config) => {
			const selector = toSelector(config.model);
			let model = resolveModelShared(ctx, selector);
			// CL-scoped-fallback：scoped（'auto'）在 enabledModels 空/无 auth 时 fallback available，
			// 保证「有 apiKey provider 但没配 enabledModels」的用户不退化（旧 auto 行为）。
			if (!model && selector.type === "scoped") {
				model = resolveModelShared(ctx, { type: "available" });
			}
			return model;
		},
		callLLM: (opts) => callLLM(ctx, opts),
		onLog: (msg: string) => console.warn(msg),
	});
}

// ──────────────────────── createPipelineDeps ────────────────────────

/**
 * 装配生产环境 CheckPermissionDeps。
 *
 * @param approvalCtx 从 ExtensionContext 提取的审批 UI 上下文（mode + ui.*）
 * @param ctx Pi ExtensionContext（model 解析 + 凭证走 ctx.modelRegistry）
 * @returns CheckPermissionDeps（AST + rules + classifier + approval 全部装配真实实现）
 *
 * 注：每次调用创建独立 classifier（CL-classifier-singleton：modelRegistry 绑 ctx，模块级
 * 单例会绑定首调 ctx 对后续 session 不安全；createClassifier 是纯对象装配无成本）。
 * approvalCtx 每次 tool_call 闭包捕获（保证 mode 切换后下次 tool_call 用新 mode）。
 */
export function createPipelineDeps(approvalCtx: ApprovalContext, ctx: ExtensionContext): CheckPermissionDeps {
	return {
		analyzeBashStructure,
		matchRulesForArgv,
		getDefaultRules,
		classifier: createProductionClassifier(ctx),
		isHeadless: () => approvalCtx.mode !== "tui" && approvalCtx.mode !== "rpc",
		requestUserApproval: (req, invokeCtx, signal) => requestUserApproval(req, invokeCtx, signal, approvalCtx),
	};
}
