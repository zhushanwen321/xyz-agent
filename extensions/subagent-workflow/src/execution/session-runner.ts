// src/core/session-runner.ts
//
// spawn pi --mode rpc 子进程执行 session 的编排器。零 mode 感知。
//
// spawn 改造后：session 在独立子进程跑（进程隔离），事件经 stdout JSON 流回流。
// runSpawn 是唯一执行入口（sync/background 共用）。mode 分叉在 Runtime.execute 顶部。
// 设计信息见 docs/subagents/spawn-refactor-plan.md。

import { type ChildProcess,execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { readActivePendingFromSessionFile } from "./session-pending.ts";

import type { ExtensionMode } from "./host-mode.ts";

import { type MirrorFlags, mirrorMainProcessFlags } from "./argv-mirror.ts";
import { writeAliveMarker } from "./alive-store.ts";
import { type DialogGlobalQueue, type UiRequestHandler } from "./dialog-queue.ts";
import { updateFromEvent } from "./execution-record.ts";
import { type GetStateResult, performGetStateHandshake } from "./get-state-handshake.ts";
import { willRespondToAskUser } from "./host-mode.ts";
import type { AgentConfig, ResolvedModel } from "./model-resolver.ts";
import { collectResult } from "./output-collector.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { IDENTITY_CUSTOM_TYPE, type SubagentIdentityData } from "./session-reconstructor.ts";
import { sendPromptCommand } from "./stdin-writer.ts";
import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
  type SpawnSessionHeader,
} from "./spawn-event-adapter.ts";
import type { SubagentStream } from "./stream-sink.ts";
import {
  cleanupTempPrompt,
  writePromptToTempFile,
} from "./temp-prompt.ts";
import type {
  AgentEvent,
  AgentResult,
  ExecutionRecord,
  SdkEvent,
  WorktreeHandle,
} from "./types.ts";
import { createTurnLimiter, WRAP_UP_HINT } from "./turn-limiter.ts";
import { createUiRequestQueue } from "./ui-request-queue.ts";

const logger = getLogger("subagents");

/**
 * 运行时 guard：subscribe 回调收到的 event 形状未知，校验 type 字段后再交给 handle。
 * 防止 SDK 事件结构变化时 switch(raw.type) 静默失配（全走 default 不报错）。
 */
function isSdkEvent(x: unknown): x is SdkEvent {
  if (typeof x !== "object" || x === null) return false;
  if (!("type" in x)) return false;
  return typeof (x as SdkEvent).type === "string";
}

/**
 * M10：agent_end 事件守卫。抽出前调用处用 `(evt as { type: string }).type === "agent_end"`
 * 和 `(evt as { willRetry?: boolean }).willRetry` 两处结构断言触发 taste/no-unsafe-cast
 *（后者断言到全可选属性等于无校验）。守卫返回后 TS 自动窄化为
 * { type: "agent_end"; willRetry?: boolean }，调用处无需任何 cast。
 */
function isAgentEndEvt(
  x: unknown,
): x is { type: "agent_end"; willRetry?: boolean } {
  if (typeof x !== "object" || x === null) return false;
  if (!("type" in x)) return false;
  // `"type" in x` 已窄化，TS 允许直接访问 x.type（无需 cast）
  return x.type === "agent_end";
}

// ============================================================
// 常量
// ============================================================

/** 默认 grace turns（soft limit 后宽限轮数，对齐旧实现 DEFAULT_GRACE_TURNS）。 */
const DEFAULT_GRACE_TURNS = 2;

/** watchdog 下限（ms）。兜底防止子进程卡死在单个 tool 内（hang 的 bash/网络读），
 *  导致 turn_end 永不触发、maxTurns limiter 失效、background 槽位/worktree/alive marker 泄漏。
 *  [M-1] 旧实现固定 30 分钟，与 maxTurns 无关——maxTurns=100 的长任务会被误杀。
 *  现改为基于 maxTurns 动态计算（见 computeWatchdogMs）。 */
const SPAWN_WATCHDOG_FLOOR_MS = 30 * 60 * 1000;

/** [M-1] 单 turn 估算耗时（ms，含 LLM 响应 + tool 执行）。
 *  5 分钟是经验值——复杂 tool（大文件读写/长 bash）+ 长 LLM 响应约 3-4 分钟，
 *  留 1-2 分钟余量。下限与按 turn 计算取 max，避免 maxTurns 过小时 watchdog 紧到误杀。 */
const WATCHDOG_MS_PER_TURN = 5 * 60 * 1000;

// [recursive-orchestration] agent_end keep-alive 的两类等待超时（不 kill 分支的兑底）。
// 层主 subagent 空闲等待后代完成（steer 唤醒）期间不产生 turn，原 watchdog 已清；
// 此后代卡死（永不完成）时此 timer 保证进程最终回收。超时 kill → finalize 视为正常
// 完成 → 通知父（父查 cw status 发现未 closed 会走 L2/L3 重派，见 planning-agent 模板）。
// 两类超时分挂不同分支（见 agent_end handler）：
//   - 有活跃后代（count>0 / error）→ computeWatchdogMs(maxTurns) 动态超时（MF-4，不误杀慢后代）
//   - 仅 recentUnregister 竞态 → WAKEUP_GRACE_MS 秒级宽限（MF-3，不空等 2h）

/** [MF-3] agent_end keep-alive 的 recentUnregister 竞态宽限（ms）。
 *  notify steer 唤醒的竞态宽限——15s 内无新 agent_end（未被唤醒）即 kill；
 *  被唤醒后下一次 agent_end 重新评估。不用长超时：层主 closeout 的最终 agent_end
 *  必然命中此分支（距最后一次 unregister <60s），挂长超时 = 空等 2h 才回收
 *  + 冒牌完成通知级联。
 *  [export] 测试可观测（run-spawn-edges MF-3 用例用 fake timers 断言 15s 后 kill）。 */
export const WAKEUP_GRACE_MS = 15_000;

/**
 * [M-1] 基于 maxTurns 动态计算 watchdog 超时。
 *
 * 旧实现固定 30 分钟（SPAWN_WATCHDOG_MS），与 maxTurns 无关：maxTurns=100 的长任务
 * （全量重构/大规模迁移）正常需数小时，30 分钟到达即被误杀，limiter 机制形同虚设。
 *
 * 现按 maxTurns 线性估算：每 turn 约 5 分钟，下限 30 分钟。
 * - maxTurns 缺省（undefined/null/0）按 10 turns 估 → 50 分钟
 * - maxTurns=20 → 100 分钟
 * - maxTurns=100 → 500 分钟（8 小时+，覆盖全量重构）
 *
 * [MF-4] 同时是 agent_end keep-alive 的「有活跃后代」等待超时（不 kill 分支），
 * 替代旧固定 2h（WAIT_DESCENDANT_TIMEOUT_MS，已删除）——wave 开发 >2h 不被误杀。
 * [export] 测试可观测（run-spawn-edges MF-4 用例断言 keep-alive 等待超时 = 动态值）。
 *
 * @param maxTurns 调用方指定的 turn 上限；undefined/null/0 视为默认 10 turns
 */
