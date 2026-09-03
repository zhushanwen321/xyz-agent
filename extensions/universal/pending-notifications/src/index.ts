/**
 * Pending Notifications Extension — 跨 extension 的异步操作注册/查询机制。
 *
 * 设计定位：为长耗时异步操作（workflow/subagent/bash 后台任务）提供跨 extension 的
 * 活跃操作注册/查询机制。workflow/subagent/bash 运行时通过 EventBus（pi.events.emit）
 * 广播 register/unregister，本扩展监听这些事件、将状态写入 session entries（pi.appendEntry），
 * 供 LLM 通过 pending_notifications 工具主动查询当前活跃异步操作
 * （goal 不在 before_agent_start 注入等待消息——避免双信息源，pending 感知由 LLM 自行查询）。
 *
 * 文件职责：
 * - state.ts:    PendingEntry / PendingRegistry + 纯函数（register/unregister/rebuild）
 * - index.ts（本文件）: 工厂入口（注册 events.on 监听 + session 生命周期 + 查询 tool）
 *
 * 事件契约（emit 端在 packages/subagent-core：orchestration/lifecycle.ts 与
 * execution/subagent-service.ts）：
 * - emit("pending:register", { id, type, name })
 * - emit("pending:unregister", { id, reason })
 *
 * entry 契约（与 goal before-agent-start.ts 对齐，读取端按 e.data.id 算差集）：
 * - pending:register → { id, type, name, registeredAt, expiresAt?, sessionId }
 *   （expiresAt 仅 session 档写入；process 档（D16）省略该字段）
 * - pending:unregister → { id, reason, status }
 *   （主路径为事件监听写入的三字段；session_start 补 expired / session_shutdown 补
 *   cancelled 的 flush 路径只写 { id, status }，省略 reason——消费方只读 id，无行为影响）
 *
 * 监听方式：pi.events.on（Pi 的 EventBus，真实 SDK 为 EventBus.on，非 optional）。
 * workflow 侧通过 deps.eventBus 注入 pi.events（同一总线）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { Type } from "typebox";

import {
	createRegistry,
	getActive,
	PENDING_LIFECYCLE,
	PENDING_TTL_MS,
	type PendingEntry,
	type PendingRegistry,
	type PendingStatus,
	type PendingType,
	normalizePendingType,
	rebuildFromEntries,
	register,
	unregister,
} from "./state.ts";

// 跨扩展消费 API：goal（continuation 守卫）/ subagent-workflow（agent_end 后代判定）
// 直接 import 本包的导出，避免各自复制差集逻辑。PENDING_LIFECYCLE 供消费方（如
// base-tool-enhance 启动时的 peer 版本检查）读取分档声明。
export {
	countActiveFromEntries,
	createRegistry,
	getActive,
	PENDING_LIFECYCLE,
	PENDING_TTL_MS,
	type CountActiveOptions,
	type CountActiveResult,
	type PendingEntry,
	type PendingRegistry,
	type PendingStatus,
	type PendingType,
	rebuildFromEntries,
	register,
	unregister,
} from "./state.ts";

const logger = getLogger("pending-notifications");

/** 工具参数 schema */
const PendingNotificationsParams = Type.Object({
	action: Type.Union([
		Type.Literal("count"),
		Type.Literal("list"),
	]),
});

/** pending_notifications 工具的 details 形状。两个分支共用同一结构（items 缺省时 undefined），
 *  让 registerTool 泛型对 TDetails 推断一致，避免 union 细节冲突。 */
interface PendingToolDetails {
	action: string;
	count: number;
	items?: PendingEntry[];
}

/**
 * 模块级 EventBus 监听器 unsubscribe 函数列表。
 *
 * [W4 注释修正] 原 rationale（"EventBus 进程级单例 + reload 累积 N 组监听器"）在
 * pi 0.84.1 不成立：pi.events.on 的返回值是 runtime.trackEventBusSubscription 跟踪的
 * unsubscribe（loader.js:338-341），runtime.invalidate() 时自动全部退订——session 替换
 * （dispose）与 /reload（invalidate 先于重新 load）都触发；且 session 替换会创建全新
 * ResourceLoader → 全新 eventBus（agent-session-services.js:63-68），旧 bus 整体废弃。
 *
 * 下方的工厂入口手工清理因此是双重冗余（无害）：pi 已自动清理 tracked 订阅。
 * 保留是防御性兜底（不依赖 pi 内部清理时机，卸载幂等）。
 */
