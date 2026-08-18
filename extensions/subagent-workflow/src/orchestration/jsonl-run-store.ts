/**
 * Workflow Extension — JSONL Run Store
 *
 * RunStore port 的 Infra 实现。
 *
 * 职责：持久化 WorkflowRun 聚合根到 JSONL 文件 + 跨 session 重水合。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 RunStore port。
 * 依赖 @earendil-works/pi-coding-agent 的 ExtensionAPI/ExtensionContext（Infra 允许 Pi SDK）。
 *
 * 设计：
 * - JsonlRunStore implements RunStore（而非散落的 persist/reconstruct 自由函数）。
 * - **D-5: 不向后兼容**——reconstruct 时检查 snapshotVersion，无版本号或版本不匹配
 *   的 session 返回空数组（spec 决策：旧 run 历史价值低，不尝试兼容迁移）。
 * - rewrite mode（writeFile 覆盖，文件始终是最新单行快照）。
 * - **W17 [D4] workflow-record 自描述 entry**：每次成功 flush 同步 append 一条完整
 *   快照 entry（pi.appendEntry）——pi 文件（session JSONL）是 workflow 数据持久化
 *   权威，state 文件降级为纯性能缓存（读序 = entry > state 文件 > 空，写路径保留）。
 *   旧 `workflow-state-link` 指针 entry 退役（loadAll 保留兼容读，存量 run 不丢）。
 *
 * save 去抖语义（cw swf-perf wave2）：
 * - **热路径**（running 中间态，本实例已写过）：per-runId pending 批合并——窗口内
 *   N 次 save 只落盘 1 次（serialize-at-flush：写 flush 时刻最新聚合状态）。
 *   固定窗口不重置 timer（批创建时定时一次），保证 flush 延迟有界 ≤saveDebounceMs；
 *   agent-call 间隔秒级下 trailing 重置无合并增益反可无限推迟。
 * - **冷路径**（本实例对该 runId 首写，或 status !== "running" 即 done）：
 *   同步挂链 flush 绕过 timer——首写立即可见（跨 session 重启后 loadAll 从 entry
 *   发现 run）、done 立即落盘（终态优先持久化：transition("done") 后的 save
 *   不进去抖批，去抖窗口内的崩溃不吞终态）。
 * - workflow-record entry 每次成功 flush 都 append（含热路径中间态 flush）——
 *   entry 流 = 落盘历史（最后一条 = 最后一次成功 flush，崩溃丢失边界语义与
 *   state 文件路径一致）；去抖已把 flush 频率控制在与 agent-call 周期同量级。
 * - per-runId 串行 flush 链：同 runId 的 flush 排队顺序执行（不跳过、永不并发
 *   writeFile），链尾吞错防断链——错误只经各 save() Promise 的 settlers 传播。
 * - dispose()：幂等（缓存自身 Promise）；刷全部 pending 批 + await 全部 in-flight
 *   链后返回。dispose 后 save 静默 no-op + debug 日志（session_shutdown 编排收尾）。
 *
 * 序列化策略：
 * - WorkflowRun 是带方法的 class 聚合根——序列化只取公共字段快照。
 * - Budget/Trace/AgentCall 都有公共构造器或 fromArray 工厂，反序列化时重建实例。
 * - Snapshot 形态用 SnapshotVersion 守护（D-5：格式识别）。
 *
 * 参考：domain-models.md §Ports（RunStore 定义）、clarification.md D-5。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { AgentCall } from "./models/agent-call.ts";
import { Budget } from "./models/budget.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type { RunState } from "./models/run-state.ts";
import { Trace } from "./models/trace.ts";
import type { DoneReason, RunStatus, WorkerLogEntry } from "./models/types.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./models/types.ts";
import type { WorkflowRunMeta } from "./models/workflow-run.ts";
import { WorkflowRun } from "./models/workflow-run.ts";

// ── Snapshot format (D-5 version guard) ──────────────────────

/**
 * 快照格式版本。D-5：旧 session（无此字段或值不匹配）被 loadAll 忽略。
 *
 * 版本历史：
 * - wf-run-v1：status 三态（含 paused）、meta 含 pausedAt。
 * - wf-run-v2（当前）：status 两态（running/done）、meta 无 pausedAt（随一次性
 *   生命周期收窄，F6/F8）。v1 文件 loadAll 静默跳过——含 v1 running 残留跳过 =
 *   静默消失不显示，接受（父文档 D-5 边界声明：旧 run 历史价值低，不做兼容迁移）。
 *
 * 升级格式时 bump 此常量并在 deserializeRun 中适配——旧文件返回 null（被 loadAll 跳过）。
 */
