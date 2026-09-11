// src/execution/finalize-record.ts
//
// 时序收尾逻辑（从 subagent-service.ts 提取，降低主文件行数 < 1000 上限）。
//
// D-017 时序：collectPatch → completeRecord → archive → cleanup(finalized+worktree+
// aliveMarker+pending注销) → manifest(最后 best-effort)。
//
// [Critical #1 / PR #85] cleanup 全部在 manifest 写之前执行——manifest 是 sa- id 反查
// 索引（最新已知快照），非正确性依赖，写失败仅记录不阻断。旧实现 Step 2.5 throw 会跳过
// Step 3 cleanup，导致磁盘满/权限错时 worktree 泄漏 + finalized marker 不写 + alive
// marker 残留 + pending 记账错乱。现 manifest 写移到 Step 4（最后），best-effort
//（console.error + appendEntry，不 throw）。
//
// B9 兜底：completeRecord/archive 抛错→后续 cleanup/manifest 仍执行。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";

import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
import { completeRecord } from "./execution-record.ts";
import { writeCancelledState, writeFinalizedState } from "./state-marker.ts";
import type { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import type { RecordStore } from "./record-store.ts";
import { readIdentityHeader, readIdentityTail } from "./session-reconstructor.ts";
import type { AgentResult, ClosedReason, ExecutionRecord } from "./types.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

const logger = getLogger("subagents");

/** doFinalizeRecord 的依赖（从 SubagentService 注入，避免 this 绑定 + 解耦可测试）。 */
export interface FinalizeDeps {
  manifestStore: ManifestStore;
  worktreeManager: WorktreeManager;
  store: RecordStore;
  modelService: ModelConfigService;
  /** Pi ExtensionAPI（仅用 appendEntry 记录 manifest 写失败事件）。null 在 dispose 后。 */
  pi: { appendEntry?: (type: string, data: unknown) => void } | null;
  /** pending-notifications 终态注销（绑定 pi.events.emit，由调用方闭包提供）。 */
  emitUnregister(id: string, status: string): void;
  /**
   * [F-5 修复] record 终态化的宿主侧收口钩子（recordId；best-effort，抛错由调用方
   * 在闭包内自行兜底）。单一汇聚点：doFinalizeRecord 是全部 closed 终态的必经路径
   * （finalizeRecord / closeChatIdle / closeAfterRoundSettled / finalizeFailed /
   * finalizeAborted / consumeCloseAfterRound），chat 轮路由注销（chatRoundRoutes）
   * 由 SubagentService 经此钩子统一执行——此前仅 cancelBackground 注销，chat record
   * 经 finalize 链终态化后路由闭包（持 record/stream/守护引用）泄漏。finalizeRoundToIdle
   * 不经本钩子（回 idle 非终态，续聊仍需路由）。
   */
  onFinalized?: (recordId: string) => void;
  /**
   * [T1/PS-9] subagent sessionDir（getSubagentSessionDir(agentDir, rootCwd)，调用方注入）。
   *
   * record.sessionFile 缺失（RC-1 握手失败 + LC-4 反查也未命中的残余形态）时用于磁盘
   * 反查：按 identity（record.id）扫目录找真实 session 文件，作为 tombstone/finalized
   * sidecar 与 removeAliveMarker 的依据——消除「sessionFile 缺失 → 终态原因丢失 +
   * alive marker 残留」。undefined = 调用方无法提供（反查跳过，行为退回修复前）。
   */
  sessionDir?: string;
  // [review 修复] 已删除 redeliverPending 回调（MF-1 消费确认制补投）：pendingMessages
  // 三段消费链随 deliverToRunning 一并移除（无生产调用方，死机制）。
}

/**
 * [T1/PS-9] 按 record 身份在 sessionDir 反查 session 文件（record.sessionFile 缺失时用）。
 *
 * 匹配依据：session JSONL 的 identity custom entry 携带 record id（子进程 session_start
 * hook 写入），探测函数与 RecordStore 列表扫描同源（readIdentityHeader 头部 64KB →
 * readIdentityTail 尾部 64KB；续聊场景 identity 靠尾）。readIdentityAnywhere 需全文读，
 * 本反查是收尾路径的 best-effort，不做。
 *
 * @returns 匹配到的 session 文件绝对路径；目录不可读 / 无匹配返回 undefined（不抛）。
 */
function findSessionFileByRecordIdentity(
  sessionDir: string,
  recordId: string,
): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return undefined; // 目录缺失/不可读 → 反查跳过，行为退回无反查
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(sessionDir, name);
    const recon = readIdentityHeader(full) ?? readIdentityTail(full);
    if (recon?.id === recordId) return full;
  }
  return undefined;
}

