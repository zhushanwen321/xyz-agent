// src/execution/lifecycle-manager.ts
//
// Subagent 持续对话 V2 — 进程生命周期管理（§5.2 模块 1）。
//
// 本模块是 subagent 进程生命周期管理器，以**模块级单例**持有全局进程
// 状态（per-record idle timer、activate 串行化锁）。它**不直接持有
// ChildProcess 句柄**——句柄在 engine/host/spawned-children.ts——因此
// 所有「副作用」能力（kill / 探活 / 超时回调）都由调用方经回调/参数注入，本模块
// 只管状态记账 + 调度顺序。这让模块可独立编译 + 单测，无需拉起真实子进程。
//
// 两项职责（V2 §5.2 五项职责经 L2 死代码清扫后的存留——原职责 2 全局 ceiling /
// 职责 3 shutdown 收割 / 职责 4 孤儿扫描自落地起无生产接线，骨架与单测已随清扫
// 删除；未来需要时按 docs/design/v2-defense-ii-iii-resolution.md 重新设计）：
//   1. idle timer —— agent_settled arm / 新 turn disarm / 超时触发 onTimeout（决策 4）
//      【已接线：subagent-service.ts chat 域 arm/disarm】
//   5. activate 互斥 —— 同 recordId 的并发 activate 串行化（决策 7 防线 iii，防双写者）
//      【保留但当前无生产调用方：历史接线点（冷路径 resume 前）已随协议化重构消失，
//      30s 超时兜底与 tail-identity 自清机制完整，恢复接线即用】
//
// 本模块不 import subagent-service 等 execution 编排层，避免循环依赖。
//
// 设计参考：setTimeout→SIGTERM 骨架（复用 timer 形态）；模块级单例 Map 记账模式。

import { getLogger } from "../core/logger.ts";
import { assertSafeTimerDelay } from "../shared/timer-delay.ts";

// core/logger 无本地状态依赖（不 import execution/orchestration 层），与本模块
// 「可独立编译 + 单测」约束兼容；不 import session-runner / subagent-service（循环依赖）。
const logger = getLogger("subagents");

// ============================================================
// 默认常量
// ============================================================

/** 毫秒/秒（时间换算常数）。 */
const MS_PER_SECOND = 1000;
/** 秒/分钟（时间换算常数）。 */
const SECONDS_PER_MINUTE = 60;

/**
 * 默认 idle 超时（per-record）。
 *
 * V2 §5.4 / 决策 4：初拟 ≤ prompt cache TTL（~5min）——超出 cacheTTL 的活进程白占
 * 内存（续聊仍 cache miss），小于则 kill 丢热 cache。实测定（P-timeout）。
 */
const IDLE_TIMEOUT_MINUTES = 5;
export const DEFAULT_IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * 从环境变量 XYZ_SUBAGENT_IDLE_TIMEOUT_MS 读取全局默认超时。
 * 返回 undefined 表示 env 未设置或非法（调用方回落 DEFAULT_IDLE_TIMEOUT_MS）。
 *
 * [LC-7/T7①] env 已设但非法（非数字/<=0）回落默认值时必须 warn 留痕——「以为设了
 * 极长保活、实际回落 5min」的静默语义漂移不可见（设计 §4.3 LC-7），生效行为必须
 * 可见。禁用语义不认 env（禁用只能显式传参 <=0，见 armIdleTimer 注释）。
 *
 * [review 修复] 原 PI_ 前缀（PI_SUBAGENT_IDLE_TIMEOUT_MS）不在 ENV_WHITELIST_PREFIXES
 * 白名单（packages/shared/src/constants.ts 只有 XYZ_ 等，无 PI_），xyz-agent 桌面
 * spawn 链（safe-env 过滤）会丢弃该 env，配置口在桌面场景静默失效——已改名 XYZ_
 * 前缀以透传。本地 pi CLI 直跑 env 全量继承，两种前缀都有效。注意与其他
 * PI_SUBAGENT_* env 区分：那些是 extension 在 pi 进程内 spawn 子进程时直接注入的
 * childEnv，不经过 safe-env 白名单过滤，PI_ 前缀无此问题。
 */