export const SNAPSHOT_VERSION = "wf-run-v2" as const;

/**
 * 持久化快照形态——WorkflowRun 公共字段的 JSON 可序列化投影。
 *
 * calls 序列化为数组（Map 不能直接 JSON.stringify）；反序列化时重建 Map。
 * budget/trace 在 deserialize 时重建实例（带方法的 class）。
 */
interface RunSnapshot {
  v: typeof SNAPSHOT_VERSION;
  runId: string;
  spec: RunSpec;
  state: {
    status: RunStatus;
    reason?: DoneReason;
    budget: {
      maxTokens?: number;
      maxCost?: number;
      maxTimeMs?: number;
      usedTokens: number;
      usedCost: number;
      totalCallCount: number;
    };
    calls: Array<{
      id: number;
      opts: AgentCallOpts;
      status: "pending" | "running" | "done";
      attempts: number;
      result?: AgentResult;
      sessionId?: string;
      sessionFile?: string;
      traceNode: ExecutionTraceNode;
    }>;
    trace: ExecutionTraceNode[];
    errorLogs: WorkerLogEntry[];
    error?: string;
    scriptResult?: unknown;
  };
  meta: {
    startedAt: string;
    completedAt?: string;
    workerErrorCount?: number;
    scriptErrorCount?: number;
  };
}

// ── Workflow-record self-describing entry (W17, D4) ─────────

/**
 * 自描述 workflow record entry 的 customType（W17 [D4]）。命名对齐 W16 的
 * `subagent-record`（连字符风格）。写点字面量与本常量的等值由
 * __tests__/jsonl-run-store-session-file.test.ts 断言钉住（消费方引用本常量，勿用裸字符串）。
 */
export const WORKFLOW_RECORD_CUSTOM_TYPE = "workflow-record";

/**
 * `workflow-record` entry 的 data schema（v1）。
 *
 * = 完整 RunSnapshot 快照（runId/status/calls/trace 等全部重建需要的字段）+ 版本号。
 * 读取方无需逆向解析 state 文件或指针（D4 自描述原则）；snapshot 内部自带 D-5
 * snapshotVersion guard（deserializeRun 检查），entry 层 v 与 snapshot 层 v 是两级
 * 独立版本（entry schema 演化 vs 快照格式演化）。
 */
export interface WorkflowRecordEntryData {
  /** schema 版本（W17 起 v1）。消费方按 v 判别解析，不认识的版本跳过而非猜测。 */
  v: 1;
  /** 完整 RunSnapshot（与同次 flush 写入 state 文件的内容是同一份，不二次序列化）。 */
  snapshot: RunSnapshot;
  /** append 时刻 ISO 时间（诊断用；重建不依赖）。 */
  updatedAt: string;
}

/** 已序列化快照 → 自描述 entry data（doFlush 消费同一 snapshot，保证 entry 与 state 文件一致）。 */
function toWorkflowRecordEntryData(snapshot: RunSnapshot): WorkflowRecordEntryData {
  return { v: 1, snapshot, updatedAt: new Date().toISOString() };
}

// ── Serialization ────────────────────────────────────────────

