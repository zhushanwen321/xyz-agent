// src/execution/lifecycle-manager.ts
//
// Subagent 持续对话 V2 — 进程生命周期管理（§5.2 模块 1）。
//
// 本模块是 V2 五项生命周期职责的中心调度器，以**模块级单例**持有全局进程
// 状态（活进程集合、per-record idle timer、activate 串行化锁）。它**不直接持有
// ChildProcess 句柄**——句柄仍在 session-runner 的 spawnedChildren Map——因此
// 所有「副作用」能力（kill / 探活 / 超时回调）都由调用方经回调/参数注入，本模块
// 只管状态记账 + 调度顺序。这让模块可独立编译 + 单测，无需拉起真实子进程。
//
// 五项职责（对应 V2 决策 1/4/7）：
//   1. idle timer —— agent_settled arm / 新 turn disarm / 超时触发 onTimeout（决策 4）
//   2. 全局 ceiling —— 活进程上限，超限时按 LRU 挤出最久空闲（决策 4）
//   3. shutdown 收割 —— 父进程 shutdown 时显式 SIGTERM 全部 activation（决策 7 防线 i）
//   4. 孤儿扫描 —— 父进程启动时按持久化 PID 扫收上次崩溃遗留的孤儿（决策 7 防线 ii）
//   5. activate 互斥 —— 同 recordId 的并发 activate 串行化（决策 7 防线 iii，防双写者）
//
// 触发点（谁在何时调 arm/disarm/reap）散落在 session-runner / subagent-service /
// index.ts，由后续步骤接入；本模块不 import 它们，避免循环依赖。
//
// 设计参考：session-runner 的 MF-3/MF-4 setTimeout→SIGTERM 骨架（复用 timer 形态，
// 触发条件重构）；spawnedChildren Map 的模块级单例模式。

// ============================================================
// 默认常量
// ============================================================

/**
 * 默认 idle 超时（per-record）。
 *
 * V2 §5.4 / 决策 4：初拟 ≤ prompt cache TTL（~5min）——超出 cacheTTL 的活进程白占
 * 内存（续聊仍 cache miss），小于则 kill 丢热 cache。实测定（P-timeout）。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 从环境变量 PI_SUBAGENT_IDLE_TIMEOUT_MS 读取全局默认超时。
 * 返回 undefined 表示 env 未设置或非法（调用方回落 DEFAULT_IDLE_TIMEOUT_MS）。
 * PI_ 前缀符合 ENV_WHITELIST_PREFIXES 白名单。
 */
