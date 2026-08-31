// src/orchestration/file-run-store.ts
//
// RunStore port 的通用文件实现（D2 设计件——zsw 回接 host-surface 单元）。
//
// 为什么需要它：pi 壳的 JsonlRunStore 深耦合 pi session（appendEntry /
// sessionManager，经 pi SDK 落盘 session JSONL），zcode 侧宿主没有这两个设施，
// 无法复用。RunStore port 早在 ports.ts 定义却只有 pi 一份 Infra 实现——本文件
// 补上「宿主无关」的第二份实现，双宿主的 workflow state 持久化从此同源（消灭
// 失败模式 B：行为不一致各自修）。
//
// 落盘布局：<dataRoot>/workflow-state/<runId>.jsonl（D2 规定，与 pi 壳
// <sessionDir>/workflow-state/<runId>.jsonl 同名分量、锚点不同：pi 锚 session，
// 本实现锚宿主数据根——zcode 宿主无 session dir 概念，daemon 重启后按 dataRoot
// 重水合孤儿 run）。
//
// dataRoot 通道选型：直接走 getHostServices().dataRoot()（core/host-services.ts），
// 不用 getEngineDataDir（engine/common/data-dir.ts）——后者是引擎 journal/隔离池
// 通道，带 XYZ_AGENT_DATA_DIR env 优先 + warn-once 语义（xyz-agent 宿主注入专用）；
// workflow run 快照是宿主编排状态，语义归属宿主数据根本身，宿主 configureCore
// 注入什么就落什么，不引入第二条 env 覆盖链。

import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getHostServices } from "../core/host-services.ts";
import { getLogger } from "../core/logger.ts";
import { AgentCall } from "./models/agent-call.ts";
import { Budget } from "./models/budget.ts";
import type { RunStore } from "./models/ports.ts";
import type { RunSpec } from "./models/run-spec.ts";
import type { RunStatus, DoneReason, WorkerLogEntry, ExecutionTraceNode, AgentCallOpts, AgentResult } from "./models/types.ts";
import { Trace } from "./models/trace.ts";
import { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkflowRunMeta } from "./models/workflow-run.ts";

const logger = getLogger("file-run-store");

/** run 状态目录名（<dataRoot> 下的固定分量）。 */
const STATE_DIR_NAME = "workflow-state";

// ── 磁盘保留（C1，语义对齐 pi jsonl-run-store mtime 裁剪） ─────────

/** run state 文件名 glob：runId 形如 `wf-<ts>-<rand>`（lifecycle.ts 生成），只删命中者。
 *  同目录可能存在的非 state 文件永不碰（对齐 pi STATE_FILE_GLOB）。 */
const STATE_FILE_GLOB = /^wf-.*\.jsonl$/;

/** Node fs 错误 code 判定（ENOENT = 路径不存在，并发删除场景；对齐 pi isEnoentError）。 */
function isEnoentError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: unknown }).code === "ENOENT";
}

// ── 快照形状（一行 JSON） ────────────────────────────────────

/** Budget 实例的可序列化投影——Budget 构造 opts 同形，重水合直接 new Budget(...)。 */
interface BudgetSnapshot {
  maxTokens?: number;
  maxCost?: number;
  maxTimeMs?: number;
  usedTokens: number;
  usedCost: number;
  totalCallCount: number;
}

/**
 * AgentCall 实例的可序列化投影。traceNode 整体落盘（与 pi 壳 JsonlRunStore 同构：
 * 节点引用不可序列化，落盘值拷贝；重水合后 D-10「引用共享」仅 live append 路径
 * 成立——Trace.fromArray 注释先例），stepIndex 用于重水合时回链 Trace 副本。
 */
interface CallSnapshot {
  id: number;
  opts: AgentCallOpts;
  status: "pending" | "running" | "done";
  attempts: number;
  result?: AgentResult;
  sessionId?: string;
  sessionFile?: string;
  traceNode: ExecutionTraceNode;
}

