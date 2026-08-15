import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import {
	loadConfig,
	saveConfig,
	type ModelSelector,
} from "@zhushanwen/pi-llm-shared";

// ──────────────────────── 配置 ────────────────────────

/**
 * rename-session 配置 schema（落盘到 `<agentDir>/config/rename-session-ext-config.json`，路径由 llm-shared 推导）。
 *
 * 收口自旧版 pure.ts 的 `RenameConfig`（switchFilePath/maxTitleLength/renameInstruction 硬编码常量）：
 * - 开关双机制：`enabled` 字段（pi CLI 用户主开关，默认 false）+ xyz-agent runtime 的
 *   auto-rename-enabled flag 文件（live 覆盖源，存在即开，见下方 [COMPAT] 契约）
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
	/**
	 * 标题生成 LLM 的 thinking 级别（pi 的 ModelThinkingLevel，THINKING_ORDER SSOT）。
	 * 默认 "off"：不传 pi-ai reasoning（provider 默认行为，与旧版本一致）；
	 * "minimal"~"max" 透传给 SimpleStreamOptions.reasoning（provider 不支持时静默忽略）。
	 */
	thinkingLevel: ModelThinkingLevel;
}

/** 合法 thinking 级别清单（与 pi-ai ModelThinkingLevel 一致；normalize 校验用）。 */
const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 默认配置：关闭、scoped 选模、标题上限 50、不启用 thinking。 */
export const DEFAULT_RENAME_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: "scoped" },
	maxTitleLength: 50,
	thinkingLevel: "off",
};

/** llm-shared loadConfig/saveConfig 的包名（决定文件名 rename-session-ext-config.json，llm-shared getConfigPath 追加 -ext-config.json 后缀）。 */
const CONFIG_PKG = "rename-session";

// ──────────────────────── xyz-agent runtime 开关契约（live 覆盖源） ────────────────────────

/**
 * [COMPAT] xyz-agent runtime 开关契约文件：<agentDir>/auto-rename-enabled（存在=开，不存在=关）。
 * Added in v0.4.0. Remove after v1.0.0（旧 runtime 版本淘汰后随 flag 契约一并移除）。
 *
 * 背景：已发布的 xyz-agent runtime（worktree-config-helper.ts）只认这个 flag 文件——
 * SystemPage 开关读写它、首启 ensureAutoRenameDefault 默认创建它，且这部分代码随桌面 app
 * 发布、不随本 extension 升级。若本扩展单方面改为只读 config JSON 并在迁移时删除 flag，
 * 则 mandatory 自动升级后所有未更新桌面 app 的用户：UI 显示 OFF 而 extension 实际 ON，
 * 且 SystemPage toggle 永久失效（旧 runtime 只写 flag，新 extension 不再读）。
 *
 * 契约语义（loadRenameConfig 每次调用 live 检查，非一次性迁移）：
 * - flag 存在 → enabled 强制 true（xyz-agent runtime 的开关打开，覆盖 config.enabled）
 * - flag 不存在 → 回落 config.enabled（pi CLI 用户的主开关机制，见 config skill）
 * - 扩展永不删除/创建该文件，除非用户通过 /auto-rename on|off 显式操作（commands.ts 双写同步）
 */
const AUTO_RENAME_FLAG_FILE = "auto-rename-enabled";

/** flag 文件完整路径（getAgentDir 派生，尊重 PI_CODING_AGENT_DIR）。 */
function getAutoRenameFlagPath(): string {
	return join(getAgentDir(), AUTO_RENAME_FLAG_FILE);
}

/**
 * 设置 xyz-agent runtime 开关契约 flag（/auto-rename on|off 命令调用，与 config 双写同步）。
 * enabled=true 创建空 flag 文件；enabled=false 删除（不存在时视为成功）。best-effort 不抛错。
 */
