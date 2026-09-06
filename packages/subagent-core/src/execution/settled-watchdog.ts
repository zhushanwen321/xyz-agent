// src/execution/settled-watchdog.ts
//
// [T2-③ / LC-1] chatMode settled 等待两段式守护（回收层「上界族 + 无进展检测」共享原语）。
//
// 设计：docs/design/timeout-zcode-turn-and-settled-watchdog.md §6-D9 / §7（两段式重锚定，
// P0-4 核心）。等待 agent_settled 的窗口拆两段，判定语义与被保护对象逐段匹配：
//
//   中段（prompt → agent_end）：工作段，输出即进展——无进展检测
//     （armMidRoundNoProgress，锚点：prompt 发出时 arm；有效协议事件行刷新；
//     连续静默 SETTLED_MID_ROUND_NO_PROGRESS_MS=30min → kill + 该轮失败终态化）。
//     对齐 keep-alive 无进展检测先例（KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 同构：
//     「仍在推进」由 stdout 有效事件定义而非总时长，修复旧 10min 全程固定窗对
//     >10min 合法 chatMode 单轮的误杀）。
//
//   收尾段（agent_end → agent_settled）：post-run 收尾（compact 检查等）——固定硬上限
//     （armSettledWatchdog，锚点：agent_end 到达时经 handoverMidRoundToSettled 交棒；
//     事件不刷新：收尾段内的任何输出都不能证明 settled 终将到达，刷新会让
//     「wedged 但仍有周期性输出」的进程无限续命——LC-9 已证 stdout 可有调试行）。
//     定值 600s 依据 P-T2c 已执行探针（probe/p-t2c-report.md）：收尾段 6 轮真实会话
//     全部 <2ms、compact 30 万 tokens 40.1s，按探针自身降级规则 P99×10=401s<600s 成立。
//
//   两段独立计时：交棒时中段已过时间不继承——收尾段从 agent_end 起满 600s 才 fire
//   （A7 验收判据「收尾段上界只在 agent_end 后计时」）。
//
// LC-1 三 wedged 场景覆盖复核（D9）：① pi 版本偏斜无事件（agent_end 永不到达）→
// 中段 30min 静默回收；② post-run compact 卡死（agent_end 已到、settled 不来）→
// 收尾段 600s 回收；③ stdout 行损坏（settled 行被丢）→ 收尾段 600s 回收。
//
// 用户通道（规则 19）：env XYZ_SUBAGENT_SETTLED_WATCHDOG_MS——>0 覆盖收尾段定值，
// ≤0 关闭两段（关闭即回到「settled 不 arm 则 idle timer 不挂、runSpawn 已在首轮返回、
// spawn watchdog 默认关」的三无窗口，warn 明示后果），未设/非法 = 默认 600s。
// 中段阈值 v1 不开 env（减法：与 keep-alive 先例同为纯常量）。
//
// 双挂载点共用同一原语——同一组常量 + 同一组挂载/交棒/清除 helper，仅两个 prompt
// 发出点（设计 T2-③ 明示架构，两处各写一套恰是被否的「散布姿势」微缩复发）：
//   - 首轮：session-runner.ts runSpawn（prompt 发出后 arm 中段）
//   - 后续轮次热路径：subagent-service.ts deliverMessage（发出新一轮 prompt 后 arm 中段）
// 事件侧接线（两路径共用同一 stdout pump 闭包，均在 session-runner.ts）：
//   - 有效协议事件行 → refreshMidRoundNoProgress（中段刷新）
//   - agent_end（chatMode，!willRetry）→ handoverMidRoundToSettled（交棒收尾段）
//   - agent_settled / close / 收尾 → disarmSettledWatchdog（两段一并清）
//
// 与 lifecycle-manager 的 idle timer 互补：idle timer 管 settled 已到达后的空闲
// 回收，本原语管 settled 永不到达的 wedged——两条正交通道不互相替代。
//
// 实现形态对齐 armIdleTimer（recordId → entry 的模块级记账）：重复 arm 先清旧
// timer、到期回调先自删条目再执行——挂载/清除责任内聚在原语，调用方不管理句柄
// 覆盖（防「忘清旧窗」散布错误）。同一 record 任意时刻只有一段 armed（交棒清中段
// 才挂收尾段），entry 记录当前段 + 收尾段回调（交棒点无需知道挂载方是谁）。

import { getLogger } from "../core/logger.ts";
import { assertSafeTimerDelay } from "../shared/timer-delay.ts";

const logger = getLogger("subagents");

