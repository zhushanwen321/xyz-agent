/**
 * Pending Notifications State — 数据模型和纯函数。
 *
 * 职责：
 * - PendingEntry: 一个异步操作的完整描述（与 pending:register entry data 对齐）
 * - PendingRegistry: 内存中的活跃操作注册表（Map<id, PendingEntry>）
 * - register/unregister: 运行时事件驱动的状态变更
 * - rebuildFromEntries: session_start 从持久化 entries 重建 registry + 识别需要补注销的 expired/跨 session 残留
 *
 * 设计要点：
 * - 纯函数，不依赖 Pi 运行时（ExtensionAPI/appendEntry），可独立单元测试
 * - 所有时间戳由调用方传入（now），便于测试
 * - rebuildFromEntries 返回 activeIds + expiredToFlush（需要 index.ts 补 appendEntry 的列表），
 *   不直接写 entry —— 写 entry 是副作用，由 index.ts 负责
 */

/** 异步操作类型（来源：workflow / subagent / bash 后台任务） */
export type PendingType = "workflow" | "subagent" | "bash";

/**
 * 生命周期分档（D16）：type 级声明，行为按档判定（不做 type 特判）——
 * 未来 scheduler 等长任务类型声明 process 档即零改动获得同语义。
 * - "session"：随 session entry 存活——TTL 过期（U3）、跨 session 清理（U4）、
 *   shutdown 标 cancelled 全套生效。
 * - "process"：随进程存活——无 TTL（不计算/不回填 expiresAt）、跨 session 续存
 *   （fork/switch 后任务仍在跑）、shutdown 不标 cancelled（收尾归任务自身/reaper）。
 *
 * [W4 翻档 · 设计 chat-domain-v1x-liveness-governance D4 分档对齐] subagent/workflow
 * 从 session 档翻 process 档：后台子代理与 workflow run 的真实生命周期跨 session 存活、
 * 可跑超 1h——session 档的 1h TTL（U3）与跨 session 补注销（U4）会把长任务/重启后的
 * 注册静默清除，goal 守卫随之失明（2026-09-08 事故环 4 的放大器）。翻档后守卫依赖的
 * 收口链 = 注销合法发射点枚举（5 处，含 core 注册对账 sweep）+ idle-gc startedAt 锚
 * 兜底归档（只归档不补注销，注销统一交 sweep）。
 *
 * [W4 session 档机器死代码处置] 翻档后三类型全 process 档——PENDING_TTL_MS / U3 / U4 /
 * U11 全体暂无消费类型。机制本体保留（registry 通用能力，session 档暂无消费类型，
 * 留存待未来类型），**勿误认清理仍在工作**：本文件不再有任何类型的 TTL 清理或跨
 * session 注销在运行。
 */
export const PENDING_LIFECYCLE: Record<PendingType, "session" | "process"> = {
	subagent: "process",
	workflow: "process",
	bash: "process",
};

/** 异步操作终态/过渡状态。active = 仍在运行；其他都视为已结束 */
export type PendingStatus = "active" | "completed" | "failed" | "cancelled" | "expired" | "time_limited" | "aborted";

/** 一个异步操作的完整描述（= pending:register entry 的 data 字段） */
export interface PendingEntry {
	/** 操作唯一标识（workflow runId / subagent id / bash 后台任务 id） */
	id: string;
	/** 操作来源类型 */
	type: PendingType;
	/** 可读名称（workflow name / subagent name） */
	name: string;
	/** 注册时状态（恒为 active，由 register 设置） */
	status: PendingStatus;
	/** 注册时间戳 ms */
	registeredAt: number;
	/** 过期时间戳 ms（registeredAt + TTL）；process 档恒 undefined（D16：进程级生命周期无 TTL） */
	expiresAt: number | undefined;
	/** 注册时的 sessionId（用于跨 session 残留检测） */
	sessionId: string;
}

/** pending:register entry 在 entries 里的最小可识别形状 */
interface RegisterEntryData {
	id: unknown;
	type: unknown;
	name: unknown;
	registeredAt: unknown;
	expiresAt: unknown;
	sessionId: unknown;
}

/** pending:unregister entry 在 entries 里的最小可识别形状。
 *  T2 通知由 subagent-workflow 自有通道 bg-notify-render 承担，不经本事件。 */
interface UnregisterEntryData {
	id: unknown;
}

/** SessionEntry 的最小可识别形状（duck-typed，避免依赖 SDK 具体类型） */
interface EntryLike {
	customType?: string;
	data?: unknown;
}

