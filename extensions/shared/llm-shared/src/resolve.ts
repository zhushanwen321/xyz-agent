/**
 * 模型解析：把 ModelSelector（仅 ref 精确指定）解析成可用的 Model，或 null（不可用，调用方静默跳过）。
 *
 * 只支持精确指定 provider/modelId；不再支持 fallback / available / scoped。
 * 需要自动选模的调用方（如 permission 的 "auto"）应在自己这一层基于 ctx.modelRegistry 实现，
 * 不通过 ModelSelector 表达非精确语义。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ──────────────────────── 类型 ────────────────────────

/**
 * 模型选择器：只支持精确指定。
 * - ref: "provider/modelId" 精确，需 hasConfiguredAuth
 */
export type ModelSelector = { type: "ref"; ref: string };

// ──────────────────────── 模型解析 ────────────────────────

/** "provider/modelId" → 拆分（用 indexOf 而非 split，modelId 理论上可含 /，取首个 / 作分隔）。 */
function parseRef(ref: string): { provider: string; modelId: string } | null {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx >= ref.length - 1) return null; // 缺 / 或前后为空
	return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/** ref 精确匹配：find 命中 + hasConfiguredAuth。任一失败返回 null（静默降级）。 */
function resolveRef(ctx: ExtensionContext, ref: string): Model<Api> | null {
	const parsed = parseRef(ref);
	if (!parsed) return null;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) return null;
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) return null;
	return model;
}

/**
 * 按 selector 解析模型。返回 null = 不可用，调用方静默跳过（不抛错）。
 *
 * 走 ctx.modelRegistry（pi 三源合并后的模型注册表）。hasConfiguredAuth 过滤掉未配置凭证的模型。
 */
export function resolveModel(ctx: ExtensionContext, selector: ModelSelector): Model<Api> | null {
	return resolveRef(ctx, selector.ref);
}

/** 当前模型的 "provider/modelId" 复合串（model 缺失返回空串）——smart-context 消费口径。 */
export function getCurrentModelId(model: { provider?: string; id?: string } | undefined | null): string {
	if (!model) return "";
	return `${model.provider ?? ""}/${model.id ?? ""}`;
}