/** 时间单位换算常量（命名后供 watchdog 常量组合，对齐 session-runner 同名先例，消除裸乘法字面量）。 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** 中段无进展阈值（分钟）：对齐 KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 的 30min 量级。 */
const MID_ROUND_MINUTES = 30;

/**
 * 收尾段固定硬上限默认值（600s，值不变——锚点从 prompt 发出改挂 agent_end 之后）。
 *
 * [P-T2c 已执行探针定案] 真实 pi 会话 agent_end→agent_settled 间隔 6 轮全部 <2ms
 *（两事件行同 chunk 到达）；30 万 tokens 上下文显式 compaction 耗时 40.1s——按探针
 * 自身降级规则 P99×10 = 401s < 600s，600s 成立（probe/p-t2c-report.md）。
 * 可被 env XYZ_SUBAGENT_SETTLED_WATCHDOG_MS（>0）覆盖，仅此一处定义。
 */
export const SETTLED_WATCHDOG_TIMEOUT_MS = 600_000;

/**
 * 中段（prompt → agent_end）无进展检测的连续静默阈值（30min）。
 *
 * 对齐 KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 先例（30min 无进展检测，量级同源）。
 * 刷新面严格限定 stdout pump 解析出的**有效协议事件行**（message_* 与 tool_* 与 turn_end
 * 等 SdkEvent）——LC-9 的 invalid 行（非法 JSON / 缺 type 字段的调试噪音）不刷新，
 * 防调试输出续命。v1 不开 env（设计 §6-D9 定案：与 keep-alive 同为纯常量）。
 * [export] 测试可观测。
 */
export const SETTLED_MID_ROUND_NO_PROGRESS_MS = MID_ROUND_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * 收尾段定值的用户覆盖 env（规则 19：用户显式指定才生效）。
 *
 * >0 覆盖收尾段（SETTLED_WATCHDOG_TIMEOUT_MS 默认）；≤0 关闭两段（回到三无窗口，
 * warn 明示后果）；未设 = 默认 600s；非数字 = 非法回落默认 + warn 留痕（对齐
 * XYZ_SUBAGENT_IDLE_TIMEOUT_MS 的 LC-7 教训：非法回落必须可见）。前缀用
 * XYZ_SUBAGENT_*（ENV_WHITELIST_PREFIXES 白名单，PI_ 前缀在桌面 spawn 链被静默
 * 丢弃——同 XYZ_SUBAGENT_IDLE_TIMEOUT_MS 改名教训）。
 */
export const SETTLED_WATCHDOG_ENV = "XYZ_SUBAGENT_SETTLED_WATCHDOG_MS";

/** watchdog fire 时传给回调的段信息（失败文案按段分叉：窗长语义不同）。 */
export interface SettledWatchdogFireInfo {
  /** 触发段：mid-round = 中段无进展；settled = 收尾段固定上界。 */
  phase: "mid-round" | "settled";
  /** 本段实际等待窗长（ms）——中段为常量，收尾段为 env 覆盖后的生效值。 */
  waitedMs: number;
}

/** 单段 armed 的记账条目。同一 record 任意时刻至多一段 armed（交棒先清后挂）。 */
interface SettledWatchdogEntry {
  timer: NodeJS.Timeout;
  phase: "mid-round" | "settled";
  /** 中段回调：armMidRoundNoProgress 登记；armSettledWatchdog 直挂收尾段时无。 */
  onMidTimeout?: (info: SettledWatchdogFireInfo) => void;
  /** 收尾段回调：prompt 发出点随 armMidRoundNoProgress 登记，交棒点经此取用。 */
  onSettleTimeout: (info: SettledWatchdogFireInfo) => void;
}

/** recordId → armed watchdog entry。仅在等待窗口内 armed（挂载/清除成对）。 */
const armedEntries = new Map<string, SettledWatchdogEntry>();

// ── env 解析（惰性首读定案 + 缓存；_resetSettledWatchdogsForTest 清缓存供测试改 env）──

let envCache: { disabled: boolean; overrideMs?: number } | undefined;