/**
 * pending:register entry 的 TTL（1 小时）。
 *
 * [W4 死代码登记] 翻档后三类型全 process 档，本常量仅剩 session 档机器的兼容读侧
 * 回填路径（normalizeRegisterEntry 对 session 档缺失 expiresAt 的旧 entry 回填）——
 * 现无任何类型声明 session 档，回填分支不可达。留存待未来 session 档类型，勿删。
 */
export const PENDING_TTL_MS = 3_600_000;

/** 注册表：内存中的活跃操作（session 隔离，由 index.ts 在闭包内持有） */
export interface PendingRegistry {
	/** 所有已注册操作（含已注销的，便于去重判断） */
	operations: Map<string, PendingEntry>;
}

/** 创建空注册表 */
export function createRegistry(): PendingRegistry {
	return { operations: new Map() };
}

/**
 * 注册操作。已存在（任何 status）的同 id 操作被忽略（U6 重复注册）。
 * 返回是否实际新增（true = 新注册，false = 被忽略）。
 */
export function register(registry: PendingRegistry, entry: PendingEntry): boolean {
	if (registry.operations.has(entry.id)) {
		return false;
	}
	registry.operations.set(entry.id, entry);
	return true;
}

/**
 * 注销操作。不存在则忽略不报错（U8）。
 * 返回是否实际变更（true = 注销了 active 操作，false = 不存在或已注销）。
 */
export function unregister(registry: PendingRegistry, id: string, status: PendingStatus): boolean {
	const op = registry.operations.get(id);
	if (!op || op.status !== "active") {
		return false;
	}
	op.status = status;
	return true;
}

/** 返回当前所有 active 操作（按注册顺序） */
export function getActive(registry: PendingRegistry): PendingEntry[] {
	return Array.from(registry.operations.values()).filter((op) => op.status === "active");
}

/** countActiveFromEntries 的过滤选项。 */
export interface CountActiveOptions {
	/** 只统计指定类型的活跃 pending；缺省 = 全部类型（subagent + workflow + bash） */
	types?: PendingType[];
	/**
	 * [W4 读侧过滤①] 当前 session id（跨 session 残留过滤基准）：传入时按
	 * 「register entry 的 sessionId ≠ 当前 session → 跳过」过滤——fork 继承的
	 * 父级注册残留（翻 process 档后不再被 U4 补注销中性化，永久留存于子 session
	 * 文件）不进差集计数，守卫不幻 defer。
	 * 缺省（undefined）= 不过滤（向后兼容：既有调用方零改动行为不变）。
	 * entry 缺 sessionId 字段的旧形态条目视为本 session（归一化兜底语义与
	 * normalizeRegisterEntry 一致），不过滤。
	 */
	currentSessionId?: string;
}

/** countActiveFromEntries 的结果。 */
export interface CountActiveResult {
	count: number;
	ids: string[];
	/** 活跃的完整 entry（含类型/名称/TTL，供调用方展示或后续判断） */
	entries: PendingEntry[];
}

/**
 * 从持久化 entries 计算活跃 pending 数（register − unregister 差集）。
 *
 * 与 rebuildFromEntries 的分工：本函数只做「有没有活跃 pending」的只读判断，
 * 不写 registry、不判 expiresAt（TTL 刻意不校验——长任务 subagent >1h
 * 仍应视为活跃，对齐 goal agent-end 的 continuation 守卫语义）。
 * 调用方：goal（agent_end 时判断是否发 continuation）、subagent-workflow
 * （agent_end 时判断子进程是否有活跃后代，决定是否保持进程等 steer 唤醒）。
 *
 * [W4 读侧过滤①] 跨 session 残留的过滤职责已从「index.ts 的 session_start 重建
 * 流程补 unregister(expired) 抵消」（session 档 U4 机制，翻档后对 process 档不再
 * 触发）移交给本函数的 opts.currentSessionId 口——调用方持有当前 session 概念的
 * 应传入，使 fork 继承的父级注册残留不进差集（守卫不幻 defer）。
 */
export function countActiveFromEntries(
	entries: unknown[],
	opts?: CountActiveOptions,
): CountActiveResult {
	// 与 rebuildFromEntries 共用单趟扫描（S-10 守卫一致），分流 register/unregister
	const { registerEntries, unregisteredIds } = scanPendingEntries(entries);
	const active = filterActiveRegisters(registerEntries, unregisteredIds, opts);

	return {
		count: active.length,
		ids: active.map((e) => e.id),
		entries: active,
	};
}

