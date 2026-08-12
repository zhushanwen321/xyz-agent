/**
 * 生产装配层（W5 集成层）。
 *
 * P3 收口：classifier 的 model 解析 + 凭证获取改走 llm-shared resolveModel +
 * ctx.modelRegistry.getApiKeyAndHeaders（三源合并含 OAuth/env/auth.json），废弃
 * 自读 models.json。'auto' 保留作 scoped 别名（向后兼容），scoped 空时 fallback
 * available（CL-scoped-fallback）。
 *
 *  - createProductionClassifier(ctx)：装配 ClassifierDeps（resolveModel 注入走 ctx.modelRegistry，
 *    streamSimple 走 getApiProvider）。
 *  - createPipelineDeps(approvalCtx, ctx)：装配完整 CheckPermissionDeps。
 *
 * 设计：createProductionClassifier 接受 ExtensionContext（model 解析 + 凭证都绑 ctx.modelRegistry），
 * 每次调用创建独立 classifier（无模块级单例——modelRegistry 绑 ctx，单例跨 ctx 不安全，
 * 见 CL-classifier-singleton；createClassifier 是纯对象装配无成本）。
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - getApiProvider resolves via root tsconfig stub but per-package tsc paths differ
import { getApiProvider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel as resolveModelShared, type ModelSelector } from "@zhushanwen/pi-llm-shared";

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
 *  5. ctx.modelRegistry.getApiKeyAndHeaders(model) → auth（判别联合，必须 narrow）
 *  6. auth.ok=false → 返回 null（fail-closed）；auth.ok=true → 返回 { model, auth }
 *
 * streamSimple：getApiProvider(model.api) 拿 provider 调 streamSimple。
 * 无 provider → throw（caller 捕获转 fallback，但 classifier 内部已 try/catch streamSimple）。
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
			if (!model) return null;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			// 判别联合 narrow：auth.ok=false 时不可访问 auth.apiKey（类型安全）
			if (!auth.ok) return null;
			return { model, auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env } };
		},
		streamSimple: (model, context, options) => {
			const provider = getApiProvider(model.api);
			if (!provider) {
				throw new Error(`[pi-permission] No API provider registered for api: ${model.api}`);
			}
			return provider.streamSimple(model, context, options);
		},
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