export function computeWatchdogMs(maxTurns: number | undefined | null): number {
  const effectiveTurns = maxTurns && maxTurns > 0 ? maxTurns : 10;
  return Math.max(SPAWN_WATCHDOG_FLOOR_MS, effectiveTurns * WATCHDOG_MS_PER_TURN);
}

/** stderr 累积上限（字符）。防止失控子进程打满父进程内存。保留尾部便于诊断。 */
const STDERR_MAX_CHARS = 64 * 1024;

/**
 * 跨包契约 env 名：workflow 子进程把权威 JSON Schema 通过此 env 传给 structured-output 扩展。
 *
 * [跨包契约 SSOT] 此字面量是两个独立 npm 包（@zhushanwen/pi-subagent-workflow 与
 * @zhushanwen/pi-structured-output）之间的隐式 env 契约。structured-output 包内同名常量为
 * `ENV_SCHEMA = "PI_WORKFLOW_SCHEMA"`（见 extensions/structured-output/src/index.ts）。
 * 两包是独立 npm 包不能直接 import，故各自保留常量但显式标注此契约关系——
 * 任一端改名必须同步另一端，否则权威 schema 注入会静默断桥（子进程不注册 tool/hook）。
 */
const SCHEMA_ENV_VAR = "PI_WORKFLOW_SCHEMA";

// ============================================================
// W4: ask_user RPC 系统提示词
// ============================================================

/**
 * ask_user 工具的 RPC 使用指引。当子进程配置了 ask_user tool 时注入 appendParts，
 * 告知 LLM：ask_user 的问题会通过 RPC 转发到主 agent UI，用户在主 agent 界面回答。
 *
 * 背景：spawn 模式下子进程没有 TUI 交互通道，ask_user 走 extension_ui_request RPC 协议
 * 转发到父进程，父进程调用 uiRequestHandler 将问题呈现给用户，收到回答后通过 stdin
 * 回写 JSON-RPC response。LLM 需要知道这个机制存在，才能正确使用 ask_user。
 */
export const ASK_USER_RPC_PROMPT = `
## ask_user Tool Availability

The \`ask_user\` tool is available in this session. When you call \`ask_user\`, your questions are forwarded via RPC to the main agent's UI, where the user will see them and provide answers. The response is delivered back to you automatically.

**How it works:**
1. You call \`ask_user\` with structured questions (each with options)
2. The questions are forwarded to the main agent's UI via RPC
3. The user sees the questions and selects answers in the main agent interface
4. The answers are returned to you as the tool result

**Important:**
- The user may take some time to respond — this is normal
- If the user cancels or the request times out, you'll receive a cancellation notice
- Use ask_user only when you genuinely cannot resolve ambiguity yourself (see tool description for guidelines)
`.trim();

// ============================================================
// 孤儿进程兜底（C1）
// ============================================================
//
// [C1] track 所有 runSpawn 创建的子进程（sync + background），供 dispose 兜底 kill。
//
// 背景：sync record 的 controller 是 undefined（见 createRecordForMode L420 附近），
// 所以 RecordStore.abortRunningControllers 只能 kill background 子进程（有 controller 的）。
// 主进程异常退出（SIGKILL/崩溃/session_shutdown dispose）时，sync 子进程会成孤儿。
//
// 本 Set 是 dispose 的最后兜底——在 abortRunningControllers（background controller.abort 路径）
// 之后，遍历所有仍存活的子进程（含 sync）发 SIGTERM。正常退出路径（子进程 close）会从 Set 移除，
// 不受影响。background 子进程可能被 controller.abort 路径先 kill 一次，再被本遍历 kill 一次
// （对已退出的 child.kill 返回 false，无害）。
//
// [export] 测试可观测（断言 dispose 后 size===0）。业务代码误外部修改。
export const spawnedChildren = new Set<ChildProcess>();

/**
 * kill 所有未退出的 spawned 子进程（dispose 兜底用）。
 *
 * 遍历 spawnedChildren Set，对每个未 killed 的子进程发 `child.kill(signal)`。
 * 已退出的子进程在 close/error 事件时已从 Set 移除（`spawnedChildren.delete`），
 * 故 Set 中只剩「活着的」或「已被 kill 但 close 事件尚未回调的」。后者用 `child.killed`
 * 跳过——避免对一个已 kill 的子进程重复 kill。
 *
 * 用于 SubagentService.dispose（进程退出路径）：覆盖 sync 子进程（controller 为 undefined，
 * abortRunningControllers 跳过它们）。background 子进程此时已被 abortRunningControllers 经
 * controller.abort 路径 kill，本函数对它们的二次 kill 是无害 noop（已 killed）。
 *
 * 不 await 子进程退出（dispose 要快速返回）。
 *
 * @returns 被 kill 的子进程数（诊断用）
 */
export function killAllSpawnedChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const child of spawnedChildren) {
    // 跳过已 kill 的（killed=true 表示已调过 child.kill；已退出的在 close/error 时已从 Set 移除）。
    // 不依赖 exitCode/signalCode：close 事件回调可能晚于 dispose，此时它们仍为 null，但子进程
    // 可能已被 controller.abort 路径 kill（killed=true）。
    if (child.killed) continue;
    try {
      child.kill(signal);
      n++;
    } catch {
      // best-effort：单个 kill 失败不影响其他子进程
    }
  }
  // dispose 全量清理；正常路径的 close/error 事件 delete 保留作 per-child 精细清理，
  // 这里兑底防 close 事件漏触发的极端累积（主进程崩溃后 close 回调可能不再触发，
  // 不 clear 则下次 dispose 会重复向已 kill 的 child 发信号——虽然 killed=true 跳过，
  // 但 Set 无限增长泄漏内存）。
  spawnedChildren.clear();
  return n;
}

// ============================================================
// 依赖注入容器 + 入参
// ============================================================