function serializeRun(run: WorkflowRun): RunSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    runId: run.runId,
    spec: run.spec,
    state: {
      status: run.state.status,
      reason: run.state.reason,
      budget: {
        maxTokens: run.state.budget.maxTokens,
        maxCost: run.state.budget.maxCost,
        maxTimeMs: run.state.budget.maxTimeMs,
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost,
        totalCallCount: run.state.budget.totalCallCount,
      },
      calls: Array.from(run.state.calls.values()).map((c) => {
        // strip live（同 trace 序列化，不持久化运行期对象）
        const { live: _live, ...traceNodeRest } = c.traceNode;
        return {
          id: c.id,
          opts: c.opts,
          status: c.status,
          attempts: c.attempts,
          result: c.result,
          sessionId: c.sessionId,
          sessionFile: c.sessionFile,
          traceNode: traceNodeRest,
        };
      }),
      // trace 节点浅拷贝时 strip live 字段——ExecutionRecord 含可变 turns[]/controller，
      // 不适合序列化；live 是运行期对象（done 时由 dispatchAgentCall 清除，重跑时重建）。
      trace: run.state.trace.toArray().map(({ live: _live, ...rest }) => rest),
      errorLogs: run.state.errorLogs,
      error: run.state.error,
      scriptResult: run.state.scriptResult,
    },
    meta: run.meta,
  };
}

/**
 * 反序列化快照为 WorkflowRun。D-5：版本不匹配返回 null（旧 session）。
 */
function deserializeRun(snapshot: RunSnapshot): WorkflowRun | null {
 // D-5 version guard
  if (snapshot.v !== SNAPSHOT_VERSION) return null;

  const budget = new Budget({
    maxTokens: snapshot.state.budget.maxTokens,
    maxCost: snapshot.state.budget.maxCost,
    maxTimeMs: snapshot.state.budget.maxTimeMs,
    usedTokens: snapshot.state.budget.usedTokens,
    usedCost: snapshot.state.budget.usedCost,
  });
  budget.totalCallCount = snapshot.state.budget.totalCallCount;

  const calls = new Map<number, AgentCall>();
  for (const c of snapshot.state.calls) {
    const call = new AgentCall(c.id, c.opts, c.traceNode);
    call.status = c.status;
    call.attempts = c.attempts;
 // Restore result directly — bypasses markRunning/markDone state-machine guards
 // because we're reconstructing a known-good persisted state, not transitioning.
    if (c.result !== undefined) {
      call.result = c.result;
    }
    if (c.sessionId !== undefined) {
      call.setSessionId(c.sessionId);
    }
    if (c.sessionFile !== undefined) {
      call.setSessionFile(c.sessionFile);
    }
    calls.set(c.id, call);
  }

  const trace = Trace.fromArray(snapshot.state.trace);

  const state: RunState = {
    status: snapshot.state.status,
    reason: snapshot.state.reason,
    budget,
    calls,
    trace,
    errorLogs: snapshot.state.errorLogs,
    error: snapshot.state.error,
    scriptResult: snapshot.state.scriptResult,
  };

  const meta: WorkflowRunMeta = {
    startedAt: snapshot.meta.startedAt,
    completedAt: snapshot.meta.completedAt,
    workerErrorCount: snapshot.meta.workerErrorCount,
    scriptErrorCount: snapshot.meta.scriptErrorCount,
  };

 // WorkflowRun.reconstruct 跳过 I1 校验——持久化的 running 状态没有 worker
 // （进程被杀后 worker 不可能还活着），违反 I1。D-4 kill-9 恢复在 session_start
 // 时把残留 running 转 done,failed，恢复 I1（见 index.ts session_start handler）。
  return WorkflowRun.reconstruct(snapshot.runId, snapshot.spec, state, meta);
}

// ── JsonlRunStore ────────────────────────────────────────────

/** Node fs 错误 code 判定（ENOENT = 路径不存在，并发删除场景）。 */
function isEnoentError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}

const logger = getLogger("subagents");

/**
 * save 去抖窗口默认值（ms）。区间 100-250 内取值——agent-call 间隔秒级，
 * 200ms 足以合并同一 call 周期内的多次状态 mutation，又不至于让崩溃窗口
 * （未 flush 的 running 尾部丢失，等价崩溃链由 kill-9 恢复收编）明显放大。
 * export 供测试边界构造（对齐 TRACE_RESULT_MAX_CHARS export 先例）。
 */
export const DEFAULT_SAVE_DEBOUNCE_MS = 200;