export function setAutoRenameSwitch(enabled: boolean): void {
	const flagPath = getAutoRenameFlagPath();
	if (enabled) {
		mkdirSync(dirname(flagPath), { recursive: true });
		if (!existsSync(flagPath)) {
			writeFileSync(flagPath, "", "utf-8");
		}
	} else {
		try {
			rmSync(flagPath);
		} catch (e: unknown) {
			// flag 不存在视为已关（吞 ENOENT）；其他错误（如权限）如实抛出，不静默
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw e;
		}
	}
}

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

	const thinkingLevel =
		typeof obj.thinkingLevel === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(obj.thinkingLevel)
			? (obj.thinkingLevel as ModelThinkingLevel)
			: DEFAULT_RENAME_CONFIG.thinkingLevel;

	return { enabled, model, maxTitleLength, thinkingLevel };
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

/**
 * 加载配置（mtime+size 缓存；文件缺失/损坏返回默认，不抛错）。
 *
 * enabled 的取值优先级（见上方 [COMPAT] 契约注释）：flag 文件存在 → true；否则 config.enabled。
 * flag 检查是 live 的（每次调用 existsSync），xyz-agent SystemPage 切开关立即生效。
 */
export function loadRenameConfig(): RenameSessionConfig {
	const config = loadConfig(CONFIG_PKG, DEFAULT_RENAME_CONFIG, normalizeRenameConfig);
	if (existsSync(getAutoRenameFlagPath())) {
		return { ...config, enabled: true };
	}
	return config;
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
	message?: { role?: string; stopReason?: string };
}

/**
 * 数 session 中 assistant 回复数。用于判定首 turn（===1）。
 * 判定条件：entry.type === "message" && entry.message.role === "assistant"
 * （pi 内部 session-manager.ts 同款模式）。
 *
 * 注意：触发判定已改用 countSuccessfulAssistantReplies（不看 stopReason 无法区分
 * 「iteration 结束」与「轮次结束」，见设计 D6）。本函数保留导出兼容既有调用方。
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

/**
 * 数 session 中「成功完成」的 assistant 回复数（stopReason === "stop"），触发判定用（===1 触发 rename）。
 *
 * 只数 stop 的理由（设计 D6）：pi 的 turn_end 每个 iteration 发一次，中间 iteration 的
 * stopReason 是 toolUse；error/aborted 轮的错误上下文不该用来命名（延迟到下一个成功轮）；
 * length（输出被 max token 截断）截断文本质量无保证，与 error 同等对待。
 * 无 stopReason 字段的宽松数据不计（只认显式 stop，防误触发）。
 */
export function countSuccessfulAssistantReplies(entries: ReadonlyArray<EntryLike>): number {
	let count = 0;
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			entry.message?.role === "assistant" &&
			entry.message.stopReason === "stop"
		) {
			count++;
		}
	}
	return count;
}

// ──────────────────────── 标题清洗 ────────────────────────

/**
 * rename 专属后处理：去首尾成对引号（单/双/中文）+ markdown 强调标记（* ** ` _）+ 尾部标点，按 Unicode 码点截断。
 *
 * 输入是 callLLM 已 extractText+trim 的 string（llm-shared/call.ts 的 extractText 负责从
 * AssistantMessage.content 提取 text block 拼接并 trim）。本函数只做 rename 特有的包装清理，
 * 是旧版 extractTitle（从 resp.content 提取）的收口后形态。
 */
export function cleanTitle(content: string, maxLength: number): string {
	const trimmed = content.trim();
	if (!trimmed) return "";

	// B1: 归一化内部空白——把所有连续空白（含 \n / \r / \t）压成单空格，
	// 避免 LLM 返回多行标题（如 "重构API层\n更新文档"）原样落库破坏 UI 标题/列表渲染
	const normalized = trimmed.replace(/\s+/g, " ");

	// 去首部引号/markdown 标记 + 尾部引号/markdown/标点（。．.，,、;；!！?？：:）。
	// 尾部标点是 D4 slug 风格的兜底（prompt 已约束「不要句尾标点」，LLM 漏遵从时在此清除）；
	// 只清首尾——中间标点保留（如 version 号 'v1.2.3' 中间的点）。
	const cleaned = normalized
		.replace(/^["“”'`*_]+|["“”'`*_。．.，,、;；!！?？：:]+$/g, "")
		.trim();
	if (!cleaned) return "";

	// 按 Unicode 码点截断（避免截断多字节字符）
	const chars = Array.from(cleaned);
	if (chars.length <= maxLength) return cleaned;
	return chars.slice(0, maxLength).join("");
}