function resolveSettledWatchdogEnv(): { disabled: boolean; overrideMs?: number } {
  if (envCache) return envCache;
  envCache = { disabled: false };
  const raw = process.env[SETTLED_WATCHDOG_ENV];
  if (raw === undefined || raw.trim() === "") return envCache; // 未设 = 默认 600s
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(
      `[settled-watchdog] ${SETTLED_WATCHDOG_ENV}="${raw}" is invalid (expected a millisecond number) — ` +
        `falling back to default settled phase limit (${SETTLED_WATCHDOG_TIMEOUT_MS}ms); ` +
        `set a plain ms value (e.g. 60000) to override, or 0 to disable both phases`,
    );
    return envCache;
  }
  if (parsed <= 0) {
    logger.warn(
      `[settled-watchdog] ${SETTLED_WATCHDOG_ENV}=${parsed} disables BOTH watchdog phases (mid-round ` +
        `no-progress + settled phase limit). Consequence: a wedged chatMode round (no agent_end, or ` +
        `agent_settled never arriving) has NO independent recovery timer — the process leaks until the ` +
        `host exits (the "three-no-window" shape). Recovery: unset the env or set a positive ms value.`,
    );
    envCache.disabled = true;
    return envCache;
  }
  envCache.overrideMs = parsed;
  return envCache;
}

/** 收尾段生效窗长：env >0 覆盖，否则默认 600s（文案拼接 / 单测断言用）。 */
export function getSettledWatchdogTimeoutMs(): number {
  return resolveSettledWatchdogEnv().overrideMs ?? SETTLED_WATCHDOG_TIMEOUT_MS;
}

/** 两段守护是否被 env ≤0 显式关闭（arm 时 no-op 的唯一来源）。 */
export function isSettledWatchdogDisabled(): boolean {
  return resolveSettledWatchdogEnv().disabled;
}

/**
 * 清除某 record 的 entry（settled 到达 / close / resolveRun / 终态化处置任一发生即清，
 * 两段一并清）。不存在 armed entry 时 no-op。
 */
function clearEntry(recordId: string): void {
  const entry = armedEntries.get(recordId);
  if (!entry) return;
  clearTimeout(entry.timer);
  armedEntries.delete(recordId);
}

/**
 * 挂载（或按新窗口重挂）某 record 的**中段**无进展检测（prompt 发出点调用）。
 *
 * - 重复 arm（同 recordId：新一轮 prompt）先清旧 entry——每轮窗口独立计时，不叠加
 *  （对齐 armIdleTimer 刷新语义）；旧收尾段未清的异常形态也被本覆盖清掉（新 prompt
 *   = 新等待窗）。
 * - 收尾段回调 onSettleTimeout 随 entry 记账：agent_end 交棒点
 *  （handoverMidRoundToSettled）无需知道挂载方是谁（首轮 runSpawn / 热路径
 *   deliverMessage 各传各的处置闭包）。
 * - timer unref：不阻止主进程退出（回收兜底不阻塞 shutdown，对齐 idle timer /
 *   spawn watchdog 的 unref 语义）。
 * - 到期行为由调用方注入（kill 进程 + 该轮失败终态化）——本模块不持有
 *   ChildProcess / record，与 lifecycle-manager 同构（副作用能力由调用方注入，
 *   本模块只管 timer 生命周期，可独立编译 + 单测）。
 * - env 显式关闭（≤0）时 no-op（解析时已 warn 明示后果）。
 */
export function armMidRoundNoProgress(
  recordId: string,
  handlers: {
    onMidTimeout: (info: SettledWatchdogFireInfo) => void;
    onSettleTimeout: (info: SettledWatchdogFireInfo) => void;
  },
): void {
  if (isSettledWatchdogDisabled()) return;
  clearEntry(recordId);
  // 常量恒在安全域内；入口统一校验防未来值改可配置时静默引入 1ms 溢出语义反转。
  assertSafeTimerDelay(SETTLED_MID_ROUND_NO_PROGRESS_MS, "settled watchdog (mid-round)");
  const timer = setTimeout(() => {
    armedEntries.delete(recordId);
    logger.debug(
      `[settled-watchdog] mid-round fired for ${recordId} after ${SETTLED_MID_ROUND_NO_PROGRESS_MS}ms without a valid protocol event`,
    );
    handlers.onMidTimeout({ phase: "mid-round", waitedMs: SETTLED_MID_ROUND_NO_PROGRESS_MS });
  }, SETTLED_MID_ROUND_NO_PROGRESS_MS);
  timer.unref();
  armedEntries.set(recordId, {
    timer,
    phase: "mid-round",
    onMidTimeout: handlers.onMidTimeout,
    onSettleTimeout: handlers.onSettleTimeout,
  });
}

/**
 * 挂载（或按新窗口重挂）某 record 的**收尾段**固定硬上限（锚点：agent_end 之后）。
 *
 * 生产路径经 handoverMidRoundToSettled 调用（交棒语义内聚）；导出保留供清理面
 * 测试直接挂载（disarm 消费同一 entry，与段无关）与未来独立收尾场景。
 * - 事件不刷新（收尾段语义：窗口内输出不能证明 settled 将到达——见头注释）。
 * - env >0 覆盖窗长；到期回调先自删条目再执行（onTimeout 内重新 arm 不会被误删）。
 * - env 显式关闭时 no-op。
 */