/** 差集过滤：跳过 id 非法 / 已注销 / 重复 register / 跨 session 残留的 entry，按 opts.types 过滤类型。 */
function filterActiveRegisters(
	registerEntries: Array<{ data: RegisterEntryData }>,
	unregisteredIds: Set<string>,
	opts?: CountActiveOptions,
): PendingEntry[] {
	const active: PendingEntry[] = [];
	const seen = new Set<string>();
	for (const { data } of registerEntries) {
		if (typeof data.id !== "string" || unregisteredIds.has(data.id) || seen.has(data.id)) continue;
		seen.add(data.id);
		const entry = normalizeRegisterEntry(data, "");
		if (opts?.types && !opts.types.includes(entry.type)) continue;
		// [W4 读侧过滤①] 跨 session 残留跳过（基准 = opts.currentSessionId）。判据读
		// 原始 data.sessionId 而非归一化值：entry 缺 sessionId 的旧形态条目（归一化
		// 兜底为 ""）视为本 session——不过滤，与 normalizeRegisterEntry 的容错语义
		// 对齐（守卫漏计的危害方向是幻 defer，宁放行不误杀活跃计数）。
		if (
			opts?.currentSessionId !== undefined &&
			typeof data.sessionId === "string" &&
			data.sessionId !== opts.currentSessionId
		) {
			continue;
		}
		active.push(entry);
	}
	return active;
}

/** rebuildFromEntries 的结果：重建后的活跃列表 + 需要补注销的 entry */
export interface RebuildResult {
	/** 重建后识别为 active 的 id 列表（已写入 registry） */
	activeIds: string[];
	/** 需要补 pending:unregister entry 的操作（expired/跨 session 残留） */
	expiredToFlush: Array<{ id: string; status: PendingStatus }>;
}

/**
 * 从持久化 entries 重建 registry（session_start 时调用）。
 *
 * 算法（对齐 goal before-agent-start.ts 的读取契约）：
 * 1. 收集所有 pending:register entry，按 id 算差集（减去 pending:unregister 的 id）
 *    前提：id 全局唯一（workflow runId=`wf-<ts>-<rand>`、subagent id=`bg-/run-<tag>-<seq>-<ts>`、
 *    bash 后台任务 id=`bt-<ts>-<rand>`）。
 *    若未来 id 复用（register→unregister→register 同 id），全局 Set 差集会误跳第二次 register。
 * 2. 对每个活跃的 register entry 检查：
 *    - sessionId 不符当前 session → expired（U4 跨 session 残留）
 *    - expiresAt <= now → expired（U3 过期）
 * 3. 仍活跃的写入 registry，expired 的进入 expiredToFlush（由 index.ts 补 appendEntry）
 *
 * 注意：本函数只重建 registry + 计算需补的 entry，不写 entry（副作用归 index.ts）。
 */
/** rebuildFromEntries 的扫描阶段结果：register 原始 data 列表 + 已注销 id 集合 */
interface PendingEntryScan {
	registerEntries: Array<{ data: RegisterEntryData }>;
	unregisteredIds: Set<string>;
}

/** 单趟扫描 entries 按 customType 分流（pending:register / pending:unregister）。 */
function scanPendingEntries(entries: unknown[]): PendingEntryScan {
	const scan: PendingEntryScan = { registerEntries: [], unregisteredIds: new Set() };

	for (const raw of entries as EntryLike[]) {
		// S-10：同 countActiveFromEntries——null/undefined 元素先守卫再访问字段。
		if (!raw || typeof raw !== "object") continue;
		if (raw.customType === "pending:register") {
			scan.registerEntries.push({ data: (raw.data ?? {}) as RegisterEntryData });
		} else if (raw.customType === "pending:unregister") {
			const data = (raw.data ?? {}) as UnregisterEntryData;
			if (typeof data.id === "string") {
				scan.unregisteredIds.add(data.id);
			}
		}
	}

	return scan;
}

/**
 * 判定单个 register entry 重建时是否应标 expired：
 * - 跨 session 残留（U4）→ expired
 * - TTL 过期（U3）→ expired
 *
 * process 档两检全跳过（D16：进程级生命周期跨 session 续存且无 TTL）。
 *
 * [W4 翻档语义核对登记] 翻档后三类型全 process 档，本函数对现存类型恒 false——
 * U3/U4 清理对翻档类型不再触发，这是翻档的**预期语义**而非缺陷：process 档的
 * 生命周期本就跨 shutdown/fork 存活，跨 session 检测（U4）的职能已移交读侧过滤
 * （countActiveFromEntries 的 currentSessionId 口 + rebuildFromEntries 的
 * currentSessionId 入 registry 过滤），清理职能移交注销发射点枚举 + core 注册对账
 * sweep（判据 = record 终态 ∪ 已归档/不存在；覆盖 subagent/workflow——bash 无
 * record/store 可查，死亡窗口丢失无补发通道，见 normalizePendingType 注的显式
 * 边界登记）。本函数与 PENDING_TTL_MS 同为
 * session 档机器留存件，待未来 session 档类型，勿误删。
 */