function getEnvIdleTimeoutMs(): number | undefined {
  const raw = process.env.XYZ_SUBAGENT_IDLE_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[lifecycle-manager] XYZ_SUBAGENT_IDLE_TIMEOUT_MS="${raw}" is invalid (expected a positive millisecond number) — falling back to DEFAULT_IDLE_TIMEOUT_MS (${DEFAULT_IDLE_TIMEOUT_MS}ms); set a plain ms value (e.g. 1800000) to override`,
    );
    return undefined;
  }
  return parsed;
}

// ============================================================
// 职责 1：idle timer（per-record）
// ============================================================

interface IdleTimerEntry {
  /** Node setTimeout 句柄，disarm/刷新时 clearTimeout。 */
  readonly timer: NodeJS.Timeout;
  /** 本次 arm 使用的超时时长（诊断/刷新对齐用）。 */
  readonly timeoutMs: number;
}

/** recordId → armed idle timer。仅在空闲态 armed（V2 决策 4：禁止 timer 常驻）。 */
const idleTimers = new Map<string, IdleTimerEntry>();

/**
 * Arm（或刷新）某 record 的 idle timer。
 *
 * - 若该 record 已有 armed timer，先 clearTimeout 旧的再设新的（重复 arm = 刷新计时，
 *   对齐 V2「续聊 disarm 后再次 agent_settled 重新 arm」语义）。
 * - 超时触发时先从 Map 移除自身，再回调 onTimeout（onTimeout 内若重新 arm 不会被误删）。
 *
 * 调用时机（接入时由 session-runner 编排）：`agent_settled`（支柱四，真空闲边界）→ arm。
 *
 * [预算语义对齐] 显式禁用：timeoutMs 传 0/负数 → 不挂 timer 并 disarm 已有的
 * （idle GC 可被显式关闭，旧实现 0 会落成 setTimeout(0) 立即 kill——危险 footgun）。
 * 默认行为不变（资源回收性质，默认值保留）：不传 → env XYZ_SUBAGENT_IDLE_TIMEOUT_MS
 * → DEFAULT_IDLE_TIMEOUT_MS（5min）。env 频道不认识禁用值：非法（<=0）回落默认。
 *
 * @param recordId subagent record id（sa-<uuid>）
 * @param onTimeout 超时回调（调用方注入：SIGTERM 回收进程）
 * @param timeoutMs 可选。SP-6 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > DEFAULT_IDLE_TIMEOUT_MS；
 *   显式 <=0 表示禁用（不挂 timer）。
 * @throws 解析后的 delay（参数/env/默认任一层）超出 Node setTimeout 上限 2^31-1 ——
 *   溢出值会被 Node 置 1ms 立即触发（「长空闲保活」变「立即回收」），fail-fast 不静默
 *   clamp（U1）。
 */
export function armIdleTimer(
  recordId: string,
  onTimeout: () => void,
  timeoutMs?: number,
): void {
  // 显式禁用通道：参数明确传 0/负数 → 关闭该 record 的 idle GC（顺带清已有 timer，
  // 否则早前默认 arm 的 timer 仍在跑，禁用形同虚设）。
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    disarmIdleTimer(recordId);
    return;
  }

  // SP-6 优先级：参数 > env XYZ_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms (5min)。
  const resolved = timeoutMs ?? getEnvIdleTimeoutMs() ?? DEFAULT_IDLE_TIMEOUT_MS;

  // [U1] arm 入口：值流入 setTimeout 前校验安全域（>2^31-1 会变 1ms 立即触发）。
  // 显式 <=0 的禁用通道已在上方 return，不受影响。
  assertSafeTimerDelay(resolved, "idleTimeoutMs");

  // 刷新：先清旧 timer，避免同一 record 叠加多个 armed timer。
  disarmIdleTimer(recordId);

  // [LC-5/T6①] 超时回调按值守卫（对齐同包 session-runner.ts removeChildRegistration
  // 的按句守卫先例）：clearTimeout 对「已到期、回调已入 macrotask 队列」的 timer 无效
  //（Node 语义：fire 后不可撤销），若此刻同 recordId 发生 disarm + re-arm（agent_settled
  // 刷新与旧 timer 到点同轮交错），旧回调无条件 delete(recordId) 会误删**新** timer 条目
  // ——新 timer 脱管，后续 disarm 失效 → turn 中途被 idle GC 误杀。回调捕获自己的 timer
  // 引用，仅当 Map 当前条目仍是自己（未被 re-arm 覆盖）才删除。设计 §11-2：fake-timer
  // 模型内无法复现「旧回调迟到于 re-arm」的精确交错（sinon clock 同步 tick 消除了该
  // 中间态），身份比对按防御性守卫保留（成本一行）。
  const timer: NodeJS.Timeout = setTimeout(() => {
    if (idleTimers.get(recordId)?.timer === timer) {
      idleTimers.delete(recordId);
    }
    onTimeout();
  }, resolved);
  // node 默认 setTimeout 返回的 timer 会被事件循环 keep-alive；unref 让它不阻塞
  // 进程退出（进程退出由 shutdown hook 显式收割兜底，不靠 timer 拖延）。
  timer.unref?.();

  idleTimers.set(recordId, { timer, timeoutMs: resolved });
}

/**
 * Disarm 某 record 的 idle timer（新 turn 开始时调）。
 *
 * 不存在 armed timer 时 no-op。V2 决策 4：新 turn 开始（投递导致 isStreaming 转
 * true）必须 disarm——turn 期间进程由 busy 状态保护，绝不能被 idle timer 误杀。
 */
export function disarmIdleTimer(recordId: string): void {
  const entry = idleTimers.get(recordId);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timer);
  idleTimers.delete(recordId);
}

/**
 * 查询某 record 是否有 armed idle timer（诊断/接入期断言用）。
 */
export function hasIdleTimer(recordId: string): boolean {
  return idleTimers.has(recordId);
}

// ============================================================
// 职责 5：activate 互斥（防线 iii，防双写者）
// ============================================================

/**
 * recordId → 该 record 当前 activate 链尾的 Promise。
 *
 * 同一 recordId 的第二次 acquireActivateLock 会 await 链尾，直到前者 release 才 resolve，
 * 从而串行化并发 activate，保证「同一 recordId 全局最多一个活进程」不变量（V2 决策 7
 * 防线 iii：双写者交错 append 会写坏整个 session 文件，比脏 entry 致命一个量级）。
 *
 * **tail-identity 自清**（防长进程 recordId 条目泄漏）：release 后经 queueMicrotask
 * 异步检查——Map 链尾仍是本链尾（identity 匹配）时 delete 回收；有 waiter 排队时其
 * acquire 已用新链尾覆盖 Map（identity 不匹配）→ 不删，条目由最后释放者回收。waiter
 * 持 acquire 时刻捕获的 prev Promise 引用而非 Map 查询，delete 不影响其等待。30s
 * 超时兜底与 _resetLifecycleState（全量 clear）语义不变。
 */
const activateLockTails = new Map<string, Promise<void>>();

/**
 * 获取某 record 的 activate 串行锁。
 *
 * - 同 recordId 首次 acquire：立即 resolve，返回 release 函数。
 * - 同 recordId 第二次 acquire（前者未 release）：pending，直到前者 release 才 resolve。
 * - 不同 recordId 互不阻塞（各自独立链）。
 *
 * @returns release 函数——获得锁后**必须**调用它释放（finally 块），否则同 recordId
 *          的后续 acquire 永久挂起。
 *
 * **状态：保留但当前无生产调用方**（历史接线点 subagent-service 冷路径 resume 前
 * 已随协议化重构消失）。作为 idle CAS 守卫之外的结构化防护层设计：idle CAS
 *（`status !== "idle"` 检查与 `status = "running"` 翻转间无 await）是一级守卫，
 * 锁把冷路径 resume spawn 的双写者交错升级为串行排队，防坏 session。恢复接线时
 * 语义不变。超时兜底见下方 `ACTIVATE_LOCK_TIMEOUT_MS`（V3 D3 / v4-lifecycle-convergence.md A-2）。
 */

/**
 * acquireActivateLock 等待前序锁释放的超时（v4 A-2）。
 *
 * 前 holder 崩溃/死锁导致 release 永不触发时，waiter 不无限挂起；30s 超时后抛含恢复指引
 * 的错误（调用方可用 message action 重试）。30s 远超正常冷路径 resume spawn 耗时（~ms 级），
 * 留足异常恢复余量而不误伤正常排队。
 */
const ACTIVATE_LOCK_TIMEOUT_SECONDS = 30;
const ACTIVATE_LOCK_TIMEOUT_MS = ACTIVATE_LOCK_TIMEOUT_SECONDS * MS_PER_SECOND;

export function acquireActivateLock(recordId: string): Promise<() => void> {
  const prev = activateLockTails.get(recordId) ?? Promise.resolve();
  let releaseFn!: () => void;
  // [review 修复] 超时放行句柄：超时者从未持有锁（race 已 reject），releaseFn 不会被
  // 调用方触发，current 将永久 pending → tail（= prev.then(() => current)）永久
  // pending → 后续同 recordId 的 acquire 只能靠 30s 超时出队（锁链瘫痪，只能重启
  // 恢复）。超时回调显式 resolve current 放行链尾（见下方 timeoutPromise）。
  let settleCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    settleCurrent = resolve;
    // tail-identity 自清（ES7/LOCK_TAIL_GC_RACE）：resolve 后经 microtask 异步回收——
    // 仅当 Map 链尾仍是本链尾（tail）时 delete。自清检查只读 Map 引用比较、不依赖
    // 链尾 Promise 是否已 settle——release() 同步 resolve 后 microtask 执行时，无论
    // then 链推进到哪一步，identity 比较结果一致；同 recordId 快速 acquire→release→
    // acquire 序下，后继 acquire 的 set 已覆盖 Map，先行 release 的自清检查
    // get !== 旧 tail → 不删（正确保留新链）。
    releaseFn = () => {
      resolve();
      queueMicrotask(() => {
        if (activateLockTails.get(recordId) === tail) {
          activateLockTails.delete(recordId);
        }
      });
    };
  });
  // 链尾 = 等 prev 完成后挂 current；current 在 releaseFn 调用前保持 pending，
  // 让下一次 acquire 的 prev 等到本次 release。tail 引用同时作为自清的 identity key。
  const tail = prev.then(() => current);
  activateLockTails.set(recordId, tail);

  // 30s 超时兜底（v4 A-2）：前序 holder 长期不 release（崩溃/死锁）时，waiter 不无限挂起，
  // 超时抛含恢复指引的错误（调用方可用 message action 重试）。正常拿到锁时 clearTimeout
  // 取消未触发的 timer 防泄漏。超时只 reject 本次 acquire 的返回 promise，不改 release 语义——
  // 原 holder release 仍 resolve current，链尾照常推进，后续 waiter 各受同样 30s 保护。
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // acquire 已赢标记：prev 的 then 回调（微任务）恒先于 timer 回调（宏任务）执行，
  // 标记位防「prev 恰在 30s 边界 settle、clearTimeout 未赶上已入队 timer」的窗口——
  // 那时调用方已（将）持有锁，若再放行链尾会让后续 waiter 提前获锁形成双写者。
  let acquired = false;
  const acquirePromise = prev.then(() => {
    acquired = true;
    clearTimeout(timeoutId);
    return releaseFn;
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (acquired) return;
      // [review 修复] 超时放行链尾：resolve 自身 current，保证前序 holder release 后
      // tail 可 settle（不绕过前序等待——prev 未 settle 时 tail 仍等 prev，互斥保持），
      // 后续 acquire 不被本超时者的永久 pending tail 卡死。
      settleCurrent();
      // [review 修复] 超时者对称自清（round2 INFO 残留）：releaseFn 永不被调用（race
      // 已 reject），tail-identity 自清 microtask 不排队，条目滞留 Map 直到下次同
      // recordId acquire 覆盖。此处挂 tail 尾部做同款 identity 自清——只有 tail
      // 真正 settle（prev 也已 release）才回收：不能直接 queueMicrotask 删除——前序
      // 仍持锁（tail pending）时删条目会让后续 acquire 不再排队等前序 release，
      // 破坏互斥（超时放行的是链尾 settle，不是锁获取）。tail 永不 settle（前序
      // 崩溃）时回调不执行，条目与现状一致由 _resetLifecycleState 兜底清理。
      tail.then(() => {
        if (activateLockTails.get(recordId) === tail) {
          activateLockTails.delete(recordId);
        }
      });
      reject(
        new Error(
          `subagent ${recordId} activation timed out; retry action: message`,
        ),
      );
    }, ACTIVATE_LOCK_TIMEOUT_MS);
  });
  return Promise.race([acquirePromise, timeoutPromise]);
}

// ============================================================
// 测试钩子（模块级单例状态隔离）
// ============================================================

/**
 * 清空全部模块级状态（idle timer / activate 锁链尾）。
 *
 * 仅用于单测的 beforeEach 隔离——clearTimeout 所有 armed timer 防止跨用例泄漏。
 *
 * 注意：不会 resolve 已 acquire 但未 release 的锁 Promise（那些 pending holder 由测试
 * 自律 release；reset 后它们的链尾引用被 Map 丢弃，不再阻塞后续 acquire）。
 */
export function _resetLifecycleState(): void {
  for (const entry of idleTimers.values()) {
    clearTimeout(entry.timer);
  }
  idleTimers.clear();
  activateLockTails.clear();
}

/**
 * 测试钩子：返回 activateLockTails 当前条目数。
 *
 * activateLockTails 是模块私有 const，自清语义（tail-identity 回收）的断言需要
 * 观察点——本导出仅测试使用，命名对齐 _resetLifecycleState（本文件）与
 * _resetProcessShutdownGuardForTest（index.ts）先例。
 */
export function _getActivateLockTailCountForTest(): number {
  return activateLockTails.size;
}