/**
 * per-runId 去抖批。窗口内 N 次 save 合并：latestRun 保留最新聚合引用
 * （serialize-at-flush），settlers 收集批内全部 save() 调用方的 settle 回调。
 */
interface PendingSaveBatch {
  latestRun: WorkflowRun;
  /**
   * 批的去抖 timer（构造时即确定——经 {@link JsonlRunStore.armPendingBatch} 工厂
   * 内联组装，timer 与批对象在同一同步段成型，类型上不存在「先构造后赋值」的
   * 可选窗口）。
   */
  timer: NodeJS.Timeout;
  settlers: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
}

export interface JsonlRunStoreOptions {
  /** Session directory root (state files live under <sessionDir>/workflow-state/). */
  sessionDir: string;
  /** Pi ExtensionAPI for workflow-record appendEntry writes (optional for testing). */
  pi?: ExtensionAPI;
  /** Pi ExtensionContext for sessionManager.getEntries (optional for testing). */
  ctx?: ExtensionContext;
  /** save 去抖窗口（ms），默认 {@link DEFAULT_SAVE_DEBOUNCE_MS}。 */
  saveDebounceMs?: number;
}

export class JsonlRunStore {
  private readonly sessionDir: string;
  private readonly pi?: ExtensionAPI;
  private readonly ctx?: ExtensionContext;
  private readonly saveDebounceMs: number;
  /** per-runId 去抖批（热路径）。 */
  private readonly pending = new Map<string, PendingSaveBatch>();
  /** 本实例已至少成功发起过一次 flush 的 runId（冷/热路径判据）。 */
  private readonly writtenOnce = new Set<string>();
  /**
   * per-runId 串行 flush 链。同 runId 的 flush 排队顺序执行（排队不跳过——
   * 跳过会丢最新状态且打破后写覆盖前写的单调性），不同 runId 互不阻塞。
   * 链条目 settle 后不清理：runId 数量有界、生命周期短于 store，惰性清理
   * 与排队写入存在竞态——取舍为每 runId 残留一个 settled Promise 引用，可忽略。
   */
  private readonly chains = new Map<string, Promise<void>>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(opts: JsonlRunStoreOptions) {
    this.sessionDir = opts.sessionDir;
    this.pi = opts.pi;
    this.ctx = opts.ctx;
    this.saveDebounceMs = opts.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
  }

  /** State directory: <sessionDir>/workflow-state/ */
  private get stateDir(): string {
    return path.join(this.sessionDir, "workflow-state");
  }

  /** State file path for a given runId. */
  private filePathFor(runId: string): string {
    return path.join(this.stateDir, `${runId}.jsonl`);
  }

  /** Public accessor: run 状态快照文件绝对路径（RunStore port 实现）。 */
  stateFilePath(runId: string): string {
    return this.filePathFor(runId);
  }