let unsubscribers: Array<() => void> = [];

/** 扩展入口 */
export default function pendingNotificationsExtension(pi: ExtensionAPI): void {
	// ── 清理上一轮 reload 的 EventBus 监听器（H2 防泄漏） ─────
	for (const unsub of unsubscribers) {
		try {
			unsub();
		} catch (err) {
			// unsubscribe 失败不阻断初始化（监听器可能已被 EventBus 内部清理）
			logger.debug("unsubscribe failed during cleanup", { error: String(err) });
		}
	}
	unsubscribers = [];

	// ── 闭包内状态（session 隔离，每个 session_start 重建） ─────
	let registry: PendingRegistry = createRegistry();
	let currentSessionId: string = "";

	// 安全写入 session entry：忽略 stale context 等不可恢复错误（如 subagent 子进程
	// session replacement 后 listener 仍触发）。返回是否成功。
	function safeAppendEntry(customType: string, data: unknown): boolean {
		try {
			pi.appendEntry(customType, data);
			return true;
		} catch {
			// stale context 或 session 已关闭时，静默丢弃。entry 不是关键业务数据，
			// 丢失不会破坏主流程。
			return false;
		}
	}

	// debug 日志：环境变量 XYZ_AGENT_DEBUG=1 时经共享 logger 写文件日志（默认 no-op）。
	// 不再写入 session entry（pending:log）——session entries 是 append-only 无法 GC，
	// 12 处 debug 日志会让长 session 的 entries 线性膨胀，而 goal before-agent-start
	// 每 turn 全量扫描 getEntries()。状态数据（pending:register/unregister）仍写 entry。
	const debugEnabled = process.env.XYZ_AGENT_DEBUG === "1";
	function debugLog(level: string, message: string, data?: unknown): void {
		if (!debugEnabled) return;
		logger.debug(`${level}: ${message}`, data ?? "");
	}

	// ── EventBus 监听：pending:register ─────────────────────
	unsubscribers.push(pi.events.on("pending:register", (data: unknown) => {
		debugLog("debug", "listener: pending:register received", data);
		const parsed = parseRegisterEvent(data);
		if (!parsed) {
			debugLog("warn", "listener: pending:register parse failed", data);
			return;
		}

		debugLog("debug", "listener: pending:register parsed", parsed);

		const now = Date.now();
		// D16 分档：process 档（bash 后台任务）不计算 expiresAt——进程级生命周期
		// 无 TTL 概念，任务寿命由其自身超时/reaper 管理，session 档保持 TTL 不变。
		const entry: PendingEntry = {
			id: parsed.id,
			type: parsed.type,
			name: parsed.name,
			status: "active",
			registeredAt: now,
			expiresAt: PENDING_LIFECYCLE[parsed.type] === "session" ? now + PENDING_TTL_MS : undefined,
			sessionId: currentSessionId,
		};

		// 重复注册忽略（U6）
		const added = register(registry, entry);
		if (!added) {
			debugLog("debug", "listener: pending:register ignored (duplicate)", { id: parsed.id });
			return;
		}

		// 落盘与内存 entry 对称：process 档省略 expiresAt 字段（而非写 undefined），
		// 读取侧 normalizeRegisterEntry 对 process 档同样不回填，两侧共同兑现 TTL 豁免。
		safeAppendEntry("pending:register", {
			id: entry.id,
			type: entry.type,
			name: entry.name,
			registeredAt: entry.registeredAt,
			...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
			sessionId: entry.sessionId,
		});

		debugLog("debug", "listener: pending:register appended", { id: parsed.id });
	}));

	// ── EventBus 监听：pending:unregister ───────────────────
	unsubscribers.push(pi.events.on("pending:unregister", (data: unknown) => {
		debugLog("debug", "listener: pending:unregister received", data);
		const parsed = parseUnregisterEvent(data);
		if (!parsed) {
			debugLog("warn", "listener: pending:unregister parse failed", data);
			return;
		}

		debugLog("debug", "listener: pending:unregister parsed", parsed);

		const status = mapReasonToStatus(parsed.reason);
		const changed = unregister(registry, parsed.id, status);
		if (!changed) {
			debugLog("debug", "listener: pending:unregister ignored (unknown id)", { id: parsed.id });
			return;
		}

		safeAppendEntry("pending:unregister", {
			id: parsed.id,
			reason: parsed.reason,
			status,
		});

		debugLog("debug", "listener: pending:unregister appended", { id: parsed.id });
	}));

	// ── session_start：从持久化 entries 重建 registry ────────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		registry = createRegistry();
		currentSessionId = ctx.sessionManager.getSessionId();

		const entries = ctx.sessionManager.getEntries();
		const now = Date.now();
		const { expiredToFlush } = rebuildFromEntries(registry, entries, currentSessionId, now);

		debugLog("debug", "session_start: registry rebuilt", {
			sessionId: currentSessionId,
			totalEntries: entries.length,
			activeAfterRebuild: getActive(registry).length,
			expiredToFlush: expiredToFlush.length,
		});

		// 补 expired/跨 session 残留的 unregister entry（U3/U4）
		for (const item of expiredToFlush) {
			safeAppendEntry("pending:unregister", {
				id: item.id,
				status: item.status,
			});
		}
	});

	// ── session_shutdown：所有 active → cancelled + 补 entry（U11） ──
	pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => {
		const active = getActive(registry);
		for (const op of active) {
			// D16 分档：process 档跳过 cancelled 标注——进程级生命周期的任务跨
			// session 替换继续运行（fork/switch），收尾归任务自身/reaper，
			// 不由 session 退出裁定。
			if (PENDING_LIFECYCLE[op.type] === "process") continue;
			const changed = unregister(registry, op.id, "cancelled");
			if (changed) {
				safeAppendEntry("pending:unregister", {
					id: op.id,
					status: "cancelled",
				});
			}
		}
	});

	// ── 查询 tool ─────────────────────────────────────────
	pi.registerTool({
		name: "pending_notifications",
		label: "Pending Notifications",
		description:
			"查询当前活跃的异步操作（workflow/subagent/bash 后台任务）。action=count 返回数量；action=list 返回列表。状态由 EventBus + session entries 维护，无需手动注册。",
		parameters: PendingNotificationsParams,
		execute: async (_toolCallId: string, params: { action: "count" | "list" }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext): Promise<{ content: { type: "text"; text: string }[]; details: PendingToolDetails }> => {
			const active = getActive(registry);

			debugLog("debug", `tool ${params.action} requested`, { action: params.action, activeCount: active.length });

			if (params.action === "count") {
				return {
					content: [{ type: "text" as const, text: `${active.length} pending operation(s)` }],
					details: { action: "count", count: active.length },
				};
			}

			// action === "list"
			return {
				content: [{ type: "text" as const, text: formatList(active) }],
				details: { action: "list", count: active.length, items: active },
			};
		},
	});
}