/** 一次 save 追加的整行快照（JSONL 单行，全量而非增量）。 */
interface RunSnapshot {
  runId: string;
  spec: RunSpec;
  state: {
    status: RunStatus;
    reason?: DoneReason;
    budget: BudgetSnapshot;
    calls: CallSnapshot[];
    trace: ExecutionTraceNode[];
    errorLogs: WorkerLogEntry[];
    error?: string;
    scriptResult?: unknown;
  };
  meta: WorkflowRunMeta;
}

// ── 序列化 / 重水合 ─────────────────────────────────────────

/** Budget 实例 → 快照投影（构造 opts 同形，字段一一对应）。 */
function toBudgetSnapshot(b: Budget): BudgetSnapshot {
  return {
    maxTokens: b.maxTokens,
    maxCost: b.maxCost,
    maxTimeMs: b.maxTimeMs,
    usedTokens: b.usedTokens,
    usedCost: b.usedCost,
    totalCallCount: b.totalCallCount,
  };
}

/** WorkflowRun → 单行快照。runtime 不落盘（worker/controller/timer 不可序列化且
 *  跨进程必死——重水合语义见 WorkflowRun.reconstruct 注释）；spec.budgetRef 剔除
 *  （运行时共享引用是进程内优化，非持久化数据；重水合后 budget 从 state.budget
 *  独立重建，嵌套 run 的预算共享不跨进程存活）。 */
function toSnapshot(run: WorkflowRun): RunSnapshot {
  const { budgetRef: _budgetRef, ...spec } = run.spec;
  return {
    runId: run.runId,
    spec,
    state: {
      status: run.state.status,
      reason: run.state.reason,
      budget: toBudgetSnapshot(run.state.budget),
      calls: Array.from(run.state.calls.values(), (c) => ({
        id: c.id,
        opts: c.opts,
        status: c.status,
        attempts: c.attempts,
        result: c.result,
        sessionId: c.sessionId,
        sessionFile: c.sessionFile,
        traceNode: c.traceNode,
      })),
      trace: [...run.state.trace.toArray()],
      errorLogs: run.state.errorLogs,
      error: run.state.error,
      scriptResult: run.state.scriptResult,
    },
    meta: run.meta,
  };
}

/** 快照 → WorkflowRun 重水合。形状校验失败返回 undefined（调用方按损坏行处理）。 */
function fromSnapshot(snap: unknown): WorkflowRun | undefined {
  if (snap === null || typeof snap !== "object") return undefined;
  const s = snap as Partial<RunSnapshot>;
  if (typeof s.runId !== "string" || !s.runId) return undefined;
  if (!s.spec || typeof s.spec !== "object") return undefined;
  const st = s.state;
  if (!st || typeof st !== "object") return undefined;
  if (st.status !== "running" && st.status !== "done") return undefined;
  if (!st.budget || typeof st.budget !== "object") return undefined;
  if (!Array.isArray(st.calls) || !Array.isArray(st.trace)) return undefined;
  if (!s.meta || typeof s.meta !== "object") return undefined;

  // Trace 先重建：calls 的 traceNode 回链到 Trace 副本（D-10 尽力恢复——
  // fromArray 拷贝节点，按 stepIndex 匹配使 call.traceNode 与 trace.nodes
  // 共享同一副本引用；匹配不到（快照数据漂移）退化为独立浅拷贝，仅保构造不炸。
  const trace = Trace.fromArray(st.trace);
  const calls = new Map<number, AgentCall>();
  for (const c of st.calls) {
    if (c === null || typeof c !== "object" || typeof c.id !== "number") continue;
    const linked =
      trace.toArray().find((n) => n.stepIndex === c.traceNode?.stepIndex) ??
      (c.traceNode ? { ...c.traceNode } : undefined);
    if (!linked) continue; // traceNode 缺失的残缺 call 条目跳过，不炸整个 run
    const call = new AgentCall(c.id, c.opts, linked);
    call.status = c.status;
    call.attempts = c.attempts;
    if (c.result !== undefined) call.result = c.result;
    if (c.sessionId !== undefined) call.sessionId = c.sessionId;
    if (c.sessionFile !== undefined) call.sessionFile = c.sessionFile;
    calls.set(c.id, call);
  }

  return WorkflowRun.reconstruct(
    s.runId,
    s.spec,
    {
      status: st.status,
      reason: st.reason,
      budget: new Budget(st.budget),
      calls,
      trace,
      errorLogs: Array.isArray(st.errorLogs) ? st.errorLogs : [],
      error: st.error,
      scriptResult: st.scriptResult,
    },
    s.meta,
  );
}