  /**
   * Persist a single run: rewrite mode (overwrite) — file always contains the
   * latest complete snapshot on a single line.
   *
   * 去抖路由：
   * - 冷路径（本实例首写，或 status !== "running"）→ 立即挂链 flush（绕过 timer），
   *   回滚资格 = 首写（flush 失败时 doFlush 回滚 writtenOnce，下次 save 重走冷路径）；
   * - 热路径（running 且已写过）→ 并入 per-runId 去抖批（固定窗口不重置 timer）。
   *
   * Promise 语义：本批实际落盘后 resolve（同批多次调用共享 settle）；IO 错误
   * （非 ENOENT）reject 本批全部调用方；ENOENT 静默 resolve（工作目录已被清理，
   * 持久化无意义也无法完成——见 doFlush）。
   */
  async save(run: WorkflowRun): Promise<void> {
    // R5 处置：dispose 后（session_shutdown 收尾后 in-flight 链的迟到 save）静默
    // no-op + debug 留痕。不复活同步 flush——单向闸门状态机简单；此时 run 是
    // running 落盘无增益（kill-9 恢复同样转 done,failed），终态 reason 保真损失极窄。
    if (this.disposed) {
      logger.debug(
        `[subagent-workflow] jsonl-run-store save after dispose: silently dropped (runId=${run.runId})`,
      );
      return;
    }

    const runId = run.runId;
    const isFirstWrite = !this.writtenOnce.has(runId);
    const isCold = isFirstWrite || run.state.status !== "running";
    if (isCold) {
      // 判定即记录：原子防并发双冷（两次并发首写都判 true 会各 flush 一次 entry）。
      // ENOENT 边界：首写 flush 遇 ENOENT 时 entry 未写但 writtenOnce 已记——
      // sessionDir 已删场景持久化无意义，接受（非 ENOENT 失败由 doFlush 回滚，重走冷路径）。
      this.writtenOnce.add(runId);
      // 原子取走 pending 批（终态与最后一个 agent-call 的 debounced save 交错时，
      // pending 批 settlers 并入本次同步 flush 的批合并 settle，timer 取消防二次写）。
      const batch = this.pending.get(runId);
      if (batch) {
        clearTimeout(batch.timer);
        this.pending.delete(runId);
      }
      return this.enqueueFlush(runId, run, batch ? batch.settlers : [], isFirstWrite);
    }

    // 热路径：running 中间态，并入去抖批
    const existing = this.pending.get(runId);
    if (existing) {
      // latestRun 更新（固定窗口不重置 timer——flush 延迟有界 ≤saveDebounceMs）
      existing.latestRun = run;
      return new Promise<void>((resolve, reject) => {
        existing.settlers.push({ resolve, reject });
      });
    }
    const settlers: PendingSaveBatch["settlers"] = [];
    const promise = new Promise<void>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
    this.pending.set(runId, this.armPendingBatch(runId, run, settlers));
    return promise;
  }

  /**
   * 构造去抖批（[review 修复] 工厂内联组装：timer 与批对象在同一同步段成型，
   * PendingSaveBatch.timer 保持非可选——消除「批先构造、timer 后赋值」靠注释维持
   * 的可选窗口）。timer 回调闭包经局部 batch 变量持批引用做身份守卫（ES3）。
   */
  private armPendingBatch(
    runId: string,
    run: WorkflowRun,
    settlers: PendingSaveBatch["settlers"],
  ): PendingSaveBatch {
    // timer 回调闭包经下方 const batch 持批引用做身份守卫——前向引用在运行时安全：
    // 回调最早 saveDebounceMs 后才执行，届时 batch 已在本同步段尾部初始化完毕。
    const timer = setTimeout(() => {
      // ES3 幂等守卫（批身份比较）：回调闭包持自身批引用，与 pending Map 现值做
      // 身份比较而非仅按键存在性判断。除「批已被冷路径/flushPendingSaves/dispose
      // 原子取走（clearTimeout 与回调触发在 fake timers 下可能交错）」的交接语义外，
      // 还防「旧 timer 撞新批」交错：本批被取走后同 runId 的新批已入 Map 时，若只看
      // 键存在性，旧 timer 会误取走新批提前 flush（缩短新批去抖窗口）。身份不匹配
      // 直接 return，批由取走方负责 flush。
      if (this.pending.get(runId) !== batch) return;
      this.pending.delete(runId);
      // 孤儿 Promise（无调用方持有）：错误只经 settlers 传播给 save() 调用方，
      // 此处 catch 防止 unhandled rejection。
      this.enqueueFlush(runId, batch.latestRun, batch.settlers, false).catch(() => {});
    }, this.saveDebounceMs);
    // DS5：timer 必须 unref——不 unref 会钉住空转的 extension 进程不退出。
    timer.unref();
    const batch: PendingSaveBatch = { latestRun: run, timer, settlers };
    return batch;
  }

