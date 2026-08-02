// src/index.ts
//
// 共享 extension logger —— 三层通道分类，按受众路由日志。
//
// 设计依据：pi 宿主层（ExtensionAPI/ExtensionContext）不提供 logger 接口。
// extension 只能裸 console（污染 TUI raw stderr）或自组 ctx.ui.notify（刷屏）+
// pi.appendEntry（持久化但用户不可见）。本模块封装这套三层通道，让 @zhushanwen/pi-*
// 各包统一调用，消除裸 console。
//
// 三层通道：
//   1. AI 实时    → tool result / block reason（pi 原生，本模块不涉及）
//   2. 事后排查   → pi.appendEntry（custom entry 不进 LLM 上下文，不显 TUI）
//   3. 开发者调试 → 文件日志（PI_EXT_DEBUG=1 时写 ~/.pi/agent/logs/，默认 no-op）
//
// notify（用户操作反馈）刻意不封装——它是 UI 决策，留给各 extension 在命令/视图层
// 直接调 ctx.ui.notify。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Pi ExtensionAPI 的最小子集——仅 appendEntry（持久化审计通道）。
 *
 * 不直接 import 完整 ExtensionAPI 类型，避免本包强耦合 pi-coding-agent 版本。
 * 各 extension 在 createLogger 时传入的 pi handle 满足此结构即可。
 */
export interface PiLike {
	/** 写一条 custom entry 进 session.jsonl（不进 LLM 上下文，不显 TUI）。 */
	appendEntry?(customType: string, data?: unknown): void;
}

/** 日志级别。debug = 开发调试；warn/error = 内部降级与失败（事后排查价值）。 */
export type LogLevel = "debug" | "warn" | "error";

/**
 * Extension logger 接口。方法名即语义——不做运行时 level filtering（pi 不支持，
 * 自建太重）。warn/error 走 appendEntry 持久化；debug 默认 no-op。
 */
export interface ExtensionLogger {
	/** 开发调试日志。默认 no-op；PI_EXT_DEBUG=1 时写文件日志。不进 appendEntry。 */
	debug(msg: string, data?: unknown): void;
	/** 内部降级/竞态/IO 失败——appendEntry 持久化，不显 TUI，不进 LLM。 */
	warn(msg: string, data?: unknown): void;
	/** 同 warn，语义更严重（关键步骤失败但仍继续）。 */
	error(msg: string, data?: unknown): void;
}

// ============================================================
// 全局 singleton registry
// ============================================================

/**
 * 进程级 pi handle（延迟注入）。
 *
 * extension 初始化分两阶段：default export 函数拿到 pi → setPiHandle 注入；
 * 之后深层代码（best-effort / error-recovery）通过 getLogger 拿到的 logger
 * 才能走 appendEntry。注入前 warn/error 降级到文件日志（不丢诊断信息）。
 */
let globalPi: PiLike | undefined;

/** 各 extension name → logger 实例的缓存（getLogger 多次调用返回同一实例）。 */
const loggerCache = new Map<string, ExtensionLogger>();

/**
 * 注入 pi handle（extension default export 函数最早期调用）。
 *
 * 多次调用安全——后调覆盖先调（session_start 可能多次触发，取最新的 pi）。
 * 注入后，已创建的 logger 实例自动生效 appendEntry（闭包读 globalPi 实时值）。
 */
export function setPiHandle(pi: PiLike | undefined): void {
	globalPi = pi;
}

/**
 * 创建具名 logger。
 *
 * @param extName  extension 名（如 "subagents"、"unified-hooks"），用作：
 *                  - appendEntry 的 customType 前缀（`<extName>:log`）
 *                  - 文件日志名（`<extName>-YYYY-MM-DD.log`）
 *                  - msg 前缀（`[<extName>]`，自动补）
 * @param pi       可选 pi handle；不传则用 setPiHandle 注入的全局 handle
 * @returns        ExtensionLogger 实例（每次返回同一引用，便于模块级 const 缓存）
 */