/**
 * [T1/PS-9] Step 序言：sessionFile 缺失时按 record 身份在 sessionDir 反查回填。
 *
 * 放在一切步骤前，让 archive 投影 / Step 3 marker / Step 4 manifest 统一受益。
 * RC-1（握手失败）+ LC-4（收尾反查未命中）的残余形态下，磁盘上 session 文件仍可能
 * 真实存在（identity 携带 record.id）——反查命中则 tombstone/finalized sidecar 与
 * removeAliveMarker 有了依据，终态原因不再丢失、alive marker 不再残留；未命中则
 * 保持旧行为（best-effort 跳过）。
 */
function resolveMissingSessionFile(deps: FinalizeDeps, record: ExecutionRecord): void {
  if (record.sessionFile || !deps.sessionDir) return;
  const resolved = findSessionFileByRecordIdentity(deps.sessionDir, record.id);
  if (resolved) {
    record.sessionFile = resolved;
    logger.warn(
      `[subagent] finalizeRecord: sessionFile was missing, resolved via sessionDir identity lookup: ${resolved}`,
    );
  }
}

/**
 * Step 0: collectPatch（best-effort，仅 worktree 绑定时执行）。
 * [MF#3] patchFile 写到 worktree 之外（sessionsDir/<branch>.patch），避免被 cleanup 删除；
 * 路径回填 record.patchFile，供调用方（tool result / /subagents list）应用。
 */
async function collectPatchIfWorktree(deps: FinalizeDeps, record: ExecutionRecord): Promise<void> {
  if (!record.worktreeHandle) return;
  try {
    const sessionsDir = getSubagentSessionDir(
      deps.modelService.getAgentDir(),
      record.worktreeHandle.mainCwd,
    );
    fs.mkdirSync(sessionsDir, { recursive: true });
    const patchFile = path.join(sessionsDir, `${record.worktreeHandle.branch}.patch`);
    const patch = await deps.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
    if (patch.written) record.patchFile = patchFile;
  } catch (pe: unknown) {
    bestEffort(pe, "collectPatch (finalizeRecord Step0)");
  }
}

/**
 * Step 3a: 终态 sidecar（best-effort 幂等，仅 sessionFile 存在时执行）。
 * L4 合并：finalized / cancelled 统一写 `<session>.state`（单一形态，status 字段区分）；
 * cancelled 保留精确 endedAt，其余 reason 进 reason 字段（磁盘重建用它还原
 * closedReason，不再一律硬编码 gc）。
 */
function writeTerminalState(record: ExecutionRecord, closedReason: ClosedReason | undefined): void {
  if (!record.sessionFile) return;
  try {
    if (closedReason === "cancelled") {
      writeCancelledState(record.sessionFile, record.endedAt ?? Date.now());
    } else {
      writeFinalizedState(record.sessionFile, closedReason);
    }
  } catch (err) {
    bestEffort(err, "writeTerminalState (finalizeRecord Step3)");
  }
}

/**
 * Step 3b: worktree cleanup（best-effort 幂等，仅 worktree 绑定时执行）。
 * [Critical] 绝不能因 manifest 写失败而跳过（否则 worktree 泄漏）。
 */
async function cleanupWorktreeIfBound(deps: FinalizeDeps, record: ExecutionRecord): Promise<void> {
  if (!record.worktreeHandle) return;
  try {
    await deps.worktreeManager.cleanup(record.worktreeHandle);
  } catch (err) {
    bestEffort(err, "worktree cleanup (finalizeRecord Step3)");
  }
}