/** SessionRunner 的依赖注入容器（由 Runtime 提供，解耦 Core 与 Pi SDK 实例）。 */
export interface SessionRunnerContext {
  /** 进程当前工作目录（作为 spawn 子进程的 cwd 基准）。 */
  cwd: string;
  /** agent 配置目录（由 Pi 核心 getAgentDir() 决定，默认 ~/.pi/agent）。 */
  agentDir: string;
  /** 额外 skill 目录（ADR-031 废弃 discovery.json 后固定为空数组）。供子进程 --skill 注入。 */
  skillDirs: string[];
  /** 主 agent cwd（fork sessionDir 编码用）。fork 未开启时等于 cwd。 */
  mainCwd: string;
  /** 主 agent session 文件路径（fork 源）。fork 未开启时 undefined。 */
  mainSessionFile?: string;
  /**
   * worktree 子进程 pid 就绪回调（first header 时触发）。
   * Runtime 层接线为 WorktreeManager.registerPid，用于注册表补全 pid。
   * 解耦 Core 与 Runtime——session-runner 不直接依赖 WorktreeManager。
   */
  onWorktreePid?: (branch: string, pid: number) => void;
  /**
   * UI 请求处理回调。子进程发 extension_ui_request 时调用。
   *
   * 入参 UiRequest（method + channel/channelPayload + method 特定字段），
   * 返回 UiResponse（{value}/{confirmed}/{cancelled}/{ack}）。
   * 实现方按 req.channel 分发业务路由（ask_user → AskUserComponent）+
   * 默认转发（ctx.ui.*），收到用户回答后 resolve。
   *
   * 未设置时不再静默忽略——console.warn 兜底（FR-9 可观测性），
   * W3 接入 SubagentService.notifyMissingHandler 的 appendEntry。
   */
  uiRequestHandler?: UiRequestHandler;
  /**
   * L2 跨子进程全局 dialog 串行队列（进程单例，由 SubagentService 注入）。
   *
   * SR-4：child close 时调 rejectChildDialogs 清理该 child 在 L2 的 pending dialog，
   * 防 Promise 永挂（handler 等用户输入永不 settle）导致队列死锁（processing 永远 true，
   * 其他子进程的 dialog 永久阻塞）。未注入（旧调用方/测试）时 onclose 只清 L1。
   */
  dialogQueue?: DialogGlobalQueue;
  /** 主进程运行模式（W4 守卫：headless 不注入 ask_user RPC 提示词）。 */
  mode?: ExtensionMode;
  /** 所属根 session ID（跨进程身份贯穿用）。子进程的 record.rootSessionId 全指向真 ROOT，
   *  使主进程 /subagents 能看到完整递归树。runSpawn 无条件注入为子进程 env（设计 recursive-subagent-visibility.md）。 */
  sessionRootId: string;
  /** [MF-3] 所属根进程 cwd（跨进程落盘目录编码键）。根进程=自身 cwd；worktree 模式下子进程
   *  mainCwd=checkout 路径，rootCwd 贯穿真 ROOT——session 文件落盘统一用 ROOT cwd 编码，
   *  主进程磁盘重建才能看到全树（设计 recursive-subagent-visibility.md）。 */
  rootCwd: string;
}

/** SessionRunner.run 的入参。 */
export interface RunOptions {
  /** 已 resolve 的模型（Runtime 在调用前解析，Core 不重复解析）。 */
  resolved: ResolvedModel;
  /** agent 配置（含 systemPrompt/tools）。 */
  agentConfig: AgentConfig | undefined;
  /** 注入到子 session 的额外 system prompt 片段。 */
  appendSystemPrompt: string[] | undefined;
  /** 注入到子 session 的 skill 路径。 */
  skillPath: string | undefined;
  /** 结构化输出 schema（存在时 enforcement：漏调 structured-output 则 steer）。 */
  schema: Record<string, unknown> | undefined;
  /** hard turn limit。 */
  maxTurns: number | undefined;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns: number | undefined;
  /** 中断信号（Runtime 创建，来源：sync=Pi tool 框架 / bg=controller.signal）。 */
  signal: AbortSignal | undefined;
  /** event 回流——SessionRunner 内部 updateFromEvent 后，再回调调用方（widget/notify）。 */
  onEvent: ((event: AgentEvent) => void) | undefined;
  /** text_delta streaming 生命周期对象——在 text_delta 到达 onEvent 之前分流。
   *  background 模式下 onEvent=undefined，但 text_delta 仍可通过此对象被消费。
   *  由调用方（subagent-service）创建，内部做时间窗合并后转发到 setWidget。
   *  workflow 路径（executeAndAwait）不传此字段——其 onEvent 是开的，
   *  text_delta 经 onEvent 到 workflow liveRecord，不走 streaming 通道。 */
  stream?: SubagentStream;
  /** D-A6 bridge: workflow schema JSON 字符串，存在时注入 childEnv[SCHEMA_ENV_VAR]（PI_WORKFLOW_SCHEMA）。
   *  workflow 编排层通过 ExecuteOptions.schemaEnv 透传此处，
   *  runSpawn 将其注入子进程环境变量，激活 structured-output 扩展注册 tool。
   *  tool 层 execute 不传此字段 → childEnv 不注入 → BC-6 行为不变。 */
  schemaEnv?: string;
  /** 是否继承父会话上下文（fork 模式，只继承上下文）。 */
  fork?: boolean;
  /** 预创建的 worktree handle（undefined=不隔离，在 parent cwd 跑）。 */
  worktree?: WorktreeHandle;
  /** 父级 fork depth（用于深度限制 + identity entry）。 */
  parentForkDepth?: number;
}

/**
 * resume spawn 选项——重开已结束的 session 文件继续对话（M1 基建）。
 *
 * resume 时 pi 子进程用 `--session <sessionFile> --mode rpc` 续写原文件（探针 P-1/P-8
 * 实测：路径不变、entry 续写、上下文保留）。runSpawn 收到此参数后：
 *   - buildSpawnArgs 追加 `--session <sessionFile>`
 *   - record.sessionFile 提前设为 resume.sessionFile（handshake 只验证 spawn 成功，不覆盖）
 *   - model/thinkingLevel 优先用此处的值（防多轮对话模型漂移，探针 P-10），否则回退 opts.resolved
 *
 * 注意：M1 只暴露能力，messageHandler（M2）才会真正调用。
 */
export interface SpawnResumeOpts {
  /** resume 目标 session 文件绝对路径（pi `--session` 参数值）。 */
  sessionFile: string;
  /**
   * resume 时覆盖的 model（`"provider/id"` 格式，防漂移，探针 P-10 证明必须传）；
   * 不传则回退 opts.resolved。
   */
  model?: string;
  /** resume 时覆盖的 thinkingLevel；不传则回退 opts.resolved。 */
  thinkingLevel?: string;
}

// ============================================================
// D-A6 schemaEnv bridge
// ============================================================

/**
 * 将 schemaEnv 注入 childEnv（D-A6 bridge）。
 *
 * [模块内直调] —— 纯 env 赋值。从 runSpawn 的 childEnv 构造块调用。
 * 存在时设 childEnv[SCHEMA_ENV_VAR] → 子进程 structured-output 扩展读取并注册 tool。
 * 不存在时 childEnv 不变（BC-6：tool 层不传 schemaEnv → 行为与合并前一致）。
 */
export function applySchemaEnvToChildEnv(
  childEnv: Record<string, string | undefined>,
  schemaEnv?: string,
): void {
  if (schemaEnv) {
    childEnv[SCHEMA_ENV_VAR] = schemaEnv;
  }
}

// ============================================================
// Schema 指令
// ============================================================

/** formatSchemaInstruction 的 JSON pretty-print 缩进。 */
const SCHEMA_JSON_INDENT = 2;

/**
 * 构造 schema 指令模板（拼入 task 末尾 + steer reminder 复用）。
 * 指令明确要求 agent 调用 structured-output tool，而非直接输出 JSON 文本。
 */
export function formatSchemaInstruction(schema: Record<string, unknown>): string {
  return [
    "MANDATORY: Structured Output Requirement",
    "You MUST call the `structured-output` tool with your final answer.",
    "Do NOT output the JSON directly in your text response — you MUST use the structured-output tool.",
    "The schema is enforced by the system — call structured-output with ONLY the `data` parameter.",
    "Do NOT pass a `schema` parameter; the system validates `data` against the authoritative schema automatically.",
    "The schema for your `data` is:",
    "```json",
    JSON.stringify(schema, null, SCHEMA_JSON_INDENT),
    "```",
  ].join("\n");
}

