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

import { getLogger } from "../core/logger";

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
  /** pending-notifications 终态注销（绑定 pi.events.emit，由调用方闭包提供）。 */
  emitUnregister(id: string, status: string): void;
  // [review 修复] 已删除 redeliverPending 回调（MF-1 消费确认制补投）：pendingMessages
  // 三段消费链随 deliverToRunning 一并移除（无生产调用方，死机制）。
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
      const patch = await deps.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
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
      // MF-1 fix / v4 B-1: cancelled（closedReason='cancelled'）写 tombstone 而非 finalized，防重建丢失 cancelled
      if (closedReason === "cancelled") {
        writeCancelledTombstone(record.sessionFile, {
          id: record.id,
          status: "cancelled",
          agent: record.agent,
          startedAt: record.startedAt,
          endedAt: record.endedAt ?? Date.now(),
        });
      } else {
        // [v8.5 A2] 真实 reason 写入 sidecar 内容（旧格式是空文件）：磁盘重建时用它
        // 还原 closedReason，不再一律硬编码 gc。cancelled 之外的全部原因（gc /
        // user-close / parent-*）都经此路径持久化。
        writeFinalized(record.sessionFile, closedReason);
      }
    } catch (err) {
      bestEffort(err, "writeFinalized/tombstone (finalizeRecord Step3)");
    }
  }
  if (record.worktreeHandle) {
    try {
      await deps.worktreeManager.cleanup(record.worktreeHandle);
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
 * 对话模式轮次完成收尾：record 进 idle 态（非终态化，等待续聊）。
 *
 * 与 doFinalizeRecord 的关键区别（M2-A idle 语义）：
 *   - 不调 completeRecord（record 不冻结，保留 turns[] 等运行时状态供续聊累积）
 *   - 不调 store.archive（record 留内存，getMutable 可查、list 可见）
 *   - 不 cleanup worktree（保留对话模式工作目录）
 *   - 不写 manifest（idle 非终态，manifest 是终态诊断辅助）
 *   - 删 .alive marker（进程已 SIGTERM 回收，不再是活进程）
 *   - emitUnregister（进程已死，从 pending 活跃后代差集移除；record 留内存不 archive）
 *
 * MF-2：设 record.result = result.text（否则 notifier idle 回复正文恒为 "(empty)"，
 *   G1/G2 多轮回复送达不成立）。失败轮次（result.success=false，MF-6 回退 idle 路径）
 *   的 result.text 可能为空，用 result.error 兜底让 notify 可读。
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
  // MF-2：设 record.result 供 notifier idle 回复正文（否则恒 "(empty)"，G1/G2 不成立）。
  // MF-6 兜底：失败轮次（success=false）的 result.text 可能为空，用 error 让 notify 可读。
  // [R2-1] 轮终写点恒写非空：one-shot 空文本成功完成（collectResult getFullText 返回 ""、
  // success=true、真实可达，本写点被 subagent-service runAndFinalize 的成功分支共用）首轮
  // result 前值 undefined，兜底补 "(empty)" 占位——措辞与 notifier buildLlmContent 的
  // `record.result ?? "(empty)"` 兜底同款，通知文案逐字节不变（[增量 G2] G4 取舍保持）。
  // 轮终信号优先：record.result 非 undefined 是 renderer hasRunning 排除「轮终
  // running-resumable」的判据（shared SubagentRecord.result 契约），保持 undefined 会让
  // 完成注入后末位 turn 永久「工作中」。续轮（前值存在）沿用前值：one-shot 无增量语义，
  // record.result = 该 subagent 最终输出。chatMode 空增量轮 → 固定占位
  // "(no output this round)"（D5：增量语义下沿用旧 record.result = 上一轮增量，本轮通知
  // 正文 = 上一轮内容，父 agent 误读为原样重复回复）。
  let nextResult: string | undefined;
  if (result.text) {
    nextResult = result.text;
  } else if (result.error) {
    nextResult = `round did not complete: ${result.error}`;
  } else if (record.chatMode) {
    nextResult = "(no output this round)";
  } else {
    nextResult = record.result ?? "(empty)";
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
