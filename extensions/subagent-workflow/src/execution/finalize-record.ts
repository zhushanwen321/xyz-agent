// src/execution/finalize-record.ts
//
// 时序收尾逻辑（从 subagent-service.ts 提取，降低主文件行数 < 1000 上限）。
//
// D-017 时序：collectPatch → completeRecord → archive → cleanup(finalized+worktree+
// aliveMarker+pending注销) → manifest(最后 best-effort)。
//
// [Critical #1 / PR #85] cleanup 全部在 manifest 写之前执行——manifest 是诊断辅助
//（orphan recovery），写失败仅记录不阻断。旧实现 Step 2.5 throw 会跳过 Step 3 cleanup，
// 导致磁盘满/权限错时 worktree 泄漏 + finalized marker 不写 + alive marker 残留 +
// pending 记账错乱。现 manifest 写移到 Step 4（最后），best-effort（console.error +
// appendEntry，不 throw）。
//
// B9 兜底：completeRecord/archive 抛错→后续 cleanup/manifest 仍执行。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
import { completeRecord } from "./execution-record.ts";
import { writeFinalized } from "./finalized-marker.ts";
import type { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import type { RecordStore } from "./record-store.ts";
import { writeCancelledTombstone } from "./tombstone-store.ts";
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
  /** 清节流状态（防 trailing timer 在 record 归档后误发陈旧 onUpdate）。 */
  clearThrottle(id: string): void;
  /** pending-notifications 终态注销（绑定 pi.events.emit，由调用方闭包提供）。 */
  emitUnregister(id: string, status: string): void;
  /**
   * 消费确认制补投回调（MF-1，设计决策 6 spec L251）。doFinalizeRoundToIdle 发现残留
   * pendingMessages（进程退出时未消费的 in-flight 消息）时调用，触发 resumeRound 重开
   * session 补投。调用方（SubagentService）实现为合并消息文本 → resumeRound(record, mergedText)。
   *
   * 调用时机由 doFinalizeRoundToIdle 用 setTimeout(0) 延迟，避免与当前 runAndFinalize 链
   *（含 finally pool.release / .then notify）的时序竞争（TODO 原文标注的时序竞争）。
   * 防递归：补投前已清空 pendingMessages，resume 新轮不再产生本批残留；resume 失败由
   * MF-6 分流保证回退 idle（不销毁），不递归补投。
   */
  redeliverPending?: (record: ExecutionRecord, mergedText: string) => void;
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
  status: "closed" | "cancelled",
  closedReason?: ClosedReason,
): Promise<void> {
  // 终态清节流状态：防 trailing timer 在 record 归档后误发陈旧 onUpdate
  deps.clearThrottle(record.id);

  // ── Step 0: collectPatch（best-effort）──
  // [MF#3] patchFile 写到 worktree 之外（sessionsDir/<branch>.patch），避免被 cleanup 删除；
  //        路径回填 record.patchFile，供调用方（tool result / /subagents list）应用。
  if (record.worktreeHandle) {
    try {
      const sessionsDir = getSubagentSessionDir(
        deps.modelService.getAgentDir(),
        record.worktreeHandle.mainCwd,
      );
      fs.mkdirSync(sessionsDir, { recursive: true });
      const patchFile = path.join(sessionsDir, `${record.worktreeHandle.branch}.patch`);
      const patch = deps.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
      if (patch.written) record.patchFile = patchFile;
    } catch (pe: unknown) {
      bestEffort(pe, "collectPatch (finalizeRecord Step0)");
    }
  }

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

  // ── Step 3: finalized + cleanup + aliveMarker + pending注销（全部先执行，幂等）──
  // [Critical] 清理必须在 manifest 写入之前：worktree cleanup / finalized marker / aliveMarker
  //   都是幂等且不可跳过的副作用。绝不能因 manifest 写失败而跳过 worktree cleanup
  //   （否则 worktree 泄漏）。各件独立 try/catch，互不阻断。
  if (record.sessionFile) {
    try {
      // MF-1 fix: cancelled 状态写 tombstone 而非 finalized，防重建丢失 cancelled
      if (status === "cancelled") {
        writeCancelledTombstone(record.sessionFile, {
          id: record.id,
          status: "cancelled",
          agent: record.agent,
          startedAt: record.startedAt,
          endedAt: record.endedAt ?? Date.now(),
        });
      } else {
        writeFinalized(record.sessionFile);
      }
    } catch (err) {
      bestEffort(err, "writeFinalized/tombstone (finalizeRecord Step3)");
    }
  }
  if (record.worktreeHandle) {
    try {
      deps.worktreeManager.cleanup(record.worktreeHandle);
    } catch (err) {
      bestEffort(err, "worktree cleanup (finalizeRecord Step3)");
    }
  }
  if (record.sessionFile) {
    try {
      removeAliveMarker(record.sessionFile);
    } catch (err) {
      bestEffort(err, "removeAliveMarker (finalizeRecord Step3)");
    }
  }

  // pending-notifications：终态注销（只记 registry 状态，通知由 BgNotifier 发）
  deps.emitUnregister(record.id, status);

  // ── Step 4 (last): manifest 持久化（best-effort，不阻断、不 throw）──
  // [Critical #1] manifest 是诊断辅助（orphan recovery），不是正确性依赖。写失败时
  //   仅记录（console.error + appendEntry），绝不让 manifest 写失败跳过上面的 worktree
  //   cleanup 或抛出打断 finalize 链。旧实现 Step 2.5 throw 会跳过 Step 3 cleanup。
  //   task/slug/model 从 ExecutionRecord 抓取（配合 ManifestRecord 补字段），
  //   manifestToSubagent 投影时用真实值而非硬编码空串。
  try {
    await deps.manifestStore.writeManifest({
      id: record.id,
      rootSessionId: record.rootSessionId ?? "",
      parentRecordId: record.parentRecordId,
      agentName: record.agent,
      // SP-1: manifest status 统一为 closed/cancelled（旧 completed/failed 已合并为 closed）
      status: status === "closed" ? "closed" : "cancelled",
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
 * 对话模式轮次完成收尾：record 进 idle 态（非终态化，等待续聊）。
 *
 * 与 doFinalizeRecord 的关键区别（M2-A idle 语义）：
 *   - 不调 completeRecord（record 不冻结，保留 turns[] 等运行时状态供续聊累积）
 *   - 不调 store.archive（record 留内存，getMutable 可查、list 可见）
 *   - 不 cleanup worktree（保留对话模式工作目录）
 *   - 不写 manifest（idle 非终态，manifest 是终态诊断辅助）
 *   - 写 .idle sidecar（含轮次计数，M3 重建矩阵命中 idle 分支用）
 *   - 删 .alive marker（进程已 SIGTERM 回收，不再是活进程）
 *   - emitUnregister（进程已死，从 pending 活跃后代差集移除；record 留内存不 archive）
 *
 * MF-2：设 record.result = result.text（否则 notifier idle 回复正文恒为 "(empty)"，
 *   G1/G2 多轮回复送达不成立）。失败轮次（result.success=false，MF-6 回退 idle 路径）
 *   的 result.text 可能为空，用 result.error 兜底让 notify 可读。
 *
 * MF-1（设计决策 6 spec L251 消费确认安全网）：进程退出时残留 pendingMessages
 *   一律 resume 补投（不再清除）。残留是极窄竞态（follow_up/steer 在 agent_end 那刻发出，
 *   pi post-run loop 不 drain → 进程 kill 时未消费）。合并残留文本经 redeliverPending 回调
 *   触发 resumeRound 重投，setTimeout(0) 延迟避开与当前 runAndFinalize 链的时序竞争。
 *
 * 状态：record.status = "idle"（覆盖 tryTransition 设的 done/failed），record.round += 1。
 * 各步骤 best-effort 互不阻断（参照 doFinalizeRecord 的 bestEffort 用法）。
 *
 * @param deps 与 doFinalizeRecord 同源（从 SubagentService 注入）
 * @param result 本轮 AgentResult（MF-2：result.text 写入 record.result 供 notifier idle 回复）
 */
export async function doFinalizeRoundToIdle(
  deps: FinalizeDeps,
  record: ExecutionRecord,
  result: AgentResult,
): Promise<void> {
  // 清节流状态：防 trailing timer 在 record idle 后误发陈旧 onUpdate。
  deps.clearThrottle(record.id);

  // MF-2：设 record.result 供 notifier idle 回复正文（否则恒 "(empty)"，G1/G2 不成立）。
  // MF-6 兜底：失败轮次（success=false）的 result.text 可能为空，用 error 让 notify 可读。
  record.result = result.text || (result.error ? `round did not complete: ${result.error}` : record.result);

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
  // 但 pending 注册的是进程活跃性，进程死了需注销）。
  deps.emitUnregister(record.id, "idle");

  // 状态机：record 进 idle（覆盖 tryTransition 设的 done/failed），轮次计数 +1。
  record.status = "idle";
  record.round = (record.round ?? 0) + 1;
  record.idleSince = Date.now();

  // 消费确认制补投（MF-1，设计决策 6 spec L251 安全网）：进程退出时残留 pendingMessages
  // 一律 resume 补投（不再静默清除——清除会让 busy→kill 竞态窗口的消息静默丢失）。
  // 残留是极窄竞态：follow_up/steer 在 agent_end 那刻发出，pi post-run loop 不 drain → 进程
  // kill 时未消费。合并残留文本经 redeliverPending 回调触发 resumeRound 重投。
  //
  // 防递归：清空 pendingMessages 后再投，resume 新轮的 pendingMessages 只来自该轮的 busy
  // 投递，不再含本批；resume 失败由 MF-6 分流保证回退 idle（不销毁），不递归补投。
  // setTimeout(0) 延迟：让当前 runAndFinalize 链（finally pool.release + .then notify）完整
  // 退出后再开新轮，避免 pool release/acquire 时序竞争（TODO 原文标注的时序竞争）。
  if (record.pendingMessages && record.pendingMessages.length > 0) {
    const pending = record.pendingMessages;
    record.pendingMessages = undefined; // 清空：消息转入 resume 重投通道，pendingMessages 不再持有
    const mergedText = pending.map((m) => m.text).join("\n\n");
    getLogger("subagents").warn(
      `[subagents] idle record ${record.id} has ${pending.length} unconsumed pendingMessages (race window: follow_up/steer sent near agent_end, pi did not drain); triggering resume re-delivery`,
      { id: record.id, count: pending.length },
    );
    if (deps.redeliverPending) {
      setTimeout(() => {
        try {
          deps.redeliverPending!(record, mergedText);
        } catch (err) {
          // resume 前置校验 throw（如 status 已被并发改动）→ best-effort 记录，消息已从队列移除
          //（spec 限制声明：排队消息因主 agent 重启/竞态丢失可接受，重发即可）。
          bestEffort(err, "redeliverPending (doFinalizeRoundToIdle resume)");
        }
      }, 0);
    }
  }
}
