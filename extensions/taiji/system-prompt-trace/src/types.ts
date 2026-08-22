/**
 * 共享类型、常量与 reason 映射。
 *
 * 留痕 entry 是 custom 类型（不进 LLM context，零模型侧影响，设计 D2），
 * 数据形状见 SystemPromptTraceEntryData。
 */

/** 留痕 entry 的 customType（xyz: 前缀 = xyz-agent 自定义命名空间）。 */
export const SYSTEM_PROMPT_CUSTOM_TYPE = "xyz:system-prompt";

/** pi SessionStartEvent.reason 原生 5 值（pi 源码 core/extensions/types.ts:565）。 */
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** 落盘 reason 枚举（initial/resume/change，对齐 DSH request/header 语义，设计 D2）。 */
export type TraceReason = "initial" | "resume" | "change";

/** appendEntry("xyz:system-prompt", data) 的 data 形状（设计 §5 单元 1）。 */
export interface SystemPromptTraceEntryData {
	/** session 内单调递增（首条 1；有基线时续接基线版本 +1）。 */
	version: number;
	/** sha256(fullText) 十六进制——hash 对比去重与跨重启基线的依据。 */
	hash: string;
	reason: TraceReason;
	/** 完整 system prompt（每条 ~12KB，hash 去重后典型 session 只写 1-3 次，设计 D2 权衡）。 */
	fullText: string;
	/** fullText.length（UTF-16 码元数）。 */
	charCount: number;
	/** 与上一版的行级 diff 摘要；无 parent 全文（自持久化基线只有 hash/首条）时缺省。 */
	parentVersionDiffSummary?: string;
}

/** 跨重启恢复的 hash 基线。 */
export interface PromptBaseline {
	hash: string;
	version: number;
	/** 从 session 文件留痕 entry 直读时有值（可生成 diff 摘要）；自持久化小文件只有 hash+version。 */
	fullText?: string;
	/** 基线来源（三路径，见 trace.ts onSessionStart 的解析优先级）。 */
	source: "target-file" | "previous-session-file" | "persisted";
}

/**
 * session_before_switch → session_start 之间传递的直读基线。
 * 必须是模块级单例对象而非闭包变量：switchSession 会 teardown 并重建 extension runtime
 * （pi agent-session-runtime.ts teardownCurrent → createRuntime 重新调用 factory），
 * 闭包状态不跨 runtime 存活，只有模块缓存（extensions/loader.ts extensionCache）在进程内延续。
 */
export interface SwitchStash {
	pending: PromptBaseline | null;
}

/** 运行时类型 guard（taste/no-unsafe-cast：断言必须有运行时 guard，这里干脆不用断言）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 留痕 entry data 的运行时 guard（读 JSONL / 测试断言复用）。 */
export function isSystemPromptTraceEntryData(value: unknown): value is SystemPromptTraceEntryData {
	if (!isRecord(value)) return false;
	const version = value["version"];
	const hash = value["hash"];
	const reason = value["reason"];
	const fullText = value["fullText"];
	const charCount = value["charCount"];
	return (
		typeof version === "number" &&
		Number.isFinite(version) &&
		typeof hash === "string" &&
		(reason === "initial" || reason === "resume" || reason === "change") &&
		typeof fullText === "string" &&
		typeof charCount === "number"
	);
}

const SESSION_START_REASONS: readonly SessionStartReason[] = [
	"startup",
	"reload",
	"new",
	"resume",
	"fork",
];

/** 事件侧 reason 归一化：untyped extension 传入非 5 值时按 startup 处理（最保守：无基线则 initial）。 */
export function normalizeSessionStartReason(raw: string): SessionStartReason {
	return SESSION_START_REASONS.find((r) => r === raw) ?? "startup";
}

/**
 * 无基线时 SessionStartEvent.reason → 落盘 reason 的映射（A11）。
 *
 * - startup / new → initial（新 session 首建快照）
 * - resume → resume（重开快照）
 * - fork / reload → resume【暂定，待 P2 实测定（A13 探针），测试显式标注】：
 *   fork 的新文件携带源 session 的历史 entry（版本链延续，且 xyz-agent 的 fork 实际经
 *   switchSession 走 resume 链路），reload 是同 session 的 extension 运行时重建——
 *   两者语义上都更接近「重开」而非「首建」。
 *
 * 注意：只要恢复了任一 hash 基线，首个 turn 一律写 resume（见 trace.ts），不走本映射。
 */
export function mapReasonForFirstWrite(reason: SessionStartReason): TraceReason {
	switch (reason) {
		case "startup":
		case "new":
			return "initial";
		case "resume":
		case "fork":
		case "reload":
			return "resume";
	}
}
