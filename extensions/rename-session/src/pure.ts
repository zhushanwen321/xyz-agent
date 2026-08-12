import { loadConfig, saveConfig, type ModelSelector } from "@zhushanwen/pi-llm-shared";

// ──────────────────────── 配置 ────────────────────────

/**
 * rename-session 配置 schema（落盘到 `<agentDir>/config/rename-session.json`，路径由 llm-shared 推导）。
 *
 * 收口自旧版 pure.ts 的 `RenameConfig`（switchFilePath/maxTitleLength/renameInstruction 硬编码常量）：
 * - 开关从「auto-rename-enabled 文件存在性」改为 `enabled` 字段（默认 false，沿用旧版「默认关闭」语义）
 * - model 从「搭便车 ctx.model」改为独立 `ModelSelector`（默认 scoped，取 enabledModels 首个可用）
 * - maxTitleLength 保留（默认 50）
 * - renameInstruction 不进配置（i18n 留未来），由代码常量 RENAME_INSTRUCTION 承载
 */
export interface RenameSessionConfig {
	/** 自动重命名开关（默认 false）。 */
	enabled: boolean;
	/** 标题生成用的模型 selector（默认 scoped：取 settings.json enabledModels 首个可用模型）。 */
	model: ModelSelector;
	/** 标题最大长度（Unicode 码点数）。 */
	maxTitleLength: number;
}

/** 默认配置：关闭、scoped 选模、标题上限 50。 */
export const DEFAULT_RENAME_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: "scoped" },
	maxTitleLength: 50,
};

/** llm-shared loadConfig/saveConfig 的包名（决定文件名 rename-session.json）。 */
const CONFIG_PKG = "rename-session";

/**
 * 把磁盘上的 unknown JSON 归一化成 RenameSessionConfig。
 *
 * 容错策略（逐字段校验 + 默认值回填）：坏字段不影响其他字段（粒度容错），
 * 整体坏（非对象 / null / 数组）返回全默认。宁可静默回默认，不抛错阻断 rename。
 */
export function normalizeRenameConfig(raw: unknown): RenameSessionConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...DEFAULT_RENAME_CONFIG };
	}
	const obj = raw as Record<string, unknown>;

	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_RENAME_CONFIG.enabled;

	const maxTitleLength =
		typeof obj.maxTitleLength === "number" &&
		Number.isInteger(obj.maxTitleLength) &&
		obj.maxTitleLength > 0
			? obj.maxTitleLength
			: DEFAULT_RENAME_CONFIG.maxTitleLength;

	const model = normalizeModelSelector(obj.model) ?? DEFAULT_RENAME_CONFIG.model;

	return { enabled, model, maxTitleLength };
}

/** 校验 ModelSelector 四形式（ref/fallback/available/scoped），非法返回 null。 */
function normalizeModelSelector(raw: unknown): ModelSelector | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	if (obj.type === "ref" && typeof obj.ref === "string") {
		return { type: "ref", ref: obj.ref };
	}
	if (obj.type === "available") {
		return { type: "available" };
	}
	if (obj.type === "scoped") {
		return { type: "scoped" };
	}
	if (
		obj.type === "fallback" &&
		Array.isArray(obj.refs) &&
		obj.refs.every((r) => typeof r === "string")
	) {
		return { type: "fallback", refs: obj.refs as string[] };
	}
	return null;
}

/** 加载配置（mtime+size 缓存；文件缺失/损坏返回默认，不抛错）。 */
export function loadRenameConfig(): RenameSessionConfig {
	return loadConfig(CONFIG_PKG, DEFAULT_RENAME_CONFIG, normalizeRenameConfig);
}

/** 保存配置（原子写 tmp+rename）。返回 {success, error?}。 */
export function saveRenameConfig(
	config: RenameSessionConfig,
): { success: boolean; error?: string } {
	return saveConfig(CONFIG_PKG, config);
}

// ──────────────────────── 首 turn 判定 ────────────────────────

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型）。 */
interface EntryLike {
	type: string;
	message?: { role?: string };
}

/**
 * 数 session 中 assistant 回复数。用于判定首 turn（===1）。
 * 判定条件：entry.type === "message" && entry.message.role === "assistant"
 * （pi 内部 session-manager.ts 同款模式）。
 */
export function countAssistantReplies(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			count++;
		}
	}
	return count;
}

// ──────────────────────── 标题清洗 ────────────────────────

/**
 * rename 专属后处理：去首尾成对引号（单/双/中文）+ markdown 强调标记（* ** ` _），按 Unicode 码点截断。
 *
 * 输入是 callLLM 已 extractText+trim 的 string（llm-shared/call.ts 的 extractText 负责从
 * AssistantMessage.content 提取 text block 拼接并 trim）。本函数只做 rename 特有的包装清理，
 * 是旧版 extractTitle（从 resp.content 提取）的收口后形态。
 */
export function cleanTitle(content: string, maxLength: number): string {
	const trimmed = content.trim();
	if (!trimmed) return "";

	// 去首尾成对引号（单/双/中文）和 markdown 强调标记（* ** ` _）
	const cleaned = trimmed.replace(/^["“”'`*_]+|["“”'`*_]+$/g, "").trim();
	if (!cleaned) return "";

	// 按 Unicode 码点截断（避免截断多字节字符）
	const chars = Array.from(cleaned);
	if (chars.length <= maxLength) return cleaned;
	return chars.slice(0, maxLength).join("");
}
