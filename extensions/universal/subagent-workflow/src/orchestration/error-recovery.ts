/**
 * Workflow Extension — error-recovery
 *
 * Worker 失败处理 free functions（D-12）。
 *
 * 4 个导出函数（domain-models.md §失败处理矩阵）：
 * - handleWorkerMessage(run, raw, deps, handlers) — 路由 agent_call/return/error
 * - handleWorkerError(run, err, deps, handlers) — worker uncaught error
 * - handleWorkerExit(run, code, handle, deps, handlers) — worker exit
 * - handleScriptError(run, msg, deps, handlers) — type:"error" from worker
 *
 * 重试矩阵（domain-models.md §失败处理矩阵）：
 * - worker error/exit（非零）→ 3 次重试 + 指数退避 1s/2s/4s；超限 failed
 * - script error → 3 次重试 + 指数退避；超限 failed
 * - 重试前 rebuildRuntime（G3-001：整个 RunRuntime 重建：worker+controller）
 *
 * 关键不变式：
 * - 重试前必须 rebuildRuntime（worker+controller 整体重建，避免孤儿资源）。
 * - 重试计数载体是 run.meta.workerErrorCount/scriptErrorCount（跨 runtime 存活，
 * retry replaceRuntime 后计数不丢）。
 * - handleWorkerExit 检查 handle.isCurrent（G-025：stale exit 事件丢弃）。
 *
 * 层归属：Engine。依赖 ports + WorkflowRun + executeAgentCall。
 * （旧并发门闩 gate 抽象已删——no-op，实际并发由 SubagentService ConcurrencyPool 管理。）
 *
 * 参考：domain-models.md §失败处理矩阵。
 */

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { SLUG_MAX_LENGTH } from "../execution/execute-options-mapper.ts";
import { createRecord, updateFromEvent } from "../execution/execution-record.ts";
import { SubagentStream } from "../execution/stream-sink.ts";
import type { AgentEvent } from "../shared/agent-event.ts";
import { resolveAgentOpts } from "./agent-opts-resolver.ts";
import { executeAgentCall } from "./execute-agent-call.ts";
import { AgentCall } from "./models/agent-call.ts";
import type { LifecycleDeps, WorkerHandlers } from "./models/ports.ts";
import { RunRuntime } from "./models/run-runtime.ts";
import type { WorkerLogEntry } from "./models/types.ts";
import type { AgentCallOpts, AgentResult, ExecutionTraceNode } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { WorkerHandle } from "./worker-handle.ts";

const logger = getLogger("subagents");

// ── 常量 ─────────────────────────────────────────────────────

/**
 * 单类错误最大重试次数（domain-models.md §失败处理矩阵）。
 *
 * 注意：workerErrorCount 和 scriptErrorCount 是两个独立计数器，各自上限 MAX_WORKER_RETRIES。
 * 最坏情况（先连续 worker error 3 次 + 再连续 script error 3 次）= 6 次 rebuild。
 * 这是有意设计——两类错误的根因不同（worker 崩溃 vs 脚本逻辑），合并计数会导致
 * 不同根因的失败被过早判 failed。scheduleRebuild 的 retryIndex 取 max(两计数)。
 */
const MAX_WORKER_RETRIES = 3;

/** 指数退避基数（ms）。 */
const RETRY_BACKOFF_BASE_MS = 1000;
const EXPONENTIAL_BACKOFF_BASE = 2;

/** errorLogs 最大保留条数（防止超长 session 中日志无界增长）。 */
const MAX_ERROR_LOGS = 500;

/** malformed agent-call 日志中 opts JSON 的预览截断长度（字符）。 */
const MALFORMED_MSG_LOG_PREVIEW_CHARS = 200;

// ── Worker 消息类型（与 infra/worker-script-builder.ts WorkerInMsg 对齐） ──

interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: {
    prompt: string;
    schema?: unknown;
    model?: string;
    scene?: string;
    description?: string;
    agent?: string;
    skill?: string;
    timeoutMs?: number;
    cwd?: string; // ADR-029 决策 1：per-call cwd（worktree 隔离）
  };
  phase?: string;
}

interface ReturnMsg {
  type: "return";
  result: unknown;
  workerLogs?: WorkerLogEntry[];
}

interface ErrorMsg {
  type: "error";
  error: string;
  workerLogs?: WorkerLogEntry[];
}

interface WorkflowCallMsg {
  type: "workflow-call";
  callId: number;
  name: string;
  args: Record<string, unknown>;
}

type WorkerMsg = AgentCallMsg | WorkflowCallMsg | ReturnMsg | ErrorMsg;

// ── 内部 helper ──────────────────────────────────────────────

function isTerminal(run: WorkflowRun): boolean {
  return run.state.status === "done";
}

