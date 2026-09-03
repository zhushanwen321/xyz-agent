// src/execution/execute-options-mapper.ts
//
// D-A2: AgentCallOpts → ExecuteOptions 映射（adapter 职责）
// D-A9: per-call timeoutMs 合并进 AbortSignal
//
// 接线层级：[模块内直调] —— SAR.run 内调。

import type { AgentCallOpts } from "../orchestration/models/types.ts";
import { SLUG_MAX_LENGTH } from "../orchestration/models/types.ts";
import { HOST_TIMEOUT_ABORT_REASON } from "./engine/common/kill-chain.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { ExecuteOptions } from "./types.ts";

// SLUG_MAX_LENGTH 单源收敛（D6 合流收尾）：权威定义在 orchestration/models/types.ts
//（约束对象 AgentCallOpts.description 与字段同文件）；本文件仅 import 消费
//（mapToExecuteOptions 的 slug 截断）。execution → orchestration/models/types 引用
// 有 pi-engine / host-task-spec 同款先例，D1 依赖闭包判据（不反向 import 壳侧）不受影响。

/**
 * D-A2: AgentCallOpts → ExecuteOptions 映射。
 *
 * adapter 职责——SubagentService 的 ExecuteOptions 是稳定内部契约，不为 workflow 的
 * AgentCallOpts 做适配（映射归调用方 SAR）。
 *
 * 映射规则：
 *   prompt          → task
 *   description     → slug（≤35 字符，超长截断。缺失时回落 agent 名）
 *   agent           → agent
 *   schema          → schema
 *   schemaEnv       → schemaEnv（D-A6 bridge）
 *   cwd             → cwd
 *   model           → model（显式 override 透传，ctxModel 不再压扁为 id 填底）
 *   ctxModel        → ctxModel（完整 ModelInfo 对象透传，让 resolveModel 走第 3 层透明传递）
 *   skillPath       → skillPath
 *   thinkingLevel   → thinkingLevel（M1: 否则下游 subagent-service 读到 undefined）
 *   appendSystemPrompt → appendSystemPrompt（内容数组，同名同义透传）
 *   maxTurns        → maxTurns（turn limiter 上限；undefined = 不限，不挂 turns 估算 watchdog）
 *
 * 忽略字段（委托后由 executeAndAwait 内部机制替代）：
 *   timeoutMs         —— mergeTimeoutSignal 单独处理
 *   scene             —— subagents 不消费
 *
 * description 原先被忽略，现作为 slug 透传（ExecuteOptions.slug 必填）。
 */
export function mapToExecuteOptions(
  opts: AgentCallOpts,
  ctxModel?: ModelInfo,
): ExecuteOptions {
  // slug：优先 description，缺失回落 agent 名（保证非空）。超长截断。
  const rawSlug = opts.description ?? opts.agent ?? "workflow-agent";
  return {
    task: opts.prompt,
    slug: rawSlug.length > SLUG_MAX_LENGTH ? rawSlug.slice(0, SLUG_MAX_LENGTH) : rawSlug,
    agent: opts.agent,
    schema: opts.schema,
    schemaEnv: opts.schemaEnv,
    cwd: opts.cwd,
    fork: opts.fork,
    worktree: opts.worktree,
    model: opts.model,
    ctxModel,
    skillPath: opts.skillPath,
    thinkingLevel: opts.thinkingLevel,
    appendSystemPrompt: opts.appendSystemPrompt,
    maxTurns: opts.maxTurns,
  };
}

/**
 * D-A9: per-call timeoutMs 合并进 AbortSignal。
 *
 * 墙钟 timeoutMs（per-call）+ 外部 signal（run 级 abort）都生效。
 * 缺此合并则 agent({timeoutMs:5000}) 静默无效（BC-9）。
 *
 * @param signal    外部 signal（workflow run 级 controller.signal）
 * @param timeoutMs per-call 墙钟超时；undefined/<=0 → 不设超时，原样返回 signal
 * @returns 合并后的 signal（timeoutMs 或外部 signal 任一 abort 都触发）
 */
export function mergeTimeoutSignal(
  signal: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  if (!timeoutMs || timeoutMs <= 0) {
    return signal;
  }

  const controller = new AbortController();
  // 超时 abort 带 reason 标记（对齐点④）：引擎合成终态时判别「宿主超时」
  // （engine_timeout 公共合成）vs「外部 cancel」（中止标记）——pi 链路不读 reason，
  // 行为不变。外部 signal abort 不带标记（用户/编排层 cancel 语义）。
  const timer = setTimeout(() => controller.abort(HOST_TIMEOUT_ABORT_REASON), timeoutMs);
  timer.unref();

  const onExternalAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      if (!signal.aborted) signal.removeEventListener("abort", onExternalAbort);
    },
    { once: true },
  );

  return controller.signal;
}