// ── FileRunStore ────────────────────────────────────────────

/**
 * RunStore port 的宿主无关文件实现（port 见 models/ports.ts）。
 *
 * - save：append-only——每次状态变更追加一行全量快照（不覆写；崩溃时旧快照仍在，
 *   loadAll 取最后一条有效行即可恢复到崩溃前最后一致状态）。
 * - loadAll：扫 <dataRoot>/workflow-state/*.jsonl，每文件从尾向头取第一条形状
 *   有效的快照行；损坏行（JSON.parse 失败 / 形状校验不过）跳过并 warn——单行
 *   损坏不拖垮整个 run 的恢复（与 pi 壳 kill-9 恢复同容忍度）。
 * - stateFilePath：纯路径计算（<dataRoot>/workflow-state/<runId>.jsonl），不建目录。
 *
 * 未 configureCore 即 save/loadAll 会抛 core_host_not_configured（dataRoot 端口
 * 语义，host-services.ts §3.4）——宿主壳必须在初始化最早期注入。
 */
export class FileRunStore implements RunStore {
  /** run 状态目录绝对路径（dataRoot 每次现取——宿主覆盖配置即刻生效，对齐
   *  data-dir.ts「不缓存路径防测试/宿主切换读到旧值」先例）。 */
  private stateDir(): string {
    return join(getHostServices().dataRoot(), STATE_DIR_NAME);
  }

  stateFilePath(runId: string): string {
    return join(this.stateDir(), `${runId}.jsonl`);
  }

  async save(run: WorkflowRun): Promise<void> {
    // mkdir recursive 每次 save 前执行：幂等零成本（目录已存在时仅一次 stat），
    // 且免「构造时预建」——构造时建会在宿主尚未 configureCore 的窗口抛错。
    await mkdir(this.stateDir(), { recursive: true });
    const line = JSON.stringify(toSnapshot(run));
    await appendFile(this.stateFilePath(run.runId), line + "\n", "utf8");
  }

  async loadAll(): Promise<WorkflowRun[]> {
    let files: string[];
    try {
      files = await readdir(this.stateDir());
    } catch {
      // 目录不存在 = 从未持久化过（首启/干净环境），空集是正常态不是错误。
      return [];
    }

    const runs: WorkflowRun[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const run = await this.loadLatestValidLine(join(this.stateDir(), file), file);
      if (run) runs.push(run);
    }
    return runs;
  }