function isExpiredEntry(entry: PendingEntry, currentSessionId: string, now: number): boolean {
	// 跨 session 残留（U4）——process 档跳过（D16：进程级生命周期跨 session 续存，
	// fork/switch 后任务仍在跑；标 expired 补 unregister 会让差集消费方误判「无活跃任务」）
	if (PENDING_LIFECYCLE[entry.type] === "session" && entry.sessionId !== currentSessionId) {
		return true;
	}
	// 过期（U3）——process 档跳过（D16：无 TTL，expiresAt 恒 undefined）；
	// session 档理论上恒有值，防御 undefined 不过期（缺失 = 该条目不过期）
	return (
		PENDING_LIFECYCLE[entry.type] === "session" &&
		entry.expiresAt !== undefined &&
		entry.expiresAt <= now
	);
}

export function rebuildFromEntries(
	registry: PendingRegistry,
	entries: unknown[],
	currentSessionId: string,
	now: number,
): RebuildResult {
	const { registerEntries, unregisteredIds } = scanPendingEntries(entries);

	const activeIds: string[] = [];
	const expiredToFlush: Array<{ id: string; status: PendingStatus }> = [];

	for (const { data } of registerEntries) {
		if (typeof data.id !== "string") continue;
		if (unregisteredIds.has(data.id)) continue;

		// [W4 读侧过滤③ rebuild 半口] 跨 session 残留不入 registry（翻 process 档后
		// U4 补注销对现存类型不再触发，fork 继承的父级注册残留若不过滤会永久虚报
		// pending_notifications 工具投影）。与 U4 的差异：**跳过不补注销**——残留
		// entry 留在 session 文件（读侧过滤③①口各自兜住差集消费方），落盘收口归
		// core 注册对账 sweep（判据含 record 查不到 → 视同终态补注销）。判据读原始
		// data.sessionId（缺 sessionId 的旧形态条目视为本 session，不过滤——宁放行
		// 不误逐）。
		if (
			typeof data.sessionId === "string" &&
			data.sessionId !== currentSessionId
		) {
			continue;
		}

		const entry = normalizeRegisterEntry(data, currentSessionId);
		if (isExpiredEntry(entry, currentSessionId, now)) {
			expiredToFlush.push({ id: entry.id, status: "expired" });
			continue;
		}
		// 仍活跃
		registry.operations.set(entry.id, entry);
		activeIds.push(entry.id);
	}

	return { activeIds, expiredToFlush };
}

/**
 * type 归一化：subagent/bash 原样保留，其余（含缺失/未知值）归 workflow。
 * state.ts 与 index.ts 两处归一化共用本函数，防止「写入侧直通、读取侧归并」漂移。
 *
 * [W4 偏好显式化] 缺失/未知 type 默认归 workflow = process 档 = 永不 TTL 清理。
 * 该偏好是刻意选择：畸形条目**宁挂账不失明**——误归 session 档会让未知类型被
 * 1h TTL / 跨 session 清理静默抹掉（守卫失明方向）。挂账的收口通道按类型分流
 * [F2 如实口径]：workflow / 畸形条目由 core 注册对账 sweep 收口（查 WorkflowRun
 * store：终态 ∪ state 文件不存在 → 补注销）；bash 无 record/store 可查——bash
 * 注册随进程退出注销，进程死亡窗口的丢失无补发通道，属显式边界（impl-plan §5
 * 偏差登记：每孤儿 bash 注册 1 条静态虚报，无空转驱动源，熔断限损）。
 */
export function normalizePendingType(raw: unknown): PendingType {
	if (raw === "subagent") return "subagent";
	if (raw === "bash") return "bash";
	return "workflow";
}

/** 从 entry data 归一化为 PendingEntry（补默认值，容错缺失字段） */
function normalizeRegisterEntry(data: RegisterEntryData, currentSessionId: string): PendingEntry {
	const registeredAt = typeof data.registeredAt === "number" ? data.registeredAt : Date.now();
	const type = normalizePendingType(data.type);
	return {
		id: data.id as string,
		type,
		name: typeof data.name === "string" ? data.name : (data.id as string),
		status: "active",
		registeredAt,
		// D16：process 档不回填 TTL——写入侧本就省略 expiresAt，读取侧若回填
		// registeredAt + TTL 会抵消写入侧的豁免（分档必须两侧同改）。session 档
		// 缺失时回填 TTL 兼容旧 entry。
		expiresAt:
			PENDING_LIFECYCLE[type] === "process"
				? undefined
				: typeof data.expiresAt === "number"
					? data.expiresAt
					: registeredAt + PENDING_TTL_MS,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : currentSessionId,
	};
}