// ── 事件解析 helper ─────────────────────────────────

interface ParsedRegister {
	id: string;
	type: PendingType;
	name: string;
}

/** 解析 pending:register 事件 data（容错缺失/类型错误字段） */
function parseRegisterEvent(data: unknown): ParsedRegister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		// D16：bash 类型直通（归一化映射与 state.ts 读取侧共用同一函数，防两侧漂移）
		type: normalizePendingType(d.type),
		name: typeof d.name === "string" ? d.name : d.id,
	};
}

interface ParsedUnregister {
	id: string;
	reason: string;
}

/** 解析 pending:unregister 事件 data（容错缺失/类型错误字段）。
 *  T2 通知由 subagent-workflow 自有通道 bg-notify-render 承担，不经本事件。 */
function parseUnregisterEvent(data: unknown): ParsedUnregister | null {
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string") return null;
	return {
		id: d.id,
		reason: typeof d.reason === "string" ? d.reason : "completed",
	};
}

/** 将事件 reason 映射为内部 PendingStatus */
function mapReasonToStatus(reason: string): PendingStatus {
	switch (reason) {
		case "completed": return "completed";
		case "failed": return "failed";
		case "cancelled": return "cancelled";
		case "expired": return "expired";
		case "time_limited": return "time_limited";
		case "budget_limited": return "failed";
		case "aborted": return "aborted";
		default: return "completed";
	}
}

/** 格式化 active 列表为可读文本 */
function formatList(active: PendingEntry[]): string {
	if (active.length === 0) return "No pending operations";
	const lines = active.map((op) => `- [${op.type}] ${op.name} (id=${op.id})`);
	return `${active.length} pending operation(s):\n${lines.join("\n")}`;
}
