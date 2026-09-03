// src/index.ts
//
// @zhushanwen/pi-ext-guards —— pi 运行环境守卫共享库（不是 Pi extension，零依赖纯函数，
// 无 pi SDK peerDep——供任意 @zhushanwen/pi-* 包与子代理核心消费）。
//
// 背景与设计依据：docs/design/file-lock-unification-and-reaper-sink.md §2.2 P3 / §3.2 D3。
// pi 的 extension 缓存按 cwd 失效：switch_session 时 cwd 不变则 factory 被二次调用且
// handler 累积注册——session_start handler 的真实派发语义是「每 session × factory
// 调用次数」，不是「每 session 一次」。handler 体内的跨 session 副作用操作（写非本
// session 的文件 / 注册定时器 watcher / 扫描目录 / 进程操作）因此会被双跑（2026-09-01
// reaper 双跑即此形态）。本包把这类「pi 运行环境隐式坑」的守卫集中一处，业务
// extension 引入即用，防线不再散落各包内联。

/** 一次执行的结果记录：正常返回记值、抛错记错误——两者都不释放 key。 */
type ExecutionRecord =
	| { readonly outcome: "returned"; readonly value: unknown }
	| { readonly outcome: "threw"; readonly error: unknown };

// 「按进程去重」的物理载体 = 模块级 Map。有效前提：同一进程内模块级状态跨 factory
// 二调持久——pi extension 缓存按 cwd 失效时 factory 重跑，但 jiti/Node 模块缓存同图
// 共享、模块 top-level 不重执行（handler 累积注册正是同一机制的另一面），故 Map 在
// 二调之间存活，去重成立。
const executions = new Map<string, ExecutionRecord>();

/**
 * 进程内按 key 去重地执行 fn：同一 key 至多执行一次，后续调用重放首次结果。
 *
 * 语义细节（设计 §3.2 D3 守卫粒度段 + §3.3 D3 守卫语义）：
 *
 * - **结果缓存形态（非跳过）**：首次调用执行 fn 并缓存结果；后续同 key 调用不执行
 *   fn，返回首次的返回值——原样重放：对象返回严格同一引用（toBe 级，非重新求值）；
 *   fn 返回 Promise 时重放同一实例，因此 **rejected Promise 同样被缓存**、不因
 *   rejection 释放 key。
 * - **fn 抛错不吞、key 不释放**：同步抛错原样上抛（守卫不捕获、不包装），同时记录
 *   该错误——后续同 key 调用重抛同一错误实例、不再执行 fn。验收条款「fn 抛错不阻断
 *   后续 handler」的准确语义是**守卫不吞 fn 的错误**（调用方 catch 守卫调用即可继续
 *   handler 后续逻辑，先例：base-tool-enhance runSessionStartMaintenance 的 try/catch
 *   形态），而非把 key 释放给二次执行——失败释放会让 factory 二调双跑窗口重新打开
 *   （本次事故形态），与 u-bte-guard 内联 flag 先例「reap 抛错不重置 flag」同语义。
 *   失败重试不归守卫：需要兜底的场景由宿主的其他触发面承接（该先例的失败兜底即交
 *   runtime 收殓触发面 B）。
 * - **粒度边界**：只包「跨 session 副作用操作」（进程级全局维护类，正确频率就是每
 *   进程至多一次）。session 级幂等操作（如 pending 对账——读当前 session 的 entries
 *   与 registry，appendEntry 幂等）必须保持每 session_start 执行，不要挂本守卫；需要
 *   「每 session 一次」语义的 handler 属另一设计，本包明确不提供。
 * - **key 是进程内全局命名空间**：跨包共享一个 Map，调用方须用「包名:操作名」前缀
 *   （如 "base-tool-enhance:reap"）避免撞 key。
 *
 * @param key 去重键（进程内全局，建议带包名前缀）
 * @param fn 无参函数——首次调用时求值一次，后续调用不再执行；需要上下文（pi/ctx）
 *   的调用方在闭包里捕获，被闭包捕获的是首次调用处的值（这正是「每进程至多一次」
 *   的字面语义）
 * @returns 首次执行的返回值（后续调用重放同一结果；async fn 重放同一 Promise 实例）
 */
export function oncePerProcess<T>(key: string, fn: () => T): T {
	const hit = executions.get(key);
	if (hit !== undefined) {
		if (hit.outcome === "threw") {
			throw hit.error;
		}
		// 同 key 的值由首次调用的泛型参数化记录，模块级 Map 无法按 key 参数化类型，
		// 断言仅收窄回该泛型（构造点与重放点同函数，无跨来源混装）。
		return hit.value as T;
	}
	try {
		const result = fn();
		executions.set(key, { outcome: "returned", value: result });
		return result;
	} catch (error) {
		executions.set(key, { outcome: "threw", error });
		throw error;
	}
}