  /**
   * 把一次 flush 排到 runId 的串行链尾。调用方 Promise（本函数返回值）与传入
   * settlers 由同一次 doFlush 独占 settle 一次。
   */
  private enqueueFlush(
    runId: string,
    run: WorkflowRun,
    settlers: PendingSaveBatch["settlers"],
    rollbackFirstWrite: boolean,
  ): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });
    // 排队不跳过：前一 flush in-flight 时本次挂链尾顺序执行，同 runId 永不并发
    // writeFile（整文件覆盖写并发会互相截断）。链尾吞错防断链——错误只经 settlers 传播。
    const next = (this.chains.get(runId) ?? Promise.resolve())
      .then(() => this.doFlush(runId, run, settlers, rollbackFirstWrite))
      .catch(() => {});
    this.chains.set(runId, next);
    return promise;
  }

  /**
   * 实际落盘（在 runId 串行链上执行）。settlers 由本函数独占 settle 一次：
   * 成功或 ENOENT 全 resolve，其他错误全 reject。
   */
  private async doFlush(
    runId: string,
    run: WorkflowRun,
    settlers: PendingSaveBatch["settlers"],
    rollbackFirstWrite: boolean,
  ): Promise<void> {
    const filePath = this.filePathFor(runId);
    try {
      // 兜底容错：run 工作目录（sessionDir）已被清理时，mkdir 抛 ENOENT，放弃持久化。
      // 竞态场景（review-fix-loop-e2e 等 runAndWait 测试）：handleReturn 内
      // run.transition("done") 同步改 status 后，runAndWait 轮询发现 done 并 resolve，
      // 测试 afterEach 随即 rmSync 删除 sessionDir；此时 in-flight 的 mkdir
      // 遇到目录链已删除 → ENOENT（{recursive:true} 在并发 rmSync 下仍可抛 ENOENT）。
      // run 既已终态（状态不再变化），持久化无意义也无法完成 → settle resolve。
      // 仅容错 ENOENT，其他错误（EACCES/ENOSPC 等真实磁盘问题）reject 不掩盖。
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      } catch (err) {
        if (isEnoentError(err)) {
          for (const s of settlers) s.resolve();
          return;
        }
        throw err;
      }
      // serialize-at-flush：写 flush 时刻的最新聚合状态（latestRun 语义）
      const snapshot = serializeRun(run);
      await fs.promises.writeFile(filePath, JSON.stringify(snapshot) + "\n", "utf8");
      // W17 [D4]：每次成功 flush 同步 append 自描述 workflow-record entry（同一份
      // snapshot，entry 与 state 文件内容一致）。pi 文件是 workflow 数据持久化权威
      //（loadAll 优先从 entry 重建），state 文件降级纯性能缓存。pi 未注入（测试）时跳过。
      this.pi?.appendEntry(
        WORKFLOW_RECORD_CUSTOM_TYPE,
        toWorkflowRecordEntryData(snapshot),
      );
      for (const s of settlers) s.resolve();
    } catch (err) {
      // ES9 失败回滚（热路径 flush 也会写 entry，回滚的意义收敛为「下次 save 重走
      // 冷路径立即重试」——不再有旧指针形态下「热路径永不写 entry → run 对重启
      // 不可见」的窗口）。堵住首写失败后还得等去抖窗的恢复延迟。
      // 残余窗口（已知接受）：回滚后若再无任何 save（随即崩溃/退出），entry 与
      // state 文件双双缺失——等价崩溃丢失，由 kill-9 恢复兜底。
      if (rollbackFirstWrite) {
        this.writtenOnce.delete(runId);
      }
      for (const s of settlers) s.reject(err);
    }
  }

  /**
   * 立即刷全部 pending 去抖批（测试与排查的备用手段）。自身恒 resolve——IO 错误
   * 已由各 save() Promise 的 settlers 传播给调用方。store 保持可用：不动 disposed
   * 标志，后续 save 正常进入新去抖批。
   */
  async flushPendingSaves(): Promise<void> {
    const flushes: Promise<void>[] = [];
    for (const [runId, batch] of Array.from(this.pending.entries())) {
      clearTimeout(batch.timer);
      this.pending.delete(runId);
      flushes.push(this.enqueueFlush(runId, batch.latestRun, batch.settlers, false));
    }
    await Promise.allSettled(flushes);
  }

  /**
   * 收尾：刷全部 pending 批 + 停 timer + await 全部 in-flight 链（in-flight flush
   * 完成后才返回），此后 save 静默 no-op。
   *
   * 幂等：dispose 缓存自身 Promise——首次未完成时并发交叠进入的后续调用返回
   * 同一 Promise（「dispose 返回 = 全部 flush 已落盘」对每个调用方都成立，
   * 无第二次拿到立即 resolve 的空 Promise 瑕疵）。故本方法不能是 async 函数
   * （async 总是创建新 Promise 破坏同一引用保证）。
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    // 同步置位：阻断新 save 进入去抖/冷路径（R5 no-op 分支接住 shutdown 后
    // in-flight 链的迟到 save）。doDispose 被调用后同步执行到第一个 await 前。
    this.disposed = true;
    const flushes: Promise<void>[] = [];
    for (const [runId, batch] of Array.from(this.pending.entries())) {
      clearTimeout(batch.timer);
      this.pending.delete(runId);
      flushes.push(this.enqueueFlush(runId, batch.latestRun, batch.settlers, false));
    }
    await Promise.allSettled(flushes);
    // await 全部 in-flight 链（ES4：flush 全部落定后才返回）
    await Promise.allSettled(Array.from(this.chains.values()));
  }

 /**
 * Reconstruct all runs（W17 [D4] 读序 = workflow-record entry > state 文件 > 空）。
 *
 * 1. 优先扫描自描述 `workflow-record` entry（重建源——同一 runId 多条时最后一条
 *    胜出，等价「最后一次成功 flush」）。entry 层 v1 guard：不认识的版本跳过而非
 *    猜测；snapshot 层 D-5 snapshotVersion guard 保持（版本不匹配 → deserializeRun
 *    返回 null → 跳过，不做兼容迁移）。
 * 2. 旧 `workflow-state-link` 指针 entry 兼容读取（优先级低——存量 run 不静默
 *    丢失，父文档 #9 踩坑）：entry 未覆盖的 runId 经指针读 state 文件最后行。
 *
 * 需要 ctx（构造时注入）——无 ctx 时返回空（测试或非 Pi 环境下）。
 */
  async loadAll(): Promise<WorkflowRun[]> {
    if (!this.ctx) return [];
    const runs: WorkflowRun[] = [];
    try {
      const entries = this.ctx.sessionManager.getEntries();
      const recordRuns = new Map<string, WorkflowRun>();
      const pointers = new Map<string, { path: string }>();

      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        if (entry.customType === WORKFLOW_RECORD_CUSTOM_TYPE) {
          // v1 entry guard：schema 版本不认识 → 跳过（不猜测解析）
          const data = entry.data as WorkflowRecordEntryData | undefined;
          if (data?.v !== 1 || !data.snapshot) continue;
          const run = deserializeRun(data.snapshot);
          // D-5: null = old snapshot format / version mismatch — skip silently
          if (run) recordRuns.set(run.runId, run); // 后写覆盖 = 最后一条 entry 胜出
        } else if (entry.customType === "workflow-state-link") {
          // 旧指针形态（W17 前写入）：仅作 state 文件的发现通道
          const data = entry.data as { runId?: string; path?: string } | undefined;
          if (data?.runId && data?.path) {
            pointers.set(data.runId, { path: data.path });
          }
        }
      }

      // 1) 自描述 entry 重建（优先——pi 文件是持久化权威）
      runs.push(...recordRuns.values());

      // 2) 旧 link 指针 → state 文件兼容（entry 已覆盖的 runId 跳过——link 优先级低）
      for (const [runId, pointer] of pointers) {
        if (recordRuns.has(runId)) continue;
        try {
          const content = await fs.promises.readFile(pointer.path, "utf8");
          const lines = content.split("\n").filter((l) => l.trim());
          const lastLine = lines[lines.length - 1];
          if (!lastLine) continue;
          const parsed = JSON.parse(lastLine) as RunSnapshot;
          const run = deserializeRun(parsed);
 // D-5: null = old format / version mismatch — skip silently
          if (run) runs.push(run);
        } catch (err) {
 // Corrupt/unreadable state file — skip (don't crash loadAll).
 // Single bad file must not abort reconstruction of the rest.
          void err;
        }
      }
    } catch (err) {
 // getEntries failed — return what we have (empty).
      void err;
    }
    return runs;
  }
}