/** Step 3c: 删 .alive marker（best-effort 幂等，仅 sessionFile 存在时执行）。 */
function removeAliveMarkerIfPresent(record: ExecutionRecord): void {
  if (!record.sessionFile) return;
  try {
    removeAliveMarker(record.sessionFile);
  } catch (err) {
    bestEffort(err, "removeAliveMarker (finalizeRecord Step3)");
  }
}

/**
 * Step 4 (last): manifest 持久化（best-effort，不阻断、不 throw）。
 *
 * [Critical #1] manifest 是 sa- id 反查索引（最新已知快照），不是正确性依赖。本步骤
 * 写终态快照；sync 批成功成员不经此处——落标出口（subagent-service
 * appendBatchFinalizedEntry）已先行补写，message upgrade 到终态时被本步骤原子
 * 覆盖。写失败时仅记录（console.error + appendEntry），绝不让 manifest 写失败
 * 跳过 Step 3 cleanup 或抛出打断 finalize 链。旧实现 Step 2.5 throw 会
 * 跳过 Step 3 cleanup。task/slug/model 从 ExecutionRecord 抓取（配合
 * ManifestRecord 补字段），manifestToSubagent 投影时用真实值而非硬编码空串。
 */
async function writeManifestBestEffort(deps: FinalizeDeps, record: ExecutionRecord): Promise<void> {
  try {
    await deps.manifestStore.writeManifest({
      id: record.id,
      rootSessionId: record.rootSessionId ?? "",
      parentRecordId: record.parentRecordId,
      agentName: record.agent,
      // v4 B-1: manifest status 统一为 closed（cancelled 折入 closed，区分靠 tombstone sidecar）
      status: "closed",
      createdAt: record.startedAt,
      completedAt: record.endedAt ?? Date.now(),
      sessionFile: record.sessionFile,
      task: record.task,
      slug: record.slug,
      model: record.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[subagent] manifest 写入失败 (record=${record.id}): ${msg}`);
    deps.pi?.appendEntry?.("subagent:manifest-write-failed", {
      id: record.id,
      error: msg,
    });
  }
}

/**
 * 时序收尾（D-017）。步骤 0→4 全部 best-effort 互不阻断（除 manifest 外都幂等）。
 *
 * [Critical #1] Step 3 cleanup 全部在 Step 4 manifest 之前——manifest 写失败仅 console.error +
 * appendEntry，不 throw 不跳过 cleanup。task/slug/model 从 ExecutionRecord 抓取（配合 ManifestRecord
 * 补字段），manifestToSubagent 投影真实值而非硬编码空串。
 */
export async function doFinalizeRecord(
  deps: FinalizeDeps,
  record: ExecutionRecord,
  result: AgentResult,
  status: "closed",
  closedReason?: ClosedReason,
): Promise<void> {
  // [T1/PS-9] sessionFile 缺失时 sessionDir 反查（序言，先于一切步骤）。
  resolveMissingSessionFile(deps, record);

  // ── Step 0: collectPatch（best-effort）──
  await collectPatchIfWorktree(deps, record);

  // ── Step 1: completeRecord（B9: 抛错→后续仍执行）──
  try {
    completeRecord(record, result, status, closedReason);
  } catch (err) {
    bestEffort(err, "completeRecord (finalizeRecord B9)", "error");
  }

  // ── Step 2: archive（B9: 抛错→后续仍执行）──
  try {
    deps.store.archive(record);
  } catch (err) {
    bestEffort(err, "store.archive (finalizeRecord B9)", "error");
  }

  // ── Step 3: finalized + cleanup + aliveMarker（全部先执行，幂等）──
  // [Critical] 清理必须在 manifest 写入之前：worktree cleanup / finalized marker / aliveMarker
  //   都是幂等且不可跳过的副作用。绝不能因 manifest 写失败而跳过 worktree cleanup
  //   （否则 worktree 泄漏）。各件独立 try/catch，互不阻断。
  writeTerminalState(record, closedReason);
  await cleanupWorktreeIfBound(deps, record);
  removeAliveMarkerIfPresent(record);

  // pending-notifications：终态注销（只记 registry 状态，通知由 BgNotifier 发）
  // [W4 发射点枚举归属①] 注销合法发射点枚举（设计 D2）第 ① 处：subagent record
  // 终态化（finalizeRecord 路径，含监督器放弃）。其余合法发射点：② chatMode 轮末
  // idle（doFinalizeRoundToIdle，本文件下方）；③ workflow run 终态迁移
  // （transition("done") 路径）；④ 监督器显式放弃（走本路径，终态化+注销同批）；
  // ⑤ 注册对账 sweep 补发（round-supervisor/reconcile-sweep.ts）。进程退出本身
  // 永远不是注销理由（subagent-service disposeAllRecords 的 emit 属①——其同批
  // completeRecord+archive 终态化）。
  deps.emitUnregister(record.id, status);

  // [F-5 修复] 宿主侧终态收口钩子（chat 轮路由注销的单一汇聚点，见 FinalizeDeps
  // .onFinalized 注释）。fire-and-forget：钩子失败不阻断 manifest 收尾（闭包内自查）。
  try {
    deps.onFinalized?.(record.id);
  } catch (err) {
    bestEffort(err, "onFinalized hook (finalizeRecord)");
  }

  // ── Step 4 (last): manifest 持久化（best-effort，不阻断、不 throw）──
  await writeManifestBestEffort(deps, record);
}

/**
 * [H1 U2 / D7] 轮终处置的 outcome 入参（判别联合）。
 *
 * 命名与协议 AgentOutcome 同名不同物（设计 D7 v6：kind 判别联合消歧）——
 * kind 判别轮终分流：成功轮正文来源 = Continuation 成功分支的 content（协议
 * AgentOutcome.content 映射产物）；失败轮 reason = 失败原因原文。
 */
export type RoundSettlementOutcome =
  | { kind: "success"; content: string }
  | { kind: "failed"; reason: string };

/**
 * 对话模式轮次完成收尾：record 进 idle 态（非终态化，等待续聊）。
 *
 * 与 doFinalizeRecord 的关键区别（M2-A idle 语义）：
 *   - 不调 completeRecord（record 不冻结，保留 turns[] 等运行时状态供续聊累积）
 *   - 不调 store.archive（record 留内存，getMutable 可查、list 可见）
 *   - 不 cleanup worktree（保留对话模式工作目录）
 *   - 不写 manifest：轮终回 running-resumable 非终态化，本方法无终态快照可写——
 *     manifest 是 sa- id 反查索引（最新已知快照），sync 批成员的先行快照由落标出口
 *     补写（subagent-service appendBatchFinalizedEntry），此处不重复
 *   - 删 .alive marker（进程已 SIGTERM 回收，不再是活进程）
 *   - emitUnregister（进程已死，从 pending 活跃后代差集移除；record 留内存不 archive）
 *
 * 状态：record.status = "running"（覆盖 closed 回滚——机制本体，配套前置 = 调用方
 * 已做终态守卫；H1 U2 起唯一活调用面 = Continuation 轮末分流与 SP-5 one-shot 成功，
 * 全部以 status==="running" 入口，构造性保证不会回滚 close 终态化）。
 * record.round += 1（成功失败同计——round = attempt 计数，失败轮不递增会让失败通知
 * 与上一轮成功通知同 dedup key，60s 窗内被吞，设计 D7）。各步骤 best-effort 互不阻断。
 *
 * @param outcome [H1 U2 / D7] 轮终 outcome——result 写入规则按 kind 分流：
 *   成功轮 result = content（chat 域空 content 兜底 "(no output this round)"，
 *   lastError 不混入正文——现行 `roundText || (lastError ? …)` 混入形态退役）；
 *   one-shot 共享调用点恒传 success（行为零变化 G3：空 content → 前值 ?? "(empty)"）。
 *   失败轮 result = 前值 ?? 失败摘要（首轮失败无正文可保则写
 *   "round did not complete: <reason>"——GUI record 视图不被失败污染、renderer
 *   hasRunning 判据 result !== undefined 仍成立），record.lastError 写失败原因；
 *   [T2-③/LC-1] 可达性从 result 字段迁移到通知 outcome（失败通知由调用方承载）。
 */
export async function doFinalizeRoundToIdle(
  deps: FinalizeDeps,
  record: ExecutionRecord,
  outcome: RoundSettlementOutcome,
): Promise<void> {
  // [D7 写入规则] 轮终 result 写入按 outcome.kind 分流（MF-2 承诺不变：record.result
  // 供 notifier idle 回复正文，恒写非空——renderer hasRunning 判据依赖）。
  let nextResult: string | undefined;
  if (outcome.kind === "failed") {
    // 失败轮：前值保真（有最后成功正文则保留），无前值（首轮失败）写失败摘要；
    // lastError 写失败原因（排障面——renderer 在 result 非 undefined 时不显示 error）。
    record.lastError = outcome.reason;
    nextResult = record.result ?? `round did not complete: ${outcome.reason}`;
  } else if (record.chatMode) {
    // chat 成功轮：本轮增量 = content；空 content 兜底 "(no output this round)"
    //（D7 ⑤——统一占位，lastError 失败文案不再混入成功轮正文）。
    nextResult = outcome.content || "(no output this round)";
  } else {
    // one-shot 成功轮（SP-5 共享调用点，G3 行为零变化）：content 或前值 ?? "(empty)"
    //（[R2-1] 轮终写点恒写非空，措辞与 notifier buildLlmContent 的
    // `record.result ?? "(empty)"` 兜底同款，通知文案逐字节不变）。
    nextResult = outcome.content || record.result || "(empty)";
  }
  record.result = nextResult;

  // 删 .alive marker（进程已 SIGTERM 回收）。
  // sessionFile 窗口期可能 undefined（极少——对话模式轮次完成意味着 session 已跑过），
  // 缺失时跳过但仍设内存 idle（重启后磁盘重建会落到 crashed，边界可接受）。
  if (record.sessionFile) {
    try {
      removeAliveMarker(record.sessionFile);
    } catch (err) {
      bestEffort(err, "removeAliveMarker (doFinalizeRoundToIdle)");
    }
  }

  // pending-notifications：进程已死，从活跃后代差集移除（record 留内存不 archive，
  // v4 B-1：record 现为 running-resumable，但 pending 注册的是进程活跃性，进程死了需注销）。
  deps.emitUnregister(record.id, "running");

  // 状态机（v4 B-1）：record 保持 running（旧 idle 折入 running，覆盖 tryTransition 设的 closed，
  // 可冷路径 resume），轮次计数 +1。idleSince 时间戳独立保留供 GC 判据。
  // [S10] closedReason 同步清除：调用方（runAndFinalize catch / MF-6 分支）先 tryTransition
  // 设了 closed+closedReason 再回退 running——不清则 "gc"/"cancelled" 残留在 running record 上，
  // 泄漏进 list 投影与后续 notify 载荷（toNotifyRecord 透传 record.closedReason），让一个
  // 活跃 record 看起来像已被某原因关闭过。
  record.status = "running";
  record.closedReason = undefined;
  record.round = (record.round ?? 0) + 1;
  record.idleSince = Date.now();
  // 执行态信号（residual-fixes）：轮终回 running-resumable = 无活进程驱动（idle timer
  // 回收/保活等待续聊），GUI 侧据此判 waiting（非 streaming）。冷路径续轮（进程启动）清除。
  record.resumable = true;

  // W16 [D4]：轮终回 running-resumable 是类外状态写点（record 留内存不走 archive），
  // 显式上报迁移——entry 携带新 round 与本轮 result，pi 文件的重建源不滞后。
  deps.store.reportRecordTransition(record);

  // [review 修复] 已删除残留 pendingMessages 的 redeliverPending 补投段（MF-1 消费
  // 确认安全网）：三段消费链随 deliverToRunning 一并移除，本段不可达。
}