// ============================================================
// 环境信息块（M1 恢复）
// ============================================================

/** buildEnvBlock 的 git 命令超时（ms）。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/** git branch 缓存（key=cwd）——避免每次 session 创建都 spawn git。 */
const branchCache = new Map<string, string>();

/**
 * 构建环境信息块（P7 防注入：环境数据标记为 data，非指令）。
 * git branch 同步获取（execFileSync），按 cwd 缓存。
 *
 * [SPAWN 改造] 从旧 in-process run() 恢复。spawn 模型下此块拼进
 * --append-system-prompt 文件，子进程读文件注入 system prompt。
 *
 * [M9] 深度展示同时反映 fork 链与通用嵌套——取 max(forkDepth, nestingDepth)。
 * 背景：双层护栏共享 MAX_FORK_DEPTH 上限（见 session-context-resolver.ts 注释）：
 *   - forkDepth 只数 fork 链（fork=true 才递增），控 session 体积。
 *   - nestingDepth 经 execCtxAls 计所有 subagent 嵌套（fork + 非 fork），更严。
 * 混合链（非fork→非fork→fork）下最内 fork 的 forkDepth=1，但 nestingDepth 可能已接近上限。
 * 旧实现只展示 forkDepth → LLM 看到 "1/10" 误以为还有很大预算，实际通用护栏可能先拒绝。
 * 取 max 展示更严的约束，避免误导。两者均 ≤ MAX_FORK_DEPTH（护栏保证），max 也 ≤ MAX。
 *
 * @param forkDepth 当前 fork 链深度（undefined=非 fork session，视为 0）。
 * @param nestingDepth 通用嵌套深度（record.depth，undefined=顶层）。
 */