function getEnvIdleTimeoutMs(): number | undefined {
  const raw = process.env.PI_SUBAGENT_IDLE_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * 默认全局活进程上限（ceiling）。
 *
 * V2 §5.4 / 决策 4：防「N 个 subagent 于 timeout 窗口内高频复用」场景的内存高水位
 * 无上界。候选 8-10，实测定（P-ceiling）。
 *
 * 注意：挤出候选**仅限空闲进程**（busy 进程不做候选，V2 决策 4 硬约束）。本模块不
 * 感知 busy（进程句柄在 session-runner），调用方接入 evictIfOverCeiling 前应确保
 * 已把 busy 进程移出活进程集合（unregisterActiveProcess），或由后续步骤扩展注入
 * isBusy 谓词。
 */
export const DEFAULT_MAX_ALIVE_PROCESSES = 8;

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
 * @param recordId subagent record id（sa-<uuid>）
 * @param onTimeout 超时回调（调用方注入：SIGTERM 回收进程）
 * @param timeoutMs 可选。SP-6 优先级：参数 > env PI_SUBAGENT_IDLE_TIMEOUT_MS > DEFAULT_IDLE_TIMEOUT_MS。
 */
export function armIdleTimer(
  recordId: string,
  onTimeout: () => void,
  timeoutMs?: number,
): void {
  // SP-6 优先级：参数 > env PI_SUBAGENT_IDLE_TIMEOUT_MS > 默认 300000ms (5min)。
  const resolved = timeoutMs ?? getEnvIdleTimeoutMs() ?? DEFAULT_IDLE_TIMEOUT_MS;

  // 刷新：先清旧 timer，避免同一 record 叠加多个 armed timer。
  disarmIdleTimer(recordId);

  const timer = setTimeout(() => {
    idleTimers.delete(recordId);
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
// 职责 2：全局 ceiling（活进程上限 + LRU）
// ============================================================

interface ActiveProcessEntry {
  /** 最近活动时间戳（Date.now()）。LRU 挤出时取最小者。 */
  lastTouched: number;
}

/**
 * recordId → 活进程记账项。register 时加入，unregister/挤出/reap 时移除。
 *
 * 该集合**不是** ChildProcess 句柄表（那在 spawnedChildren），只是 lifecycle-manager
 * 用于 ceiling 判定 + orphan 判定 + reap 枚举的记账结构。
 */
const activeProcesses = new Map<string, ActiveProcessEntry>();

/**
 * 登记一个活进程（activate/spawn 完成时调）。
 *
 * 重复 register 同一 recordId 视为刷新（更新 lastTouched），不叠加。
 */
export function registerActiveProcess(recordId: string): void {
  activeProcesses.set(recordId, { lastTouched: Date.now() });
}

/**
 * 续聊/新 turn 时 touch 某 record，更新 LRU 时间戳（让它不被 LRU 挤出）。
 *
 * 不存在时 no-op（保守：避免隐式创建掩盖状态不一致；调用方应先 register）。
 */
export function touchActiveProcess(recordId: string): void {
  const entry = activeProcesses.get(recordId);
  if (!entry) {
    return;
  }
  entry.lastTouched = Date.now();
}

/**
 * 注销一个活进程（进程退出/终态化/已被 reap 时调）。
 *
 * cascade：同时 disarm 该 record 的 idle timer——进程都没了，残留 timer 触发只会
 * 操作已清理的 record（V2 决策 4 一致性）。不存在时 no-op。
 */
export function unregisterActiveProcess(recordId: string): void {
  activeProcesses.delete(recordId);
  disarmIdleTimer(recordId);
}

/**
 * 超过 ceiling 时按 LRU 挤出最久空闲的进程，直到活进程数 ≤ ceiling。
 *
 * 挤出语义（V2 决策 4 passivate）：对每个被挤出者调 onEvict（调用方注入：SIGTERM
 * 回收），并从活进程集合移除 + disarm 其 idle timer（passivate 后进程死，timer 无意义）。
 *
 * **busy 不做挤出候选**（V2 决策 4 硬约束）：本模块不感知 busy，调用方接入前负责把
 * busy 进程 unregister 出集合（或后续步骤注入 isBusy 谓词），否则 busy 进程可能被误杀。
 *
 * @param onEvict 挤出回调（recordId）——调用方 SIGTERM 该进程
 * @param maxAlive 可选上限覆盖（默认 DEFAULT_MAX_ALIVE_PROCESSES）；注入便于测试
 */
export function evictIfOverCeiling(
  onEvict: (recordId: string) => void,
  maxAlive: number = DEFAULT_MAX_ALIVE_PROCESSES,
): void {
  while (activeProcesses.size > maxAlive) {
    // 找 lastTouched 最小的（最久未活动）。Map 迭代顺序 = 插入顺序，最小值扫描稳定。
    let oldestId: string | undefined;
    let oldestTouched = Infinity;
    for (const [id, entry] of activeProcesses) {
      if (entry.lastTouched < oldestTouched) {
        oldestTouched = entry.lastTouched;
        oldestId = id;
      }
    }
    if (oldestId === undefined) {
      break; // 防御：集合为空但 size 判定异常时退出
    }
    // 先移除 + disarm，再回调。onEvict 是 passivate 语义（SIGTERM 回收），
    // 不应在其中重新 register 同一 record——否则 size 不减会导致 while 死循环。
    activeProcesses.delete(oldestId);
    disarmIdleTimer(oldestId);
    onEvict(oldestId);
  }
}

/**
 * 查询当前活进程数（诊断/接入期断言用）。
 */
export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

// ============================================================
// 职责 3：shutdown 收割（防线 i）
// ============================================================

/**
 * 收割当前全部活进程（父进程 shutdown 时调）。
 *
 * 遍历活进程集合，对每个调 killFn（调用方注入：child.kill("SIGTERM")），并 disarm 对应
 * idle timer 避免 timer 泄漏（V2 决策 7 防线 i：shutdown hook 显式收割）。
 *
 * @param killFn 收割回调（recordId）——调用方对 spawnedChildren 中的句柄发 SIGTERM
 * @returns 被收割的 recordId 列表（按集合迭代序）
 */
export function reapAllAliveProcesses(killFn: (recordId: string) => void): string[] {
  const reaped: string[] = [];
  // 拷贝 keys 再遍历——killFn 的副作用可能间接触发 unregister，避免迭代中改集合。
  for (const recordId of [...activeProcesses.keys()]) {
    killFn(recordId);
    reaped.push(recordId);
  }
  // 全部收割后清空记账 + disarm 所有 timer。
  for (const entry of idleTimers.values()) {
    clearTimeout(entry.timer);
  }
  idleTimers.clear();
  activeProcesses.clear();
  return reaped;
}

// ============================================================
// 职责 4：孤儿扫描（防线 ii）
// ============================================================

/** 孤儿扫描候选：来自持久化 record 的 pid 信息。 */
export interface OrphanCandidate {
  readonly id: string;
  /** 持久化的进程 pid（缺失表示上次未持久化，无法判定）。 */
  readonly pid?: number;
  /** session 文件路径（调用方二次校验命令行时可用，本函数不消费）。 */
  readonly sessionFile?: string;
}

/**
 * 扫描孤儿进程候选（父进程启动时调）。
 *
 * 判定：pid 存在 && isProcessAlive(pid) && 该 record **不在**当前活进程集合 =
 * 上次崩溃/异常退出遗留的孤儿（V2 决策 7 防线 ii）。
 *
 * **PID 复用风险**（V2 §5.4）：仅靠 pid 存活不够——pid 可能被 OS 复用给无关进程。
 * 本函数只按 pid 判定并返回候选列表，**调用方收割前必须二次校验**进程命令行含
 * `pi --mode rpc`（确保是 subagent 残留而非被复用的无关进程）。该校验在调用方，不在本函数。
 *
 * 本函数只读，不改任何状态（孤儿收割由调用方对 killFn 执行）。
 *
 * @param records 持久化的 record 列表（含 pid）
 * @param isProcessAlive pid 探活谓词（调用方注入，对齐 alive-store.isProcessAlive）
 * @returns 孤儿候选 recordId 列表
 *
 * **状态：deferred（defense-in-depth，当前 spawn 配置下不触发）**。本函数骨架 + 单测已就绪，
 * 数据通路（`.alive` sidecar 写 pid / `reconstructAll` 分支 3 读 alive.pid）也已落地，但
 * **不接入 session_start**。理由 + 接入设计草图见
 * `docs/design/v2-defense-ii-iii-resolution.md`（防线 ii 章节）。要点：当前 spawn 用 piped
 * stdio（非 detach），父进程死亡 → stdin EOF → 子进程自杀（F10）覆盖全部正常崩溃路径，
 * 孤儿近乎不可能泄漏；安全收割需 PID 复用校验（跨平台进程命令行读取，防 OS 复用 pid 误杀），
 * 属低频场景的中等复杂度工作，待 spawn 改 detach 时再接入。
 */
export function scanOrphanProcesses(
  records: OrphanCandidate[],
  isProcessAlive: (pid: number) => boolean,
): string[] {
  const orphans: string[] = [];
  for (const record of records) {
    if (record.pid === undefined) {
      continue; // 无 pid 无法判定，不视为孤儿
    }
    if (activeProcesses.has(record.id)) {
      continue; // 已在本进程 activation 集合内，非孤儿
    }
    if (isProcessAlive(record.pid)) {
      orphans.push(record.id);
    }
    // pid 不存活 → 进程已退出，非孤儿
  }
  return orphans;
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
 * **状态：冗余，不接入 runSpawn**。单 activation 不变量已由 `resumeRound`（
 * `subagent-service.ts:631/660`）的同步状态 CAS 覆盖：`status !== "idle"` 检查与
 * `status = "running"` 翻转之间无 await，同一 recordId 的并发 message 只有一个能进入 spawn，
 * 另一个 throw「not ready」。`acquireActivateLock` 只会把「第二个 throw」改成「第二个排队」，
 * 是 reject→serialize 的语义改变，非安全修复。完整分析见
 * `docs/design/v2-defense-ii-iii-resolution.md`（防线 iii 章节）。骨架保留（已实现 + 已测，
 * 零维护成本）；未来若产品决定续聊从「被拒」改为「排队」，再接入并做退出路径全覆盖设计。
 */
export function acquireActivateLock(recordId: string): Promise<() => void> {
  const prev = activateLockTails.get(recordId) ?? Promise.resolve();
  let releaseFn!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  // 链尾 = 等 prev 完成后挂 current；current 在 releaseFn 调用前保持 pending，
  // 让下一次 acquire 的 prev 等到本次 release。
  activateLockTails.set(recordId, prev.then(() => current));
  // 调用方等 prev 完成后才拿到 releaseFn（即拿到锁）。
  return prev.then(() => releaseFn);
}

// ============================================================
// 测试钩子（模块级单例状态隔离）
// ============================================================

/**
 * 清空全部模块级状态（idle timer / 活进程集合 / activate 锁链尾）。
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
  activeProcesses.clear();
  activateLockTails.clear();
}