/**
 * 孤儿 call 判定：dispatch 时捕获的 call 实例是否已不是 calls Map 中该 callId
 * 的当前条目。
 *
 * 为何需要实例级比对（而非只查 run 状态）：rebuildRuntime 不改 status（全程
 * running），既有的终态 stale 守卫拦不住旧 runtime 代际的迟到 completion。只有
 * discardInFlightCalls（delete 条目）与新一代 dispatch（set 新实例）会改变
 * 「callId → 实例」映射，故实例不等 ⟺ 本 completion 属于被丢弃/被替换的旧代际
 * （S7-second 竞态：旧失败结果经 postAgentResult 投给新 worker 的同 callId
 * pending，劫持重跑调用为假失败/空串假成功）。
 *
 * 运行期 calls Map 写点仅 discard 的 delete 与 dispatchAgentCall 的 set 两族
 * （jsonl-run-store 的 set 在离线重水合路径，无在飞 promise），正常（非孤儿）
 * 路径下实例恒等，无误判。
 */
function isOrphanedCall(run: WorkflowRun, callId: number, call: AgentCall): boolean {
  return run.state.calls.get(callId) !== call;
}

/** 计算第 n 次重试前的退避时间（ms）：1s, 2s, 4s 指数。 */
function backoffDelay(retryIndex: number): number {
  return RETRY_BACKOFF_BASE_MS * Math.pow(EXPONENTIAL_BACKOFF_BASE, retryIndex - 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// ── rebuildRuntime（G3-001 整重建） ─────────────────────────

/**
 * 移除 run 中未真正完成的在飞 call（status !== "done"）及其 trace 节点。
 *
 * 仅 rebuildRuntime 调用——清理被旧 runtime abort 的在飞 call，避免重跑时
 * cached replay 把 abort 产生的 failed 结果当作已完成结果回放（原 MUST_FIX
 * round-4 #1，自 pause 路径移入崩溃重建路径）。genuinely-done 的 call（成功或
 * 失败均 "done"）保留，重跑时按原语义 replay（不重复耗 token）。
 *
 * 返回被丢弃的 callId 数组（升序——Map 迭代按插入序，排序保证返回值与
 * rebuildRuntime 的 L3 日志 payload 形态稳定），供调用方记日志。
 */
function discardInFlightCalls(run: WorkflowRun): number[] {
  const inFlight: number[] = [];
  for (const [callId, call] of run.state.calls) {
    if (call.status !== "done") inFlight.push(callId);
  }
  for (const callId of inFlight) {
    run.state.calls.delete(callId);
    run.state.trace.removeByStepIndex(callId);
  }
  return inFlight.sort((a, b) => a - b);
}

/**
 * 重建整个 RunRuntime：新 controller + 新 worker。
 *
 * 调 run.replaceRuntime(newRt)（G5-001）：原子释放旧 runtime（worker.terminate +
 * abort）+ 绑定新 runtime，全程 status==="running" 不变（不变式 I1 不违反）。
 *
 * handlers 由调用方（lifecycle makeHandlers）构造——它们路由 onMessage/onError/
 * onExit 回本文件的 handle* 函数。handlers 捕获 run + deps 闭包，runtime 重建后
 * 仍有效（run 实例不变，deps 不变）。
 *
 * 前置：run.state.status === "running"（replaceRuntime 要求，G6-001）。
 *
 * @throws status !== "running"（由 replaceRuntime 抛）
 */
export function rebuildRuntime(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): void {
 // OB3（可观察性）：rebuild 关键节点 debug 日志——此前函数体 0 处 deps.log，
 // 崩溃自愈只能靠行为证据诊断（L1 入口 / L2 重排 / L3 discard / L4 完成）。
  deps.log?.("debug", "workflow:error-recovery", "runtime rebuild start", {
    runId: run.runId,
    budgetTimeMs: run.spec.budgetTimeMs,
  });
  const controller = new AbortController();
  const worker = deps.workerHost.start(run.spec, run.spec.args, handlers);
 // D-12 regression fix (round-2 #2)：重新调度 run 级墙钟预算计时器。
 // replaceRuntime 释放旧 runtime 时 clearTimeout 了旧计时器（run-runtime.release），
 // 新 runtime 必须重排，否则带 budgetTimeMs 的 run 命中一次 worker/script 错误重试后
 // 时间预算静默失效（直到 rebuildRuntime 才重排——本函数即唯一重排点）。
 // deps.scheduleTimeBudget 由 Interface 层注入；未注入时（旧测试）跳过重排（兼容，
 // 不影响无时间预算的 run）。
 // 重排分支改为 if——语义与原三元一致（同一条件调 scheduleTimeBudget），仅为在
 // 分支内记 L2 日志，控制流/异常语义零变化。
  let timeBudgetTimer: ReturnType<typeof setTimeout> | undefined;
  if (run.spec.budgetTimeMs && run.spec.budgetTimeMs > 0 && deps.scheduleTimeBudget) {
    timeBudgetTimer = deps.scheduleTimeBudget(run.runId, run.spec.budgetTimeMs);
    deps.log?.("debug", "workflow:error-recovery", "time budget rescheduled", {
      runId: run.runId,
      budgetTimeMs: run.spec.budgetTimeMs,
    });
  }
  run.replaceRuntime(new RunRuntime(worker, controller, timeBudgetTimer));
 // 清除被旧 runtime abort 的在飞 call——必须在 replaceRuntime 之后同步执行（无
 // await 间隔）：replaceRuntime 同步 abort 旧 controller + terminate 旧 worker，
 // 在飞 executeAgentCall 的 finalize 发生在 `await runner.run` resolve 后的
 // microtask，此刻在飞 call 仍为 "running"/"pending"（status !== "done"）可精确
 // 清理；genuinely-done 的 call 保留（重跑 replay）。放 delay 退避之前会误删退避
 // 期间自然完成的真结果（重跑重复耗 token）；放任何 await 之后，假失败已 finalize
 // 为 "done" 挡不住——重跑 replay 会把 abort 错误当真结果回放，静默污染输出。
 // 注意：discard 只清 Map/trace 条目，旧 executeAgentCall 的 promise 链仍会醒来
 // finalize。markDone 在孤儿实例上无害，但后续投递并非 no-op——postAgentResult
 // 会投给 run.runtime（已是新 worker）的同 callId pending，劫持重跑调用（实测
 // S7-second 竞态：旧失败结果被 worker 侧 resolve 为空串 → 脚本假成功）；
 // finalizeCall 的 trace.update 在重跑已 append 同 stepIndex 新节点时命中新节点
 // （瞬时污染，由重跑完成时的 update 覆盖）。该投递由 dispatchAgentCall 的
 // 孤儿守卫（isOrphanedCall）拦截，trace.update 的瞬时污染由 executeAgentCall
 // 的 isOrphaned 谓词（OB2）拦截，此处不重复设防。
  const discardedCallIds = discardInFlightCalls(run);
  deps.log?.("debug", "workflow:error-recovery", "in-flight calls discarded", {
    runId: run.runId,
    callIds: discardedCallIds,
    count: discardedCallIds.length,
  });
  deps.log?.("debug", "workflow:error-recovery", "runtime rebuild complete", {
    runId: run.runId,
  });
}

// ── handleWorkerMessage（消息路由） ──────────────────────────

/**
 * 路由 worker → main 的业务消息。
 *
 * agent_call → 派发 executeAgentCall（异步，不 await——立即返回让 worker 继续发消息）
 * return → transition done,completed（脚本正常返回）
 * error → handleScriptError（脚本主动抛错）
 *
 * 终态（done）下的 stale 消息丢弃（P0-1）。
 */
export async function handleWorkerMessage(
  run: WorkflowRun,
  raw: unknown,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 终态（done）丢弃 stale 消息（P0-1）
  if (isTerminal(run)) return;

 // M7: 形状校验——防畸形 IPC 消息（worker 崩溃/发非对象）导致下游 TypeError
  if (typeof raw !== "object" || raw === null) return;
  const msg = raw as WorkerMsg;
  switch (msg.type) {
    case "agent-call":
      dispatchAgentCall(run, msg, deps);
      return;
    case "workflow-call":
      dispatchWorkflowCall(run, msg, deps);
      return;
    case "return":
      await handleReturn(run, msg, deps);
      return;
    case "error":
 // M1: 传 handlers（rebuildRuntime 需要）
      await handleScriptError(
        run,
        msg.error,
        msg.workerLogs ?? [],
        deps,
        handlers,
      );
      return;
  }
}

/**
 * 派发 agent 调用：构建 AgentCall + trace 节点，异步触发 executeAgentCall。
 *
 * 异步触发（不 await）——立即返回，让 worker 能继续发后续 agent-call（parallel 场景）。
 * executeAgentCall 内部完成 markDone + trace.update。
 *
 * **C-3 修复**：executeAgentCall 经 dispatchCall 异步触发——原 gate.withSlot 包装已随
 * 并发门闩 gate 抽象删除（no-op），并发调度归 SubagentService ConcurrencyPool，
 * runner 管 spawn。
 *
 * **C-2 修复**：call 完成后检查 `budget.isExceeded` → abortRun(budget_limited)，
 * 终止整个 run（避免烧光预算后继续 spawn 新 call）。
 *
 * **stale 完成守卫（两层）**：completion 到达时——
 * 1. `run.state.status === "running"` recheck：run 终止（abort/terminate）后到达的
 *    call 完成不写 run.state.calls / 不 postAgentResult（终态快照不被迟到结果污染）；
 * 2. 孤儿 call 实例比对（isOrphanedCall）：rebuildRuntime 后旧代际 dispatch 的
 *    completion 不投递——rebuild 不改 status，第 1 层拦不住跨 runtime 代际的迟到
 *    结果（S7-second 竞态：旧失败结果投给新 worker 劫持重跑 pending → 假成功）。
 */
function dispatchAgentCall(
  run: WorkflowRun,
  msg: AgentCallMsg,
  deps: LifecycleDeps,
): void {
  // M4: IPC 字段校验——畸形 agent-call 消息（opts 非对象/缺失、callId 非数字、prompt 缺失）
  // 不写 trace / 不 postAgentResult——这类消息通常意味着 worker 模块版本不匹配或内存损坏，
  // 回发结果给 worker 也没意义（worker 可能已崩）。仅记日志，让 worker timeout/exit 路径接管。
  if (typeof msg.callId !== "number" || !Number.isFinite(msg.callId) ||
      typeof msg.opts !== "object" || msg.opts === null ||
      typeof msg.opts.prompt !== "string") {
    logger.error(`[workflow] malformed agent-call message: callId=${JSON.stringify(msg.callId)}, opts=${JSON.stringify(msg.opts)?.slice(0, MALFORMED_MSG_LOG_PREVIEW_CHARS)}`);
    return;
  }

 // 已缓存的调用直接 replay（跨 rebuild——崩溃重建后重跑脚本，已完成调用按 callId 命中缓存）
  const cached = run.state.calls.get(msg.callId);
  if (cached && cached.status === "done") {
    postAgentResult(run, msg.callId, cached.result!, true);
    return;
  }

  // 构建 trace 节点 + live record（TUI 实时进度）
  const agentName = msg.opts.description ?? msg.opts.agent ?? "unknown";
  // slug 复用 agentName（超长截断），live record 的 slug 仅用于 TUI 展示。
  const liveSlug = agentName.length > SLUG_MAX_LENGTH ? agentName.slice(0, SLUG_MAX_LENGTH) : agentName;
  const now = new Date().toISOString();
  // live record：收口 agent 执行过程中的 text/thinking/toolCalls/usage，
  // 供 TUI 在 agent 运行期间显示进度（getEventLog/getCurrentActivity）。
  // 完成时由下方 .then 清除（终态由 node.result 承载）。
  const liveRecord = createRecord(String(msg.callId), {
    agent: agentName,
    model: msg.opts.model ?? "default",
    mode: "background",
    task: msg.opts.prompt,
    slug: liveSlug,
    startedAt: Date.now(),
  });
  const node: ExecutionTraceNode = {
    stepIndex: msg.callId,
    agent: agentName,
    task: msg.opts.prompt,
    model: msg.opts.model ?? "default",
    status: "running" as const,
    phase: msg.phase,
    startedAt: now,
    live: liveRecord,
  };
  run.state.trace.append(node);

 // 构建 AgentCall（opts 形状对齐 AgentCallOpts；schema: unknown → Record）
 // 跨进程 IPC 边界的 schema 为 unknown，窄化前加 typeof guard 兜底。
  const rawSchema = msg.opts.schema;
  const opts: AgentCallOpts = {
    ...msg.opts,
    schema:
      typeof rawSchema === "object" && rawSchema !== null
        ? (rawSchema as Record<string, unknown>)
        : undefined,
  };

 // BL-1：解析 skill/schema → skillPath / schemaEnv / appendSystemPrompt。
 // M2 修正后 resolveAgentOpts 单参数，只处理 schema SO 指令（内容直传）+ skill。
 // agent ref 处理（systemPrompt/model/thinkingLevel）交 resolveIdentity（经
 // getAgentConfig + resolveModel 完整覆盖），消除双重注入与 model 层级混乱。
 // 解析失败（skill 未找到）走 error 路径，不发 slot、不 spawn。
  const resolved = resolveAgentOpts(opts);
  if (resolved.error) {
    const call = new AgentCall(msg.callId, opts, node);
    call.markRunning();
    const errorResult: AgentResult = { content: "", error: resolved.error };
    call.markDone(errorResult);
    run.state.calls.set(msg.callId, call);
    // 无子进程执行，清除空 live record（终态由 result 承载）
    node.live = undefined;
    run.state.trace.update(msg.callId, {
      status: "failed",
      result: errorResult,
      completedAt: new Date().toISOString(),
    });
    postAgentResult(run, msg.callId, errorResult, false);
    deps.store.save(run).catch((e: unknown) => {
      logger.error(`[workflow] store.save failed (resolveAgentOpts): ${e instanceof Error ? e.message : String(e)}`);
    });
    return;
  }

  const call = new AgentCall(msg.callId, resolved.opts, node);
  run.state.calls.set(msg.callId, call);

 // C-3：agent call 执行入口。
 // （原经 gate.withSlot 包装，并发门闩 gate 已删——no-op 抽象，实际并发由
 // SubagentService ConcurrencyPool 管理；仅保留其 pre-abort 检查语义，见下方
 // dispatchCall 内 signal.aborted 分支。）executeAgentCall 管 retry/budget/stale-context；
 // runner（runner.run）管 spawn pi 子进程。
 // assignRuntime/replaceRuntime 保证 status==="running" ⟺ runtime defined，
 // 故 run.runtime 在此必存在（dispatchAgentCall 仅从 handleWorkerMessage 调用，
 // 后者已守 terminal（isTerminal）早期 return）。fallback new AbortController 已移除。
  const runtime = run.runtime!;
  const signal = runtime.controller.signal;
  // D-005: onEvent 签名升级——executeAndAwait 直接出 AgentEvent（强类型，
  // session-runner handleSdkEvent 出口），不再有 raw JSONL 中间层。
  // 删 jsonlToAgentEvent 翻译——直接 updateFromEvent。
  // TUI 靠 tick 轮询 trace.toArray() 读 node.live，无需显式通知。
  const onEvent = (event: AgentEvent): void => {
    updateFromEvent(liveRecord, event);
  };
  // 创建 streaming sink：widgetKey = subagent-stream-<runId>-<stepIndex>。
  // 复用 background subagent 的 SubagentStream → setWidget → RPC 链路（agent-call-streaming-extension.md）。
  // streamSink 缺失（无 UI 模式）时 stream=undefined，executeAgentCall 正常执行不 streaming。
  const stream = deps.streamSink
    ? new SubagentStream(`${run.runId}-${msg.callId}`, deps.streamSink)
    : undefined;
 // 原 gate.withSlot(fn, signal) 语义内联：pre-aborted 时 reject AbortError（
 // 下方 .catch 依赖此约定不记错），否则直接执行——并发调度归 ConcurrencyPool。
  const dispatchCall = async (): Promise<void> => {
    if (signal.aborted) {
      const abortErr = new Error("Operation aborted before start");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    try {
 // OB2（S7 残留）：isOrphaned 谓词注入——旧代际 finalize 在 trace.update 前被
 // 拦截（判定语义与下方 .then/.catch 守卫同一 isOrphanedCall，详见
 // execute-agent-call.ts finalizeCall 文档注释）。
      await executeAgentCall(call, deps.runner, run.state.budget, signal, run.state.trace, onEvent, stream, () => isOrphanedCall(run, msg.callId, call));
    } finally {
      stream?.dispose();
    }
  };
  void dispatchCall()
    .then(() => {
 // 清除 live record：终态已由 executeAgentCall → finalizeCall 写入 node.result，
 // live 不再需要（且含可变状态，不保留）。无论 stale 与否都清，避免内存泄漏。
 // M4: 必须在 stale guard 之前清，否则跨 rebuild 的迟到 completion 会累积 live record。
      node.live = undefined;
 // run 终止（终态）后到达的 stale completion 不写 state
      if (run.state.status !== "running") return;
 // 孤儿 call 守卫（S7-second 竞态）：rebuild 的 discardInFlightCalls 已移除本
 // call、或重跑 dispatch 已用新实例替换同 callId 条目时，本 completion 属于旧
 // runtime 代际。postAgentResult 的投递目标是 run.runtime（已是新 worker），
 // 迟到结果会劫持新 worker 内重跑 agent() 的 pending Promise——跳过投递 /
 // budget 同步 / 持久化，仅留日志。executeAgentCall 内 finalizeCall 的
 // trace.update 若已命中重跑新节点（瞬时污染），由重跑完成时的 update 覆盖。
      if (isOrphanedCall(run, msg.callId, call)) {
        deps.log?.("debug", "workflow:error-recovery", "orphan agent call completion dropped", { runId: run.runId, callId: msg.callId });
        return;
      }
      if (call.result) postAgentResult(run, msg.callId, call.result, false);
 // D-12 regression fix (round-2 #1)：executeAgentCall 内 consume/incrementCallCount
 // 后同步 worker $BUDGET（否则 $BUDGET.spent()/remaining() 恒为 0）
      postBudgetUpdate(run);
      deps.store.save(run).catch((e: unknown) => {
        const m = e instanceof Error ? e.message : String(e);
        logger.error(`[workflow] store.save failed (agent call ${msg.callId}): ${m}`);
      });

 // C-2：budget 超限 → 终止整个 run（避免继续 spawn 烧预算）
 // 内联 terminate（不调 lifecycle.abortRun 避免 engine 内循环依赖）：
 // 若 run 仍非终态，transition done,budget_limited + 持久化。
 // 上方 status !== "running" 已保证此处非 done（且 transition 内含 done no-op 守卫）。
      if (run.state.budget.isExceeded()) {
        run.state.error = run.state.error ?? "Budget exceeded";
        deps.log?.("debug", "workflow:error-recovery", "budget exceeded, transition done", { runId: run.runId });
        // M12: transition 单独 try——并发 abort 导致 illegal-transition 是预期的，可忽略
        let transitioned = false;
        try {
          run.transition("done", "budget_limited");
          transitioned = true;
        } catch (te: unknown) {
          // run 可能在 budget 检查后、transition 前被并发 abort——预期，不记错
          void te;
        }
        if (transitioned) {
          deps.store.save(run).catch((e: unknown) => {
            const m = e instanceof Error ? e.message : String(e);
            logger.error(`[workflow] store.save failed (budget done): ${m}`);
          });
          deps.log?.("debug", "workflow:error-recovery", "run saved after budget done", { runId: run.runId, reason: run.state.reason });
          // M12: onRunDone/emit 单独 try——这些是真实副作用，错误不应被静默吞掉
          try {
            deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
            deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
            deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
            deps.onRunDone?.(run);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            logger.error(`[workflow] onRunDone/emit failed (budget done): ${m}`);
          }
        }
      }
    })
    .catch((err: unknown) => {
 // pre-abort 检查（原 gate.withSlot 语义）在 dispatchCall 入口 reject AbortError——预期，不记错。
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[workflow] agent call ${msg.callId} failed: ${message}`);
 // 兜底回发：executeAgentCall 抛非 Abort 异常时（如 runner undefined 的 TypeError、
 // dispatchCall 内部 bug）原 catch 仅 console.error，worker 内对 callId 的 pending
 // Promise 永不 resolve → agent() 永久 await → worker 脚本挂死。构造 failed AgentResult
 //（与 resolveAgentOpts 失败路径 L262-275 一致的模式）postAgentResult 回 worker，
 // 让 pending Promise resolve（结果为 error），脚本可继续或失败退出。
 // 孤儿 call 守卫（与 .then 对称，S7-second 竞态）：rebuild 后本 call 已被 discard
 // 移除/替换——markDone 虽在孤儿实例上无害，但 trace.update 会污染重跑新建的同
 // stepIndex 节点、postAgentResult 会劫持新 worker 的同 callId pending。孤儿时只
 // 留日志，全部跳过。node.live 无条件先清（旧节点已脱离 trace，防御性统一）。
      node.live = undefined;
      if (isOrphanedCall(run, msg.callId, call)) {
        deps.log?.("debug", "workflow:error-recovery", "orphan agent call failure dropped", { runId: run.runId, callId: msg.callId });
        return;
      }
      const errorResult: AgentResult = { content: "", error: message };
 // call 已 done（executeAgentCall 内 finalizeCall 已 markDone）时跳过，避免重复 markDone。
 // status 理论上必为 running（executeAgentCall L130 markRunning 先于 reject），pending
 // 分支为防御性保护。非 running/done 意外态：跳过 markDone（markDone 要求 running）。
      if (call.status !== "done") {
        if (call.status === "pending") call.markRunning();
        call.markDone(errorResult);
      }
 // state 一致性三件套（与 resolveAgentOpts 失败 L268-276 / .then L319-325 对等）：
 // trace 标 failed + 清 live record（防泄漏）+ 持久化（catch 恰是最需留证的场景）。
 // stale 终态（run 已 done）时 run.runtime 为 undefined，postAgentResult 用
 // optional chaining 跳过 worker 回发；trace/state 写入仍执行（无害，终态快照已存）。
      run.state.trace.update(msg.callId, {
        status: "failed",
        result: errorResult,
        completedAt: new Date().toISOString(),
      });
      postAgentResult(run, msg.callId, errorResult, false);
      // S2: 与 .then 对称——catch 路径也同步 worker $BUDGET（幂等）
      postBudgetUpdate(run);
      deps.store.save(run).catch((e: unknown) => {
        logger.error(`[workflow] store.save failed (catch fallback): ${e instanceof Error ? e.message : String(e)}`);
      });
    });
}

/**
 * postMessage 序列化失败时回发的 fallback result（必可克隆），让 worker pending resolve。
 *
 * postResult（workflow-call）与 postAgentResult（agent-call）各自前缀不同，故 prefix 参数化，
 * 共享返回类型与构造逻辑，避免字面量重复导致形状漂移。
 *
 * W2 防御关键纯函数——export 供独立单测（error-recovery-serialize-failed-result.test.ts）验证
 * 返回 shape `{content:"", error:"<prefix>: <errMsg>"}`，确保两条 fallback 路径（workflow-call /
 * agent-call）共享同一构造逻辑不漂移。
 */
export function makeSerializeFailedResult(
  prefix: string,
  errMsg: string,
): { content: string; error: string } {
  return { content: "", error: `${prefix}: ${errMsg}` };
}

/**
 * 派发 workflow 嵌套调用：调 deps.onWorkflowCall 获取子 workflow 结果，
 * 异步 postMessage(workflow-result) 回 worker。
 *
 * onWorkflowCall 未注入时（向后兼容），返回 error result 让脚本 soft-fail。
 * 与 dispatchAgentCall 对称：异步触发（不 await），stale 完成守卫（终态不发）。
 */
function dispatchWorkflowCall(
  run: WorkflowRun,
  msg: WorkflowCallMsg,
  deps: LifecycleDeps,
): void {
  // M4: IPC 字段校验——畸形 workflow-call 消息
  if (typeof msg.callId !== "number" || !Number.isFinite(msg.callId) ||
      typeof msg.name !== "string" ||
      typeof msg.args !== "object" || msg.args === null) {
    logger.error(`[workflow] malformed workflow-call message: callId=${JSON.stringify(msg.callId)}, name=${JSON.stringify(msg.name)}`);
    return;
  }

  const postResult = (result: unknown): void => {
    if (run.state.status !== "running") return;
    // W2 主线程防御：result 是子 workflow 任意返回值，可能含不可克隆成员（function/
    // Symbol/循环引用）→ postMessage 同步抛 DataCloneError。内部 try/catch + 回发
    // 纯字符串 fallback result，让 worker 内 workflow() pending Promise resolve。
    // 注意：错误变量用 err（外层 dispatchWorkflowCall 参数名为 msg，避免遮蔽）。
    try {
      run.runtime?.worker.postMessage({
        type: "workflow-result",
        callId: msg.callId,
        result,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[workflow] postResult (workflow-call callId=${msg.callId}) failed: ${errMsg}. Sending error fallback.`);
      // 回发纯字符串 fallback result（必可克隆），让 worker pending resolve
      try {
        run.runtime?.worker.postMessage({
          type: "workflow-result",
          callId: msg.callId,
          result: makeSerializeFailedResult("Workflow result serialization failed", errMsg),
        });
      } catch {
        // fallback 也失败——worker 此 callId 的 pending 只能靠 timeout 兜底
        logger.error(`[workflow] postResult fallback also failed (callId=${msg.callId}): worker pending will hang until timeout`);
      }
    }
  };

  if (!deps.onWorkflowCall) {
    postResult({
      content: "",
      error: `workflow() not supported: onWorkflowCall not injected`,
    });
    return;
  }

  void deps
    .onWorkflowCall(msg.name, msg.args, run)
    .then(postResult)
    .catch((err: unknown) => {
      postResult({
        content: "",
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * 回发 agent-result 给 worker（worker 内 pending Promise 据此 resolve）。
 *
 * W2 主线程防御：result 是 agent 返回值，含不可克隆成员（function/Symbol/循环引用）时
 * postMessage 同步抛 DataCloneError。若冒泡到 dispatchAgentCall 的 .then 回调，会中断
 * 后续 postBudgetUpdate/store.save/budget 检查，run 卡在 running。故内部 try/catch：
 * 失败时记录诊断 + 回发纯字符串 fallback result（必可克隆），让 worker pending resolve。
 * 函数签名不变（所有调用点无需改动），仅用共享 logger 记日志（deps 不在手边）。
 */
function postAgentResult(
  run: WorkflowRun,
  callId: number,
  result: AgentResult,
  cached: boolean,
): void {
  try {
    run.runtime?.worker.postMessage({ type: "agent-result", callId, result, cached });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[workflow] postAgentResult failed (callId=${callId}): ${msg}. Result likely contains non-cloneable value.`);
    // 回发纯字符串 fallback result（必可克隆），让 worker pending resolve（避免永久挂起）
    try {
      run.runtime?.worker.postMessage({
        type: "agent-result",
        callId,
        result: makeSerializeFailedResult("Result serialization failed", msg),
        // 原 result 不可克隆时 cached 透传原值含义失真（fallback result 非缓存命中）→ 固定 false
        cached: false,
      });
    } catch {
      // fallback 也失败——worker 此 callId 的 pending 只能靠 timeout/exit 兜底
      logger.error(`[workflow] postAgentResult fallback also failed (callId=${callId}): worker pending will hang until timeout`);
    }
  }
}

/**
 * 回发 budget-update 给 worker（$BUDGET 据 worker-script-builder 的 budget-update 分支
 * 更新 spent()/remaining()）。每次 agent 调用消费 usage 后发送，保持 worker 内 $BUDGET
 * 与主线程 Budget 值对象同步。
 *
 * D-12 regression fix (round-2 #1)：重建 budget-update 发送方。被 error-recovery 主路径调用
 * （dispatch 后同步 worker $BUDGET）——单一实现，避免消息形状漂移。
 */
export function postBudgetUpdate(run: WorkflowRun): void {
  try {
    run.runtime?.worker.postMessage({
      type: "budget-update",
      budget: {
        usedTokens: run.state.budget.usedTokens,
        usedCost: run.state.budget.usedCost,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // budget 是纯 number 不太可能失败，但防御性兜底——budget 同步非关键（worker 仍可
    // 基于 $BUDGET.spent() 自行累计），失败仅记日志，不中断调用方流程。
    logger.error(`[workflow] postBudgetUpdate failed: ${msg}. Budget sync to worker skipped (non-critical).`);
  }
}

/**
 * 处理脚本的 return 消息：transition done,completed + 持久化。
 */
async function handleReturn(
  run: WorkflowRun,
  msg: ReturnMsg,
  deps: LifecycleDeps,
): Promise<void> {
  deps.log?.("debug", "workflow:error-recovery", "handleReturn", { runId: run.runId, status: run.state.status });
 // 捕获 worker 诊断日志（P2-2）
  // L9: 追加而非覆盖——保留重试历史的诊断日志（各 worker 实例的 console 输出）
  if (msg.workerLogs && msg.workerLogs.length > 0) {
    run.state.errorLogs.push(...msg.workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }
  run.state.scriptResult = msg.result;
  run.transition("done", "completed");
  await deps.store.save(run);
  deps.log?.("debug", "workflow:error-recovery", "run saved after return", { runId: run.runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}

// ── handleWorkerError ────────────────────────────────────────

/**
 * 处理 worker 线程 uncaught error。
 *
 * 重试矩阵（domain-models.md §失败处理矩阵）：
 * - run.meta.workerErrorCount（C.5，跨 runtime 存活）< MAX → 退避 + rebuildRuntime
 * - >= MAX → transition done,failed
 *
 * @throws 不抛错——所有失败路径转 transition 或日志
 */
export async function handleWorkerError(
  run: WorkflowRun,
  err: Error,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 与 handleWorkerMessage 对称——终态（done）丢弃 stale error。
 // 否则终态后到达的 worker error 仍会 workerErrorCount++（污染跨 runtime 计数）。
  if (isTerminal(run)) return;

  const count = (run.meta.workerErrorCount ?? 0) + 1;
  run.meta.workerErrorCount = count;

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

 // 超限 → failed
  run.state.error = err.message;
  deps.log?.("debug", "workflow:error-recovery", "handleWorkerError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await deps.store.save(run);
  deps.log?.("debug", "workflow:error-recovery", "run saved after worker error", { runId: run.runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}

// ── handleWorkerExit ─────────────────────────────────────────

/**
 * 处理 worker 线程 exit。
 *
 * code === 0 → 正常退出（脚本主动 return 或自然结束），no-op
 * code !== 0 → 委托 handleWorkerError（非零 exit 视为崩溃）
 *
 * **G-025 竞态防护**：检查 handle.isCurrent——stale exit 事件（已 terminate 的旧
 * worker 的 exit）直接丢弃，不影响当前 runtime 的新 worker。
 */
export async function handleWorkerExit(
  run: WorkflowRun,
  code: number,
  handle: WorkerHandle,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // G-025: stale exit 事件丢弃（handle 已不是当前 runtime 的 worker）
  if (!handle.isCurrent) return;
  if (isTerminal(run)) return;

  if (code === 0) return; // 正常退出，no-op

 // 非零 exit → 委托 handleWorkerError（C.3: onExit 传 handle 用于竞态防护）
  await handleWorkerError(
    run,
    new Error(`Worker exited with code ${code}`),
    deps,
    handlers,
  );
}

// ── handleScriptError ────────────────────────────────────────

/**
 * 处理脚本主动抛出的 error（type:"error" from worker）。
 *
 * 重试矩阵：
 * - run.meta.scriptErrorCount（C.5）< MAX → 退避 + rebuildRuntime（N2: 补全重建）
 * - >= MAX → transition done,failed
 *
 * @param workerLogs worker console.* 捕获（P2-2，存 run.state.errorLogs 供 TUI 展示）
 */
export async function handleScriptError(
  run: WorkflowRun,
  errorMsg: string,
  workerLogs: WorkerLogEntry[],
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 与 handleWorkerMessage/handleWorkerError 对称——终态守卫前置。
  if (isTerminal(run)) return;

 // P2-2: 捕获 worker 诊断日志
  // L9: 追加而非覆盖
  if (workerLogs.length > 0) {
    run.state.errorLogs.push(...workerLogs);
    if (run.state.errorLogs.length > MAX_ERROR_LOGS) {
      run.state.errorLogs = run.state.errorLogs.slice(-MAX_ERROR_LOGS);
    }
  }

  const count = (run.meta.scriptErrorCount ?? 0) + 1;
  run.meta.scriptErrorCount = count;

  if (count <= MAX_WORKER_RETRIES) {
    await scheduleRebuild(run, deps, handlers);
    return;
  }

 // 超限 → failed
  run.state.error = `Workflow failed after ${MAX_WORKER_RETRIES} retries: ${errorMsg}`;
  deps.log?.("debug", "workflow:error-recovery", "handleScriptError retries exceeded, transition done", { runId: run.runId, count });
  run.transition("done", "failed");
  await deps.store.save(run);
  deps.log?.("debug", "workflow:error-recovery", "run saved after script error", { runId: run.runId, reason: run.state.reason });
 // C-4: run 到达 done 终态 → 注销 pending-notification + 通知 Interface 层
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister", { runId: run.runId, reason: run.state.reason });
  deps.eventBus?.emit("pending:unregister", { id: run.runId, reason: run.state.reason ?? "completed" });
  deps.log?.("debug", "workflow:error-recovery", "emit pending:unregister done", { runId: run.runId });
  deps.onRunDone?.(run);
}

// ── scheduleRebuild（退避 + 重建） ──────────────────────────

/**
 * 退避后重建 RunRuntime（G3-001 整重建）。
 *
 * 退避期间 run 可能被 abort（转终态 done）——rebuildRuntime 前重检状态，终态时
 * 跳过重建（避免给已终止的 run 启新 worker）。
 */
async function scheduleRebuild(
  run: WorkflowRun,
  deps: LifecycleDeps,
  handlers: WorkerHandlers,
): Promise<void> {
 // 用当前重试计数算退避（workerErrorCount 或 scriptErrorCount 已递增）
  const retryIndex = Math.max(
    run.meta.workerErrorCount ?? 0,
    run.meta.scriptErrorCount ?? 0,
  );
  await delay(backoffDelay(retryIndex));

 // 退避期间状态可能变化——重检
  if (isTerminal(run)) return;

  rebuildRuntime(run, deps, handlers);
}