export function buildEnvBlock(
  cwd: string,
  forkDepth?: number,
  nestingDepth?: number,
): string {
  const lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`];
  // [M9] 取 max(forkDepth, nestingDepth)——更严的约束先生效，避免只展示 forkDepth 误导 LLM。
  const fd = forkDepth ?? 0;
  const nd = nestingDepth ?? 0;
  const depth = Math.max(fd, nd);
  if (depth > 0) {
    lines.push(`Depth: ${depth}/${MAX_FORK_DEPTH}`);
  }
  let branch = branchCache.get(cwd);
  if (branch === undefined) {
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: ENV_GIT_TIMEOUT_MS,
      }).trim();
    } catch {
      branch = "";
    }
    branchCache.set(cwd, branch);
  }
  if (branch) lines.push(`Git branch: ${branch}`);
  lines.push("--- end environment ---");
  return lines.join("\n");
}

// ============================================================
// [SPAWN 改造] runSpawn：spawn pi --mode rpc 子进程执行 session
// ============================================================
//
// 替代 in-process run()。核心差异：session 在独立子进程跑（进程隔离），
// 事件经 stdout JSON 流回流（而非 in-process session.subscribe 回调）。
//
// 复用 run() 的事件累积逻辑（handleSdkEvent 闭包模式）：stdout 解析出的 SdkEvent
// 直接喂给相同的 switch + updateFromEvent，累积目标（record.turns[]）不变。
// 这让改造的影响面收敛——只换「事件从哪来」，不换「事件怎么累积」。
//
// 与 run() 的语义对应：
//   a. pendingTools 寄存器（tool_end 可能缺 args，用 tool_start 寄存回填）
//   b. handleSdkEvent switch（SdkEvent → AgentEvent）
//   c. turnLimiter：maxTurns 用事件计数 turn_end + proc.kill 替代 session.abort
//   d. signal → proc.kill 监听（替代 signal → session.abort）
//   e. schema enforcement：改为 task 内 MANDATORY 指令（spawn 无 steer 通道）
//   f. spawn + pump stdout（替代 session.prompt）
//   g. collectResult → AgentResult（完全复用）
//   h. proc cleanup（替代 session.dispose）
//
// fork 保留：--fork <mainSessionFile> 传父 session，子进程建分支会话。
//   depth 经环境变量 PI_SUBAGENT_FORK_DEPTH 传给子进程（W3 子进程侧初始化读取）。

/** 子进程退出码阈值：>=128 表示被信号终止（SIGTERM=143 等）。 */
const SIGNAL_EXIT_CODE_THRESHOLD = 128;

/**
 * 组装 pi CLI 参数（不含 task 本身，task 作为最后一个位置参数）。
 *
 * 抽取自 runSpawn 便于单测（纯函数，不依赖进程状态）。
 */
export function buildSpawnArgs(
  params: {
    model: string | undefined;
    thinkingLevel: string | undefined;
    agentTools: string[] | undefined;
    appendSystemPromptPath: string | undefined;
    sessionDir: string;
    /**
     * resume 目标 session 文件路径。存在时紧跟 `--session-dir <dir>` 追加
     * `--session <file>`，pi 续写原 session 文件而非新建（探针 P-1/P-8 实测续写成立）。
     * undefined = 新 session（当前行为，向后兼容）。
     */
    sessionFile?: string;
    forkSource: string | undefined;
    skillPaths: string[] | undefined;
    /**
     * 镜像自主进程 argv 的 flag（--no-extensions/--approve/--extension）。
     * undefined 或全空/全 false 时行为不变（向后兼容）。
     */
    mirrorFlags?: MirrorFlags;
  },
): string[] {
  // task 不通过命令行传——pi 的 runRpcMode 只消费 stdin RpcCommand，
  // positional task arg / -p flag 在 rpc mode 下被 resolveAppMode 无视。
  // task 由 runSpawn 内 sendPromptCommand 写 child.stdin 驱动。
  const args: string[] = ["--mode", "rpc", "--session-dir", params.sessionDir];
  // resume：紧跟 --session-dir 追加 --session <file>，pi 续写原 session 文件（P-8）。
  if (params.sessionFile) {
    args.push("--session", params.sessionFile);
  }
  if (params.model) args.push("--model", params.model);
  if (params.thinkingLevel && params.model) {
    // thinking level 通过 model 后缀 :level 传递（pi CLI 约定）
    // model 已 push，这里只补后缀到同一 token
    const lastIdx = args.length - 1;
    args[lastIdx] = `${args[lastIdx]}:${params.thinkingLevel}`;
  }
  if (params.agentTools && params.agentTools.length > 0) {
    args.push("--tools", params.agentTools.join(","));
  }
  if (params.appendSystemPromptPath) {
    args.push("--append-system-prompt", params.appendSystemPromptPath);
  }
  if (params.forkSource) {
    args.push("--fork", params.forkSource);
  }
  // [M3 恢复] skill 路径：主 session 的 skillDirs + 调用方传入的 skillPath。
  // pi CLI 支持 --skill 多次使用，每个路径单独 push。
  if (params.skillPaths && params.skillPaths.length > 0) {
    for (const sp of params.skillPaths) {
      args.push("--skill", sp);
    }
  }
  // 镜像主进程的 extension/approve flag：让子进程 extension 加载行为与主进程一致。
  // undefined/空值时不追加（向后兼容）。顺序紧跟 skill 之后，注入类 flag 集中。
  const mf = params.mirrorFlags;
  if (mf) {
    if (mf.noExtensions) args.push("--no-extensions");
    if (mf.approve) args.push("--approve");
    for (const ep of mf.extensionPaths) {
      args.push("--extension", ep);
    }
  }
  return args;
}

/**
 * spawn pi 子进程执行 session。
 *
 * 契约与 run() 一致：正常路径不抛错（prompt 失败/turn-limit abort/子进程崩溃
 * 均合成 failed AgentResult 返回）。创建期异常（spawn 本身失败）会抛。
 */
export async function runSpawn(
  record: ExecutionRecord,
  task: string,
  opts: RunOptions,
  ctx: SessionRunnerContext,
  /** resume 选项（M1 基建）：重开已结束的 session 继续对话。undefined = 新 session。 */
  resume?: SpawnResumeOpts,
): Promise<AgentResult> {
  const startTime = Date.now();

  // [M1 resume 基建] resume 时提前锁定 record.sessionFile：spawn 前已知目标文件，
  // handshake 的 finishHandshake 内 `!record.sessionFile` 守卫天然跳过回填，
  // sessionFile 用 resume.sessionFile 不被覆盖（RPC mode 无 header，header 分支也不触发）。
  if (resume) {
    record.sessionFile = resume.sessionFile;
  }

  // a. transient 寄存器（同 run()：tool_end 缺 args 时回填）
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  // b. turnLimiter（spawn 版：abort = proc.kill；steer 是 no-op）
  // [M1] rpc mode 是长驻进程（agent_end 后不自动退出），maxTurns soft limit 依赖
  // graceTurns 后的 abort（proc.kill SIGTERM）兑现。agent 自然结束时由 stdout pump
  // 的 agent_end 拦截 kill（见下方）。steer 通道当前未接通（见下方 steer no-op 注释）。
  let proc: ChildProcess | undefined;
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
    steer: () => {
      // no-op：当前 runSpawn 未接通 rpc stdin steer 通道（rpc mode 支持 steer/followUp，
      // 但未实现写入逻辑）。补偿已在启动时注入 WRAP_UP_HINT 让 agent 主动收尾。
    },
    abort: () => {
      proc?.kill("SIGTERM");
    },
  });

  // c. schema 指令拼到 task 末尾（替代 in-process 的 turn_end steer 循环）
  const instruction = opts.schema ? formatSchemaInstruction(opts.schema) : ""
  const fullTask = task + instruction;

  // ── SDK 事件累积器（闭包模式与 run() 完全相同）──
  const accumulateMessageEnd = (raw: SdkEvent): void => {
    const msg = raw.message;
    if (msg?.usage) {
      const { cost: costObj, ...usageBase } = msg.usage;
      const usage = { ...usageBase, cost: costObj?.total };
      agentEvent({ type: "message_end", usage });
    }
    const stopReason = msg?.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      const errMsg = msg?.errorMessage ?? raw.reason ?? stopReason;
      agentEvent({ type: "error", message: errMsg });
    }
  };

  const handleSdkEvent = (raw: SdkEvent): void => {
    switch (raw.type) {
      case "tool_execution_start": {
        const toolName = raw.toolName ?? "";
        if (raw.toolCallId) {
          pendingTools.set(raw.toolCallId, { toolName, args: raw.args });
        }
        agentEvent({ type: "tool_start", toolName, args: raw.args });
        return;
      }
      case "tool_execution_end": {
        const toolName = raw.toolName ?? "";
        let args = raw.args;
        if (raw.toolCallId) {
          const pending = pendingTools.get(raw.toolCallId);
          if (pending) {
            if (args === undefined) args = pending.args;
            pendingTools.delete(raw.toolCallId);
          }
        }
        agentEvent({ type: "tool_end", toolName, args, result: raw.result, isError: raw.isError });
        return;
      }
      case "message_update": {
        const ame = raw.assistantMessageEvent;
        if (ame?.type === "thinking_delta") {
          agentEvent({ type: "thinking_delta", delta: ame.delta ?? "" });
        } else if (ame?.delta !== undefined) {
          agentEvent({ type: "text_delta", delta: ame.delta });
        }
        return;
      }
      case "turn_end": {
        agentEvent({ type: "turn_end" });
        return;
      }
      case "message_end": {
        accumulateMessageEnd(raw);
        return;
      }
      case "compaction_start": {
        agentEvent({ type: "compaction" });
        return;
      }
      default:
        return;
    }
  };

  // agentEvent 统一出口：updateFromEvent + onTurnEnd（limiter）+ opts.onEvent
  const agentEvent = (event: AgentEvent): void => {
    updateFromEvent(record, event);
    if (event.type === "turn_end") limiter.onTurnEnd(record.turnCount);
    // text_delta 分流到 stream 通道（在 onEvent 之前）。
    // 双通道互斥设计：background 路径 stream 有值、onEvent=undefined；
    // workflow 路径 onEvent 有值、stream=undefined。详见 W3 注释。
    if (event.type === "text_delta") opts.stream?.onDelta(event.delta);
    opts.onEvent?.(event);
  };

  // d. session 目录（与 in-process 一致：list/恢复可发现同一目录）
  // [MF-3] 用 ctx.rootCwd（贯穿真 ROOT）而非 ctx.mainCwd 编码：worktree 模式下 mainCwd 是
  // 子进程的 checkout 路径，按它编码会让深层 record 落到 enc(worktree) 段，ROOT 磁盘重建
  // 扫不到 → 全树可见性深度 ≥ 2 断裂。rootCwd 与 store 构造同源（subagent-service 同键），
  // 保证 runSpawn 写入的 session 文件就在本进程/ROOT store 扫描的目录里。
  const sessionDir = getSubagentSessionDir(ctx.agentDir, ctx.rootCwd);
  fs.mkdirSync(sessionDir, { recursive: true });

  // e. worktree 模式：checkout 路径作为 spawn cwd（隔离文件系统）
  // worktree checkout 已由 worktree-manager 在 execute 前创建，此处只取路径。
  const spawnCwd = opts.worktree?.path ?? ctx.cwd;

  // f. fork source：父 session 文件路径（--fork 参数）
  const forkSource = opts.fork ? ctx.mainSessionFile : undefined;

  // g. appendSystemPrompt 落盘（env block + agent body + 调用方片段拼成 --append-system-prompt 文件）
  // [M1 恢复] 环境块（cwd / fork depth / git branch）拼在最前面，与旧 in-process
  // buildAppendSystemPrompt 顺序一致——parts[0] 是环境块，其后 agent systemPrompt、再后调用方片段。
  const ownForkDepth = opts.fork ? (opts.parentForkDepth ?? 0) + 1 : undefined;
  let tempPromptFile: { dir: string; filePath: string } | undefined;
  // [M9] buildEnvBlock 取 max(forkDepth, nestingDepth)：record.depth === nestingDepth（都从
  // execCtxAls 派生，见 createRecordForMode L425-427 与 execute L257-258），传它让 env block
  // 展示更严的约束（混合嵌套链下通用护栏可能先于 fork 护栏拒绝）。
  const appendParts: string[] = [buildEnvBlock(ctx.cwd, ownForkDepth, record.depth)];
  if (opts.agentConfig?.systemPrompt) appendParts.push(opts.agentConfig.systemPrompt);
  if (opts.appendSystemPrompt) appendParts.push(...opts.appendSystemPrompt);
  // [M1 补偿] rpc mode 的 steer 通道当前未接通，改为启动时预置 wrap-up 提示——
  // agent 感知接近上限时主动收尾。
  if (opts.maxTurns && opts.maxTurns > 0) appendParts.push(WRAP_UP_HINT);
  // W4: ask_user RPC 使用指引——当子进程配置了 ask_user tool 时，告知 LLM
  // ask_user 的问题会通过 RPC 转发到主 agent UI，用户在主 agent 界面回答。
  if (opts.agentConfig?.tools?.includes("ask_user") && willRespondToAskUser(ctx.mode)) {
    appendParts.push(ASK_USER_RPC_PROMPT);
  }
  if (appendParts.length > 0) {
    tempPromptFile = await writePromptToTempFile(record.agent, appendParts.join("\n\n"));
  }

  // h. fork depth 经环境变量传给子进程（子进程 subagents 扩展 W3 读取）
  const childEnv: Record<string, string | undefined> = { ...process.env };
  if (opts.fork && opts.parentForkDepth !== undefined) {
    childEnv.PI_SUBAGENT_FORK_DEPTH = String(opts.parentForkDepth + 1);
  }
  // [递归可见性] 跨进程身份贯穿（设计 docs/design/recursive-subagent-visibility.md）。
  // 无条件注入每个 subagent（决策 2：身份贯穿是基础需求，不依赖 fork）。env 描述「子进程自己的身份」：
  //   - ROOT_SESSION_ID：所属根 session（贯穿真 ROOT，子进程 sessionRootId 读它）
  //   - SELF_RECORD_ID：子进程自己的 record id（子进程 execCtxAls 基线 = 孙的直接父）
  //   - DEPTH：子进程的嵌套深度（子进程 execCtxAls 基线 depth）
  //   - ROOT_CWD：真 ROOT 的 cwd（[MF-3] 落盘目录编码键，worktree 下与自身 spawn cwd 不同）
  // 子进程 initSession 读这 4 个 env 建立基线 → createRecordForMode 读 execCtxAls 自动正确。
  childEnv.PI_SUBAGENT_ROOT_SESSION_ID = ctx.sessionRootId;
  childEnv.PI_SUBAGENT_SELF_RECORD_ID = record.id;
  childEnv.PI_SUBAGENT_DEPTH = String(record.depth);
  // [MF-3] 第 4 个贯穿 env：真 ROOT 的 cwd。worktree 模式下子进程 spawn cwd = checkout 路径，
  // 子进程的 store/runSpawn 落盘目录须统一编码在 enc(ROOT cwd) 段（与身份贯穿同构），
  // 否则 ROOT 磁盘重建扫不到深层 record（见 subagent-service ENV_ROOT_CWD 注释）。
  childEnv.PI_SUBAGENT_ROOT_CWD = ctx.rootCwd;
  // D-A6 bridge: schema 激活 structured-output 扩展注册 tool（workflow 编排层需要）
  applySchemaEnvToChildEnv(childEnv, opts.schemaEnv);

  // i. 组装 args + spawn
  // [M3 恢复] skillPaths: 主 session 的 skillDirs + 调用方传入的 skillPath。
  // ADR-031 后 skillDirs 固定为空，仅 opts.skillPath 生效（agent({skill}) 解析）。
  const skillPaths = [...ctx.skillDirs, opts.skillPath].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const modelId = opts.resolved.model.id;
  // [M1 resume] resume 时 model/thinkingLevel 优先用 resume 值（防多轮对话模型漂移，P-10），
  // 否则回退 opts.resolved。resume.model 已是 "provider/id" 格式，与 buildSpawnArgs 约定一致。
  const effectiveModel = resume?.model ?? `${opts.resolved.model.provider}/${modelId}`;
  const effectiveThinkingLevel = resume?.thinkingLevel ?? opts.resolved.thinkingLevel;
  const spawnArgs = buildSpawnArgs(
    {
      model: effectiveModel,
      thinkingLevel: effectiveThinkingLevel,
      agentTools: opts.agentConfig?.tools,
      appendSystemPromptPath: tempPromptFile?.filePath,
      sessionDir,
      sessionFile: resume?.sessionFile,
      forkSource,
      skillPaths: skillPaths.length > 0 ? skillPaths : undefined,
      // 镜像主进程 argv 的 extension/approve flag，让子进程加载行为对齐主进程
      mirrorFlags: mirrorMainProcessFlags(process.argv),
    },
  );
  const invocation = getPiInvocation(spawnArgs);

  // 解析出的 session header（stdout 首行，含 session id）
  let sessionHeader: SpawnSessionHeader | undefined;
  // 累积 stderr（错误诊断用）
  let stderrBuffer = "";

  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: spawnCwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    proc = child;
    // [C1] track 子进程供 dispose 兜底 kill（sync + background 均注册——sync 无 controller，
    // abortRunningControllers 跳过它，靠本 Set 兜底）。close/error 后移除（已退出无需再 kill）。
    spawnedChildren.add(child);

    // stdout/stderr 用 utf8 编码：stream 自动按字符边界切分，避免多字节
    // UTF-8（CJK/emoji）跨 chunk 时 toString() 产生 U+FFFD 替换符导致 JSON.parse 失败。
    // [m2] 先 setEncoding 再注册 signal listener/watchdog：若 setEncoding 抛错，try/finally
    //（下方）只清理 tempPromptFile，watchdog/signal listener 尚未注册则无需清理——避免泄漏。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // 喂 prompt 命令驱动子进程开始处理 task。pi runRpcMode 只消费 stdin RpcCommand，
    // 不读 positional arg；必须在 spawn 后主动写，否则子进程阻塞、totalTokens 恒 0。
    // 时机安全：pipe 内核缓冲不丢；pi 在 rebindSession 后才挂 stdin reader。
    sendPromptCommand(child, fullTask);

    // d. signal → proc.kill 监听（一次性，替代 session.abort）
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // 前置检查：signal 在 spawn 前已 aborted 时 addEventListener 不会触发 onAbort，
    // 子进程会跑到自然结束。立即 kill 兑现取消语义。
    if (opts.signal?.aborted) onAbort();

    // e. watchdog：子进程整体超时兜底。卡死在单 tool 内（turn_end 永不触发）时
    //    limiter 失效，此 timer 保证最终 SIGTERM，防止 background 槽位/资源泄漏。
    // [M-1] timeout 基于 maxTurns 动态计算（computeWatchdogMs）：旧实现固定 30 分钟
    //    误杀长任务，现按 maxTurns 线性估算（每 turn ~5 分钟，下限 30 分钟）。
    // [R0] unref：不阻止 Node 进程退出。安全性由 SubagentService.dispose 保证——
    // 主进程退出时（session_shutdown reason=quit）dispose 会 abort running controller
    // → 本监听器 kill 子进程。无此 unref，watchdog timer 会拖住 event loop 阻止退出。
    const watchdogMs = computeWatchdogMs(opts.maxTurns);
    let watchdog = setTimeout(() => child.kill("SIGTERM"), watchdogMs);
    watchdog.unref();

    // [recursive-orchestration] agent_end 有活跃后代时的等待超时（不 kill 分支的兑底）。
    // 层主 subagent 空闲等待后代完成（steer 唤醒）期间不产生 turn，原 watchdog 已清；
    // 此后代卡死（永不完成）时此 timer 保证进程最终回收。超时 kill → finalize 视为正常
    // 完成 → 通知父（父查 cw status 发现未 closed 会走 L2/L3 重派，见 planning-agent 模板）。

    // stdout pump：逐行解析 → handleSdkEvent / enqueueUiRequest
    const enqueueUiRequest = createUiRequestQueue(child, ctx);
    // FR-4: get_state RPC response 监听器（id → resolver）。
    // parseSpawnLine 返回 kind:"response" 时，按 command+id 匹配 resolver。
    const get_stateListeners = new Map<string, (data: unknown) => void>();
    let stdoutBuffer = "";

    // [#18] 握手状态变量在 stdout handler 注册之前定义，消除"handler 闭包依赖同 tick
    // 后续 const 初始化"的隐式顺序假设——handler 现在直接引用已初始化的变量，不靠
    // "data 事件必然在下一 tick 才触发”的运行时不变式兜底。
    const handshakeResultRef: { current?: GetStateResult } = {};
    let settleHandshake: (() => void) | undefined;
    const handshakeSettled: Promise<void> = new Promise((resolveSettled) => {
      settleHandshake = resolveSettled;
    });
    /** 握手完成统一入口：记录结果 + 回填 sessionFile + 写 alive marker + settle。 */
    const finishHandshake = (r: GetStateResult): void => {
      handshakeResultRef.current = r;
      // 仅当 header 未先行设置 record.sessionFile 时回填（RPC mode 路径）。
      if (r.sessionFile && !record.sessionFile) {
        record.sessionFile = r.sessionFile;
        if (child.pid) {
          try {
            writeAliveMarker(r.sessionFile, {
              pid: child.pid,
              id: r.sessionId ?? record.id,
              startedAt: Date.now(),
            });
          } catch {
            // best-effort：alive marker 失败不影响执行
          }
        }
      }
      settleHandshake?.();
      settleHandshake = undefined;
    };

    child.stdout.on("data", (data: string) => {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? ""; // 保留最后未完整行
      for (const line of lines) {
        const parsed = parseSpawnLine(line);
        if (!parsed) continue;
        if (parsed.kind === "header") {
          sessionHeader = parsed.header;
          // 回填 record.sessionFile（deriveSessionFilePath 推导路径）
          record.sessionFile = deriveSessionFilePath(parsed.header, sessionDir);
          // [持久化 C] alive marker：running 期间崩溃恢复用。子进程 pid + session id。
          // 与 in-process 逻辑对齐（记 sessionFile + pid），改为子进程 pid。
          if (record.sessionFile && child.pid) {
            try {
              writeAliveMarker(record.sessionFile, {
                pid: child.pid,
                id: parsed.header.id,
                startedAt: Date.now(),
              });
            } catch {
              // best-effort：alive marker 失败不影响执行
            }
          }
          // [全局注册表] worktree 模式：补全注册表条目的 pid。
          // create 时 pid 未知写 0 占位，此处拿到 child.pid 后回调 WorktreeManager.registerPid。
          // 取代旧的 .session mapping sidecar——注册表是 reaper 的唯一数据源。
          if (opts.worktree && child.pid) {
            ctx.onWorktreePid?.(opts.worktree.branch, child.pid);
          }
          // FR-4 加速路径：header 到达即 finishHandshake（header 已提供 sessionId，
          // 足以推导 sessionFile + 兜底查找，无需等 get_state response）。
          // [#25] buildSpawnArgs 固定 --mode rpc，RPC mode 不发 header——此分支当前不触发，
          // 仅为未来 mode 回切（如 json mode 调试）保留：届时 header 先到可省去 get_state 握手等待。
          if (settleHandshake) {
            finishHandshake({
              ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
              sessionId: parsed.header.id,
            });
          }
        } else if (parsed.kind === "event") {
          const evt = parsed.event;
          // agent_end（willRetry=false）= agent 自然完成。rpc mode 子进程不自动退出
          //（runRpcMode 末尾 return new Promise(() => {}) 长驻等命令），需主动 kill
          // 触发 close → runSpawn resolve。willRetry=true 时 agent 会重试，不能 kill。
          if (isAgentEndEvt(evt)) {
            if (evt.willRetry) {
              // agent 会重试，不能 kill。
            } else {
              // [recursive-orchestration] 条件 kill：读子进程 session 文件算活跃后代
              // （pending:register − unregister 差集）。有活跃后代（background subagent /
              // workflow）→ 保持进程 idle，等后代完成时 notifier triggerTurn steer 唤醒；
              // 无 → 正常完成，kill 触发 close → runSpawn resolve。
              const pending = readActivePendingFromSessionFile(record.sessionFile);
              if (pending.count > 0 || pending.error) {
                if (pending.error) {
                  logger.warn(
                    `[session-runner] agent_end: keep alive (sessionFile unreadable, conservative): ${pending.error}`,
                  );
                } else {
                  logger.debug(
                    `[session-runner] agent_end: keep alive, ${pending.count} active descendant(s) pending`,
                  );
                }
                // 空闲等待期间不消耗 turn：清原 watchdog，换等待后代超时（每次 agent_end 重新计时）。
                // [MF-4] 动态超时 = computeWatchdogMs(maxTurns)：真实后代在跑，慢任务（wave 开发
                // 数小时）不能被固定 2h 误杀——2h 到点 kill 会连坐 SubagentService.dispose 的
                // killAllSpawnedChildren 杀全部子进程，L2 重派丢在途工作。maxTurns 大则超时长。
                clearTimeout(watchdog);
                watchdog = setTimeout(() => child.kill("SIGTERM"), computeWatchdogMs(opts.maxTurns));
                watchdog.unref();
              } else if (pending.recentUnregister) {
                // 差集 0 但最近有 unregister：后代刚完成，notify 唤醒可能在路上（竞态窗口），
                // 保持进程——父被唤醒后的下一次 agent_end 会正常判定。
                // [MF-3] 秒级宽限：此分支在每层「最终 turn」必命中（closeout 的 agent_end 距
                // 最后一次 unregister <60s），挂长超时 = 空等 2h 才 kill + 冒牌完成通知级联。
                // 15s 内无新 agent_end（未被唤醒）即 kill；被唤醒后下一次 agent_end 重新评估。
                logger.debug(
                  "[session-runner] agent_end: keep alive, recent descendant completion (wake-up in flight)",
                );
                clearTimeout(watchdog);
                watchdog = setTimeout(() => child.kill("SIGTERM"), WAKEUP_GRACE_MS);
                watchdog.unref();
              } else {
                child.kill("SIGTERM");
              }
            }
          }
          if (isSdkEvent(parsed.event)) handleSdkEvent(parsed.event);
        } else if (parsed.kind === "response") {
          // FR-4: RPC response handling — 匹配 get_state 响应
          if (parsed.command === "get_state" && parsed.success && parsed.id) {
            const resolver = get_stateListeners.get(parsed.id);
            if (resolver) {
              get_stateListeners.delete(parsed.id);
              resolver(parsed.data);
            }
          }
        } else if (parsed.kind === "extension_ui_request") {
          // W3: 子进程发 UI 请求（ask_user）。入队 FIFO 串行处理，防止并发询问用户。
          enqueueUiRequest(parsed.id, parsed.request);
        }
        // invalid 行忽略（stdout 可能有调试输出）
      }
    });

    // FR-4: get_state RPC 握手——spawn 后无条件启动。
    // RPC mode（pi --mode rpc）不向 stdout 输出 header，record.sessionFile 无法靠 header
    // 推导，必须通过 get_state RPC 查询子进程回填。json mode 下 header 会先到达触发提前
    // resolve（加速路径），握手仍启动但无害——response 到达时外层已 resolve，resolver
    // 因 resolved=true 直接 return。
    //
    // 时序：握手在 stdout pump（get_stateListeners 已就绪）之后启动。get_state 命令写入
    // stdin，pi rebindSession 后读取并返回 response，经 stdout pump 匹配 resolver 触发 resolve。
    // close handler await handshakeSettled，保证无论 task 多快结束，close 时 sessionFile 已回填。
    // [#18] 握手状态变量（handshakeResultRef/settleHandshake/handshakeSettled/finishHandshake）
    // 已在上方 stdout handler 注册前定义，此处直接发起握手。
    void performGetStateHandshake(child, (id, resolver) => {
      get_stateListeners.set(id, resolver);
    }).then((r) => {
      // header 加速路径下 settleHandshake 已 undefined，跳过（避免覆盖 header 结果）。
      // 超时兜底（r 为空对象）也经此分支 settle，但 record.sessionFile 不回填。
      if (settleHandshake) finishHandshake(r);
    });

    child.stderr.on("data", (data: string) => {
      // 截断防 OOM：失控子进程持续打 stderr 会耗尽父进程内存。保留尾部便于诊断。
      stderrBuffer = (stderrBuffer + data).slice(-STDERR_MAX_CHARS);
    });

    // 等待子进程退出
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", async (code: number | null) => {
        // [C1] 子进程已退出，从 orphan-tracking Set 移除（dispose 兜底无需再 kill 它）
        spawnedChildren.delete(child);
        // FR-4: 清理 get_state 监听器（子进程已退出，无更多 response）
        get_stateListeners.clear();
        // FR-4: 子进程已退出，get_state response 不会再来。若握手仍未 settle，立即放弃
        //（record.sessionFile 未回填则走 findSessionFileByHeaderId 兜底）。避免子进程快速
        // 失败/退出场景下 close handler 阻塞等待握手内部 6s 超时。
        settleHandshake?.();
        settleHandshake = undefined;
        // await 立即返回（上方已 settle）：保证 header 加速路径或 get_state response 已
        // 完成的回填结果对后续 identity 写入可见。
        await handshakeSettled;
        // 处理 stdout 末尾残留行
        if (stdoutBuffer.trim()) {
          const parsed = parseSpawnLine(stdoutBuffer);
          if (parsed?.kind === "event" && isSdkEvent(parsed.event)) {
            handleSdkEvent(parsed.event);
          }
        }
        resolve(code ?? 0);
      });
      child.on("error", (err: Error) => {
        // spawn 本身失败（command not found 等）
        spawnedChildren.delete(child);
        record.lastError = err.message;
        resolve(SIGNAL_EXIT_CODE_THRESHOLD); // 非零退出
      });
    });

    opts.signal?.removeEventListener("abort", onAbort);
    clearTimeout(watchdog);

    // [持久化 A] sessionFile 兜底校验 + identity entry。
    // session.jsonl 由子进程写入，父进程在子进程退出后（写入完成）補写身份条目。
    // reconstructFromFile 依赖 IDENTITY_CUSTOM_TYPE custom entry 重建 record 身份，
    // 缺失则 /subagents list 磁盘源为空（终态 record 全丢失）。[回归修复]
    if (record.sessionFile) {
      // 兜底：deriveSessionFilePath 推导或握手返回的路径可能不存在（pi 命名规则变化），
      // 用 sessionId 后缀匹配实际文件。匹配到则修正 record.sessionFile。
      // sessionId 来源：header（json mode）优先，其次握手结果（RPC mode）。
      if (!fs.existsSync(record.sessionFile)) {
        const lookupId = sessionHeader?.id ?? handshakeResultRef.current?.sessionId;
        if (lookupId) {
          const actual = findSessionFileByHeaderId(sessionDir, lookupId);
          if (actual) record.sessionFile = actual;
        }
      }
      // 补写 identity custom entry（子进程已退出，append 安全）。
      if (fs.existsSync(record.sessionFile)) {
        const identity: SubagentIdentityData = {
          id: record.id,
          agent: record.agent,
          mode: record.mode,
          task: record.task,
          slug: record.slug,
          startedAt: record.startedAt,
          rootSessionId: record.rootSessionId,
          parentRecordId: record.parentRecordId,
          depth: record.depth,
          forkDepth: opts.fork ? (opts.parentForkDepth ?? 0) + 1 : undefined,
        };
        try {
          fs.appendFileSync(
            record.sessionFile,
            `${JSON.stringify({ type: "custom", customType: IDENTITY_CUSTOM_TYPE, data: identity })}\n`,
            "utf-8",
          );
        } catch (err) {
          // best-effort：identity 写入失败不影响执行结果，但会影响 /subagents list 重建。
          // 记录到 logger（非阻断）—— 终态 record 会从 list 消失，这是可观测的退化信号。
          logger.error(`[subagents] identity append failed for ${record.sessionFile}`, {
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 判定成功/失败（三来源：exitCode + record.lastError + abort 原因）
    let success: boolean;
    let error: string | undefined;
    if (record.lastError) {
      // LLM/provider error 或 abort error 已收口进 record.lastError
      success = false;
      error = record.lastError;
    } else if (exitCode !== 0 && exitCode < SIGNAL_EXIT_CODE_THRESHOLD) {
      // 非信号退出的非零 exit code = 子进程自身报错
      success = false;
      error = stderrBuffer.trim() || `pi subprocess exited with code ${exitCode}`;
    } else if (opts.signal?.aborted) {
      // 用户/调用方 signal 取消（非 maxTurns）——不算成功，但也不算 error
      success = false;
      error = undefined;
    } else {
      // exitCode === 0 或被信号终止（maxTurns 达限 kill）——均视为正常完成
      success = true;
      error = record.lastError;
    }

    // g. collectResult（完全复用——全部从 record 读）
    return collectResult(record, {
      startTime,
      success,
      error,
      sessionId: sessionHeader?.id ?? record.id,
      sessionFile: record.sessionFile,
    });
  } finally {
    // h. 清理临时 prompt 文件
    if (tempPromptFile) {
      await cleanupTempPrompt(tempPromptFile);
    }
  }
}