  /** 单文件从尾向头取第一条有效快照行；整文件无有效行返回 undefined（warn）。 */
  private async loadLatestValidLine(absPath: string, display: string): Promise<WorkflowRun | undefined> {
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[file-run-store] skip unreadable state file ${display}: ${msg}`);
      return undefined;
    }

    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue; // 尾部空行（末行 \n 产物）静默跳过
      const run = this.parseLine(line, display, i);
      if (run) return run;
      // 损坏行 warn 后继续向前找——最后一条「有效」行可能早于文件尾部（半行写入崩溃）
    }
    logger.warn(`[file-run-store] no valid snapshot line in ${display} (empty or all corrupted)`);
    return undefined;
  }

  /** 单行解析 + 形状校验；损坏 warn 并返回 undefined。 */
  private parseLine(line: string, display: string, lineNo: number): WorkflowRun | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[file-run-store] skip corrupted line ${display}:${lineNo}: ${msg}`);
      return undefined;
    }
    const run = fromSnapshot(parsed);
    if (run === undefined) {
      logger.warn(`[file-run-store] skip malformed snapshot ${display}:${lineNo} (shape validation failed)`);
      return undefined;
    }
    return run;
  }

  /**
   * 把 workflow-state 目录裁剪到上限个最新 state 文件（mtime 升序删最旧，C1）。
   *
   * 语义对齐 pi jsonl-run-store.pruneStateFilesBeyondCap（逐段同构）：
   * - 只删本目录内命中 {@link STATE_FILE_GLOB} 的文件；任何失败都不抛（清理是
   *   旁路维护，不能拖垮持久化主链路）：readdir 失败静默放弃本轮（ENOENT =
   *   从未持久化，正常态），单个 unlink 失败（非 ENOENT）warn 留证后继续删
   *   其余——ENOENT 视为并发删除竞态下的已达成目标，不告警；
   * - stat 全集取 mtime，allSettled 部分降级——单文件 stat 失败（并发删除
   *   ENOENT 等）静默跳过该文件，不阻断本轮裁剪。
   *
   * 上限解析（envName 通道，对齐 pi getEnvStateMaxRuns 解析规则）：
   * - `envName` 提供 → opt-in 通道：`process.env[envName]` 未设/空/非有限数/≤0
   *   → no-op（**默认关**，pi B1 opt-in 语义）；设了有限正数 → 上限 = env 值
   *   （env 值即上限，对齐 pi env 语义）；
   * - `envName` 缺省 → 无 env 通道，直接按 `max` 参数裁剪（上限 = max，调用方
   *   自管启用时机）。
   *
   * 本方法只做磁盘裁剪，不动内存 runs Map（内存侧淘汰归
   * lifecycle.evictDoneRunsBeyondCap，两域独立）。
   *
   * @param max 上限（envName 缺省时生效；env 通道启用时被 env 值覆盖）
   * @param envName opt-in 开关 + 上限覆盖 env 变量名（可选；pi 先例
   *   `XYZ_SUBAGENT_STATE_MAX_RUNS`）
   */
  async pruneStateFilesBeyondCap(max: number, envName?: string): Promise<void> {
    let cap = max;
    if (envName !== undefined) {
      // 解析规则逐条对齐 pi getEnvStateMaxRuns：未设/空/非有限数/≤0 → 不启用
      const raw = process.env[envName];
      if (!raw) return;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      cap = parsed;
    }

    const stateDir = this.stateDir();
    let names: string[];
    try {
      names = await readdir(stateDir);
    } catch (err) {
      if (!isEnoentError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(`[file-run-store] state retention: readdir ${stateDir} failed: ${reason}`);
      }
      return;
    }
    const stateFiles = names.filter((n) => STATE_FILE_GLOB.test(n)).sort();
    if (stateFiles.length <= cap) return;

    // stat 全集取 mtime；allSettled 部分降级（单文件失败静默跳过，不阻断本轮）
    const settled = await Promise.allSettled(
      stateFiles.map(async (name) => {
        const full = join(stateDir, name);
        return { full, mtimeMs: (await stat(full)).mtimeMs };
      }),
    );
    const byMtimeAsc = settled
      .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const victims = byMtimeAsc.slice(0, byMtimeAsc.length - cap);
    for (const victim of victims) {
      try {
        await unlink(victim.full);
        logger.debug(`[file-run-store] state retention: pruned ${victim.full}`);
      } catch (err) {
        if (isEnoentError(err)) continue; // 并发删除已达成目标
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(`[file-run-store] state retention: failed to delete ${victim.full}: ${reason}`);
      }
    }
  }
}
