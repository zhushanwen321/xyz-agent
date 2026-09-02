// src/execution/settled-watchdog.ts
//
// [T2-③ / LC-1] chatMode settled 等待固定硬上限（回收层「上界族」共享原语）。
//
// 设计：docs/design/subagent-core-unbounded-wait-audit.md §7.2 T2-③ / §4.1 LC-1。
// chatMode 任意一轮等待 agent_settled 的窗口挂固定硬上限（默认 10 分钟）——settled
// 永不到达（事件行丢失 / 子进程 wedged）时本 timer 是唯一独立回收通道：现状
// 「settled 不 arm 则 idle timer 不挂、runSpawn 已在首轮返回、spawn watchdog 默认关」
// 的三无窗口由此收敛（LC-1 同族变体）。
//
// 固定上界（非事件刷新语义）：该窗口的正常语义是 post-run 收尾（compact 检查等，
// 秒级完成），窗口内的任何输出都不能证明 settled 终将到达——「刷新」会让「wedged
// 但仍有周期性输出」的进程无限续命（LC-9 已证 stdout 可有调试行）。固定上界
// by construction 覆盖静默与非静默两种 wedged 形态。多轮会话中每轮窗口独立计时
//（重复 arm = 以新窗口覆盖旧计时，对齐 lifecycle-manager.armIdleTimer 的刷新语义）。
//
// 双挂载点共用同一原语——同一常量 + 同一挂载/清除 helper，仅两个调用点（设计
// T2-③ 明示架构，两处各写一套恰是被否的「散布姿势」微缩复发）：
//   - 首轮：session-runner.ts runSpawn（prompt 发出后挂；settled 到达 / close /
//     resolveRun 任一发生即清）
//   - 后续轮次热路径：subagent-service.ts deliverMessage（发出新一轮 prompt 后挂，
//     u-t2b 接线）
//
// 与 lifecycle-manager 的 idle timer 互补：idle timer 管 settled 已到达后的空闲
// 回收，本上界管 settled 永不到达的 wedged——两条正交通道不互相替代。
//
// 实现形态对齐 armIdleTimer（recordId → timer 的模块级记账）：重复 arm 先清旧
// timer、到期回调先自删条目再执行——挂载/清除责任内聚在原语，调用方不管理句柄
// 覆盖（防「忘清旧窗」散布错误）。

import { getLogger } from "../core/logger.ts";
import { assertSafeTimerDelay } from "../shared/timer-delay.ts";

const logger = getLogger("subagents");

/**
 * settled 等待固定硬上限（10 分钟）。
 *
 * [P-T2c 定案] 真实 pi 会话 agent_end→agent_settled 间隔 6 轮全部 <2ms（两事件行
 * 同 chunk 到达）；30 万 tokens 上下文显式 compaction 耗时 40.1s——10min 上限余量
 * 4 个数量级以上（probe/p-t2c-report.md）。维持设计默认值，仅此一处定义。
 */
export const SETTLED_WATCHDOG_TIMEOUT_MS = 600_000;

/** recordId → armed settled watchdog timer。仅在等待窗口内 armed（挂载/清除成对）。 */
const armedTimers = new Map<string, NodeJS.Timeout>();

/**
 * 挂载（或按新窗口重挂）某 record 的 settled 等待硬上限。
 *
 * - 重复 arm（同 recordId）先 clearTimeout 旧 timer——每轮窗口独立计时，不叠加。
 * - 到期回调先从 Map 移除自身再执行 onTimeout（onTimeout 内重新 arm 不会被误删）。
 * - timer unref：不阻止主进程退出（回收兜底不阻塞 shutdown，对齐 idle timer /
 *   spawn watchdog 的 unref 语义）。
 * - 到期行为由调用方注入 onTimeout（kill 进程 + 该轮失败终态化）——本模块不持有
 *   ChildProcess / record，与 lifecycle-manager 同构（副作用能力由调用方注入，
 *   本模块只管 timer 生命周期，可独立编译 + 单测）。
 */
export function armSettledWatchdog(recordId: string, onTimeout: () => void): void {
  // 常量恒在安全域内；入口统一校验防未来值改可配置时静默引入 1ms 溢出语义反转。
  assertSafeTimerDelay(SETTLED_WATCHDOG_TIMEOUT_MS, "settled watchdog");
  // 重挂 = 新窗口：先清旧 timer，防同一 record 叠加多个 armed timer。
  disarmSettledWatchdog(recordId);
  const timer = setTimeout(() => {
    armedTimers.delete(recordId);
    logger.debug(`[settled-watchdog] fired for ${recordId} after ${SETTLED_WATCHDOG_TIMEOUT_MS}ms without agent_settled`);
    onTimeout();
  }, SETTLED_WATCHDOG_TIMEOUT_MS);
  timer.unref();
  armedTimers.set(recordId, timer);
}

/**
 * 清除某 record 的 settled 等待硬上限（settled 到达 / close / resolveRun 任一发生
 * 即清）。不存在 armed timer 时 no-op。
 */
export function disarmSettledWatchdog(recordId: string): void {
  const timer = armedTimers.get(recordId);
  if (!timer) return;
  clearTimeout(timer);
  armedTimers.delete(recordId);
}

/**
 * 查询某 record 是否有 armed settled watchdog（测试/接入期断言用）。
 */
export function hasSettledWatchdog(recordId: string): boolean {
  return armedTimers.has(recordId);
}

/**
 * 清空全部 armed timer（测试隔离用，beforeEach 调；命名对齐 _resetLifecycleState 先例）。
 */
export function _resetSettledWatchdogsForTest(): void {
  for (const timer of armedTimers.values()) {
    clearTimeout(timer);
  }
  armedTimers.clear();
}