export function createLogger(extName: string, pi?: PiLike): ExtensionLogger {
	// 优先用传入的 pi，否则用全局注入的
	const resolvePi = (): PiLike | undefined => pi ?? globalPi;

	const logger: ExtensionLogger = {
		debug(msg: string, data?: unknown): void {
			fileLog(extName, "debug", msg, data);
		},
		warn(msg: string, data?: unknown): void {
			const piResolved = resolvePi();
			const prefixed = prefixMsg(extName, msg);
			// appendEntry 不进 LLM 上下文（session-manager.js: custom entry 不参与 context）
			try {
				piResolved?.appendEntry?.(`${extName}:log`, {
					timestamp: Date.now(),
					level: "warn",
					message: prefixed,
					data,
				});
			} catch (appendErr) {
				// appendEntry 失败（session 已 disposed 等）→ 降级文件日志（下方 fileLog 兜底），不 throw
				void appendErr;
			}
			fileLog(extName, "warn", prefixed, data);
		},
		error(msg: string, data?: unknown): void {
			const piResolved = resolvePi();
			const prefixed = prefixMsg(extName, msg);
			try {
				piResolved?.appendEntry?.(`${extName}:log`, {
					timestamp: Date.now(),
					level: "error",
					message: prefixed,
					data,
				});
			} catch (appendErr) {
				// 同 warn：appendEntry 失败降级文件日志，不 throw
				void appendErr;
			}
			fileLog(extName, "error", prefixed, data);
		},
	};
	return logger;
}

/**
 * 获取（或创建）具名 logger 的全局 singleton。
 *
 * 深层代码（拿不到 pi 的执行层，如 best-effort.ts、error-recovery.ts）
 * 用 `getLogger("subagents")` 拿全局缓存实例，无需逐层透传 pi。
 *
 * 首次调用时 pi 尚未注入 → logger 的 warn/error 降级到文件日志；
 * 后续 setPiHandle 注入后，同一 logger 实例自动生效 appendEntry
 * （闭包读 globalPi 实时值，不是创建时的快照）。
 */
export function getLogger(extName: string): ExtensionLogger {
	const existing = loggerCache.get(extName);
	if (existing) return existing;
	const logger = createLogger(extName);
	loggerCache.set(extName, logger);
	return logger;
}

// ============================================================
// 内部工具
// ============================================================

/**
 * 给 msg 补 `[extName]` 前缀（若已有则不重复补）。
 * 保持与旧 console 日志一致的视觉格式，便于从 session.jsonl 逆向搜索。
 */
function prefixMsg(extName: string, msg: string): string {
	const tag = `[${extName}]`;
	return msg.startsWith(tag) ? msg : `${tag} ${msg}`;
}

/**
 * 写文件日志到 `<agentDir>/logs/<extName>-YYYY-MM-DD.log`。
 *
 * 仅在 PI_EXT_DEBUG 环境变量为 "1" 时写入（默认 no-op，生产环境零开销）。
 * agentDir 通过 pi 的 SSOT `getAgentDir()` 推导（读
 * `PI_CODING_AGENT_DIR`/`${APP_NAME}_CODING_AGENT_DIR`，默认 `~/.pi/agent`），
 * 与其它 extension 的路径派生保持一致。
 * 写失败静默吞错（文件日志是 best-effort，不应影响主流程）。
 *
 * 线程安全：appendFileSync 保证单次写入原子性；多 worker 并发写同文件时
 * 行可能交错（可接受——debug 日志不要求严格顺序）。
 */
function fileLog(extName: string, level: LogLevel, msg: string, data?: unknown): void {
	if (process.env.PI_EXT_DEBUG !== "1") return;
	try {
		const agentDir = getAgentDir();
		const logDir = join(agentDir, "logs");
		mkdirSync(logDir, { recursive: true });
		// ISO 日期前 10 字符 = "YYYY-MM-DD"
		const ISO_DATE_PREFIX_LEN = 10;
		const today = new Date().toISOString().slice(0, ISO_DATE_PREFIX_LEN);
		const logFile = join(logDir, `${extName}-${today}.log`);
		const ts = new Date().toISOString();
		const dataStr = data !== undefined ? " " + safeStringify(data) : "";
		appendFileSync(logFile, `${ts} [${level}] ${msg}${dataStr}\n`);
	} catch (fileErr) {
		// 文件日志 best-effort：磁盘满/权限问题等不阻断主流程
		void fileErr;
	}
}

/** 安全序列化 data（循环引用/BigInt 不崩）。 */
function safeStringify(data: unknown): string {
	try {
		return JSON.stringify(data);
	} catch {
		return String(data);
	}
}