export function armSettledWatchdog(recordId: string, onTimeout: (info: SettledWatchdogFireInfo) => void): void {
  if (isSettledWatchdogDisabled()) return;
  clearEntry(recordId);
  const windowMs = getSettledWatchdogTimeoutMs();
  // env 可配置值：入口校验防越界值静默引入 1ms 溢出语义反转（非法值在 env 解析层
  // 已回落，此处是纵深防御）。
  assertSafeTimerDelay(windowMs, "settled watchdog");
  const timer = setTimeout(() => {
    armedEntries.delete(recordId);
    logger.debug(
      `[settled-watchdog] settled phase fired for ${recordId} after ${windowMs}ms without agent_settled`,
    );
    onTimeout({ phase: "settled", waitedMs: windowMs });
  }, windowMs);
  timer.unref();
  armedEntries.set(recordId, { timer, phase: "settled", onSettleTimeout: onTimeout });
}

/**
 * [D9 交棒] agent_end 到达：中段让位收尾段。
 *
 * 清中段计时（已过时间不继承），用挂载点记账的 onSettleTimeout 挂收尾段（从
 * agent_end 起独立计时）。未挂载（非 chatMode / env 关闭 / 已清）或已交棒 /
 * 已 fire 时幂等 no-op——stdout pump 对每轮 agent_end 都调本函数，幂等由
 * phase 判定保证。
 */
export function handoverMidRoundToSettled(recordId: string): void {
  const entry = armedEntries.get(recordId);
  if (!entry || entry.phase !== "mid-round") return;
  const onSettleTimeout = entry.onSettleTimeout;
  clearEntry(recordId);
  armSettledWatchdog(recordId, onSettleTimeout);
}

/**
 * [D9 中段刷新] 有效协议事件行到达：刷新中段静默计时（重挂同窗，先清旧）。
 *
 * 未挂载 / 已交棒（收尾段不刷新——刷新会让收尾段失去唯一可收敛形态，D9 被否 (b)
 * 方案的否决理由）/ 已 fire 时 no-op。刷新面由调用方限定在 stdout pump 的合法
 * SdkEvent 行（invalid 行不调用本函数）。
 */
export function refreshMidRoundNoProgress(recordId: string): void {
  const entry = armedEntries.get(recordId);
  if (!entry || entry.phase !== "mid-round") return;
  clearTimeout(entry.timer);
  assertSafeTimerDelay(SETTLED_MID_ROUND_NO_PROGRESS_MS, "settled watchdog (mid-round refresh)");
  const onMidTimeout = entry.onMidTimeout;
  const timer = setTimeout(() => {
    armedEntries.delete(recordId);
    logger.debug(
      `[settled-watchdog] mid-round fired for ${recordId} after ${SETTLED_MID_ROUND_NO_PROGRESS_MS}ms without a valid protocol event`,
    );
    onMidTimeout?.({ phase: "mid-round", waitedMs: SETTLED_MID_ROUND_NO_PROGRESS_MS });
  }, SETTLED_MID_ROUND_NO_PROGRESS_MS);
  timer.unref();
  entry.timer = timer;
}

/**
 * 查询某 record 是否有 armed watchdog entry（测试/接入期断言用；两段同账本）。
 */
export function hasSettledWatchdog(recordId: string): boolean {
  return armedEntries.has(recordId);
}

/**
 * 查询某 record 当前 armed 段（测试断言「交棒切换」用）。未挂载返回 undefined。
 */
export function getSettledWatchdogPhase(recordId: string): "mid-round" | "settled" | undefined {
  return armedEntries.get(recordId)?.phase;
}

/**
 * 清除某 record 的 armed watchdog（settled 到达 / close / resolveRun 任一发生
 * 即清，两段一并清）。不存在 armed entry 时 no-op。
 */
export function disarmSettledWatchdog(recordId: string): void {
  clearEntry(recordId);
}

/**
 * 清空全部 armed entry + env 解析缓存（测试隔离用，beforeEach 调；命名对齐
 * _resetLifecycleState 先例。清缓存使测试内 vi.stubEnv 改 env 后重新解析生效）。
 */
export function _resetSettledWatchdogsForTest(): void {
  for (const entry of armedEntries.values()) {
    clearTimeout(entry.timer);
  }
  armedEntries.clear();
  envCache = undefined;
}
