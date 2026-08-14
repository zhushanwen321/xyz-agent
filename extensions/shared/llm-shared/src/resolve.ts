/**
 * 模型解析：把 ModelSelector（四形式）解析成可用的 Model，或 null（不可用，调用方静默跳过）。
 *
 * 设计依据：design.md §3.4 + slice 6 决策。scoped 形式自读 <agentDir>/settings.json 的
 * enabledModels（string[]，"provider/modelId" 格式可含 * glob），不依赖调用方传入列表 ——
 * 这样 rename-session / permission 等 consumer 无需各自重复读 settings.json 的逻辑。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ──────────────────────── 类型 ────────────────────────

/**
 * 模型选择器（四形式）。
 * - ref: "provider/modelId" 精确，需 hasConfiguredAuth
 * - fallback: 按序尝试 refs，首个可用的返回
 * - available: getAvailable()[0]（pi 已配置 auth 的全量模型池）
 * - scoped: 读 settings.json enabledModels glob 匹配 getAll()，按用户排序取首个可用
 */
export type ModelSelector =
	| { type: "ref"; ref: string }
	| { type: "fallback"; refs: string[] }
	| { type: "available" }
	| { type: "scoped" };

// ──────────────────────── glob 匹配 ────────────────────────

/**
 * 自实现 * 通配匹配（不引入 minimatch 依赖）。
 *
 * 只支持 `*`（匹配任意字符序列），不支持 `?` / `**` / 字符类 —— enabledModels 的 pattern
 * 只需 "provider/*" 这种简单通配。实现：把 pattern 转成正则，特殊字符转义（`*` 单独转成 `.*`），
 * 全程 `^...$` 锚定。
 *
 * 例：`*` 匹配任意；`anthropic/*` 匹配 `anthropic/claude`；`openai/gpt-4o` 精确匹配。
 */
export function matchGlob(pattern: string, str: string): boolean {
	const re = pattern.replace(/[\\^$.|?*+(){}[\]]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
	return new RegExp(`^${re}$`).test(str);
}

// ──────────────────────── settings.json 读取 ────────────────────────

/**
 * 读取 <agentDir>/settings.json 的 enabledModels 字段（string[]）。
 *
 * 降级策略（scoped 形式据此返回 null，绝不抛错）：
 * - 文件不存在 / 读失败 → []
 * - 坏 JSON / 顶层非对象 → []
 * - enabledModels 缺失 / 非数组 → []
 * - 非 string 元素过滤掉，保持剩余元素顺序
 *
 * 用 pi 导出的 getAgentDir（尊重 PI_CODING_AGENT_DIR 覆盖）。
 */
export function readEnabledModels(): string[] {
	const filePath = join(getAgentDir(), "settings.json");

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const enabled = (parsed as Record<string, unknown>).enabledModels;
	if (!Array.isArray(enabled)) return [];
	return enabled.filter((x): x is string => typeof x === "string");
}

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

/** fallback：按序尝试 refs，首个可用的返回（提前返回，不遍历完）。 */
function resolveFallback(ctx: ExtensionContext, refs: string[]): Model<Api> | null {
	for (const ref of refs) {
		const model = resolveRef(ctx, ref);
		if (model) return model;
	}
	return null;
}

/** available：getAvailable()[0]（pi 已配置 auth 的模型池，取首个）。空池返回 null。 */
function resolveAvailable(ctx: ExtensionContext): Model<Api> | null {
	const list = ctx.modelRegistry.getAvailable();
	return list.length > 0 ? list[0] : null;
}

/**
 * scoped：读 settings.json enabledModels，按用户排序遍历 pattern，
 * 每个 pattern 对 getAll() 的 `${provider}/${id}` 做 matchGlob，首个 hasConfiguredAuth 命中即返回。
 *
 * 命中序：外层按 enabledModels 顺序（用户排序优先级），内层按 getAll() 返回顺序（pi 注册序）。
 * 即 enabledModels 首个 pattern 的首个可用匹配优先 —— 符合「用户排序首位」语义。
 */
function resolveScoped(ctx: ExtensionContext): Model<Api> | null {
	const patterns = readEnabledModels();
	if (patterns.length === 0) return null;
	const all = ctx.modelRegistry.getAll();
	for (const pattern of patterns) {
		for (const model of all) {
			if (matchGlob(pattern, `${model.provider}/${model.id}`) && ctx.modelRegistry.hasConfiguredAuth(model)) {
				return model;
			}
		}
	}
	return null;
}

/**
 * 按 selector 形式解析模型。返回 null = 不可用，调用方静默跳过（不抛错）。
 *
 * 走 ctx.modelRegistry（pi 三源合并后的模型注册表）。hasConfiguredAuth 过滤掉未配置凭证的模型。
 */
export function resolveModel(ctx: ExtensionContext, selector: ModelSelector): Model<Api> | null {
	if (selector.type === "ref") return resolveRef(ctx, selector.ref);
	if (selector.type === "fallback") return resolveFallback(ctx, selector.refs);
	if (selector.type === "available") return resolveAvailable(ctx);
	return resolveScoped(ctx); // selector.type === "scoped"
}
