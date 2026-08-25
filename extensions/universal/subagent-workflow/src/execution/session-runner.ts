// src/core/session-runner.ts
//
// spawn pi --mode rpc 子进程执行 session 的编排器。零 mode 感知。
//
// spawn 改造后：session 在独立子进程跑（进程隔离），事件经 stdout JSON 流回流。
// runSpawn 是唯一执行入口（sync/background 共用）。mode 分叉在 Runtime.execute 顶部。

import { type ChildProcess, type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";

import { getLogger } from "@zhushanwen/pi-extension-logger";
import { bestEffort } from "./best-effort.ts";
import { armIdleTimer } from "./lifecycle-manager.ts";
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
import { isRelayActive, RELAY_ENV_RECORD_ID, RELAY_ENV_SESSION_ID } from "./relay-env.ts";
import { stringifySchemaCached } from "../shared/schema-jsonify.ts";
import { MAX_FORK_DEPTH } from "./session-context-resolver.ts";
import { EPIPE_FAILURE_THRESHOLD, recordEpipeFailure, sendPromptCommand } from "./stdin-writer.ts";
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

/**
 * [V2 模块 3] agent_settled 事件守卫。对齐 isAgentEndEvt 模式（type 字段窄化，无需 cast）。
 *
 * agent_settled 是 V2 持续对话的「真空闲边界」：agent_end 之后、post-run（compact 检查等）
 * 完成后才 emit（pi `agent-session.js` `_runAgentPrompt` finally 块，约 L744-755）。chatMode 在
 * 此 arm idle timer + 通知本轮完成；非 chatMode 忽略（agent_end handler 已处理一次性 kill）。
 */
function isAgentSettledEvt(x: unknown): x is { type: "agent_settled" } {
  if (typeof x !== "object" || x === null) return false;
  if (!("type" in x)) return false;
  return x.type === "agent_settled";
}

/**
 * 把 pi assistantMessageEvent 分流为 text_delta / thinking_delta AgentEvent，供 streaming 通道。
 *
 * 正向判定：只 text_delta / thinking_delta 产出事件。toolcall_delta（工具入参 JSON 增量，
 * 如 {"path":"..."}）等其他带 delta 的事件不混入 text stream——否则 subagent overlay 的
 * assistant 正文会原样流出工具参数 JSON 串（对话末尾 JSON 与 text 混杂、无 ICON+title 卡片）。
 * 工具调用由 fetchAndInject 拉取的完整历史（toolCall 卡片）展示，不依赖 streaming。
 *
 * 提取为纯函数便于单测（runSpawn 的 handleSdkEvent 闭包不易直接测）。
 */
export function mapAssistantMessageDelta(
  ame: { type?: string; delta?: string },
): { type: "text_delta"; delta: string } | { type: "thinking_delta"; delta: string } | null {
  if (ame.type === "thinking_delta") return { type: "thinking_delta", delta: ame.delta ?? "" };
  if (ame.type === "text_delta" && ame.delta !== undefined) return { type: "text_delta", delta: ame.delta };
  return null;
}

// ============================================================
// 常量
// ============================================================

/** 时间单位换算常量（命名后供 watchdog 系列常量组合，消除裸乘法字面量）。 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** 默认 grace turns（soft limit 后宽限轮数，对齐旧实现 DEFAULT_GRACE_TURNS）。 */
const DEFAULT_GRACE_TURNS = 2;

/** watchdog 下限：30 分钟。兜底防止子进程卡死在单个 tool 内（hang 的 bash/网络读），
 *  导致 turn_end 永不触发、maxTurns limiter 失效、background 槽位/worktree/alive marker 泄漏。
 *  [M-1] 旧实现固定 30 分钟，与 maxTurns 无关——maxTurns=100 的长任务会被误杀。
 *  现改为基于 maxTurns 动态计算（见 computeWatchdogMs）。 */
const WATCHDOG_FLOOR_MINUTES = 30;
const SPAWN_WATCHDOG_FLOOR_MS = WATCHDOG_FLOOR_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/** [M-1] 单 turn 估算耗时：5 分钟（含 LLM 响应 + tool 执行）。
 *  5 分钟是经验值——复杂 tool（大文件读写/长 bash）+ 长 LLM 响应约 3-4 分钟，
 *  留 1-2 分钟余量。下限与按 turn 计算取 max，避免 maxTurns 过小时 watchdog 紧到误杀。 */
const WATCHDOG_MINUTES_PER_TURN = 5;
const WATCHDOG_MS_PER_TURN = WATCHDOG_MINUTES_PER_TURN * SECONDS_PER_MINUTE * MS_PER_SECOND;

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
/** maxTurns 缺省（undefined/null/0）时的估算 turn 数（computeWatchdogMs 兜底）。 */
const DEFAULT_MAX_TURNS_ESTIMATE = 10;

export function computeWatchdogMs(maxTurns: number | undefined | null): number {
  const effectiveTurns = maxTurns && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS_ESTIMATE;
  return Math.max(SPAWN_WATCHDOG_FLOOR_MS, effectiveTurns * WATCHDOG_MS_PER_TURN);
}

/** stderr 累积上限——按字符截断（.slice 语义），非字节；64K 规模沿自原实现。
 *  防止失控子进程打满父进程内存。保留尾部便于诊断。 */
const STDERR_MAX_CHARS = 65_536;

/**
 * 跨包契约 env 名：workflow 子进程把权威 JSON Schema 通过此 env 传给 structured-output 扩展。
 *
 * [跨包契约 SSOT] 此字面量是两个独立 npm 包（@zhushanwen/pi-subagent-workflow 与
 * @zhushanwen/pi-structured-output）之间的隐式 env 契约。structured-output 包内同名常量为
 * `ENV_SCHEMA = "PI_WORKFLOW_SCHEMA"`（见 extensions/universal/structured-output/src/index.ts）。
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

/**
 * worktree 模式注入子 agent 的认知纠正提示。
 *
 * 背景：worktree checkout 放在 os.tmpdir()（如 `/private/var/folders/.../pi-subagents/.../pi-sub-<id>`），
 * 路径形似临时沙箱。子 agent system prompt 无任何 worktree 语义说明时，会误判 cwd 为
 * "空隔离目录"，主动 cd 别处（如主 worktree）放弃隔离——实测见 wave-agent 事故
 *（session 019ff64c T001 自述 cwd 是 pi 隔离目录，实际是合法 worktree checkout）。
 *
 * 此提示在 worktree 模式下注入，明确告知子 agent：cwd 是含完整项目代码的 git worktree，
 * 直接在此工作即可，不要 cd 别处找"真正的项目"。
 */
export const WORKTREE_GUIDANCE_PROMPT = `
## Working Directory Is a Git Worktree

Your working directory (the "Working directory" in the environment block above) is a **dedicated git worktree** — an isolated checkout of the repository at HEAD, NOT a temporary sandbox. It contains the **complete project source code**.

**You should:**
- Work directly in your current cwd — it already has the full project (every file). Read project files via relative paths as usual.
- To locate the shared repository root: \`git rev-parse --git-common-dir\`.
- Your file changes are automatically captured as a patch when you finish — just do the work; no need to commit, push, or merge.

**Do NOT** \`cd\` to another directory looking for "the real project" — your cwd IS the project. A path like \`/private/var/folders/.../pi-subagents/.../pi-sub-<id>\` is your worktree checkout, not an empty sandbox.
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
// 之后，遍历所有仍存活的子进程（含 sync）发 SIGTERM。正常退出路径（子进程 close）会从 Map 移除，
// 不受影响。background 子进程可能被 controller.abort 路径先 kill 一次，再被本遍历 kill 一次
// （对已退出的 child.kill 返回 false，无害）。
//
// [M2-B1] key = record.id（record→child 映射，busy 投递定位活进程用，见 getChildByRecord）。
// [export] 测试可观测（断言 dispose 后 size===0）。业务代码误外部修改。
export const spawnedChildren = new Map<string, ChildProcess>();

/**
 * kill 所有未退出的 spawned 子进程（dispose 兜底用）。
 *
 * 遍历 spawnedChildren Map 的 values()，对每个未 killed 的子进程发 `child.kill(signal)`。
 * 已退出的子进程在 close/error 事件时已从 Map 移除（按句守卫 removeChildRegistration——
 * Map 当前值仍是该 child 才删，防误删 resume spawn 的新注册），故 Map 中只剩「活着的」
 * 或「已被 kill 但 close 事件尚未回调的」。后者用 `child.killed`
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
  for (const child of spawnedChildren.values()) {
    // 跳过已 kill 的（killed=true 表示已调过 child.kill；已退出的在 close/error 时已从 Set 移除）。
    // 不依赖 exitCode/signalCode：close 事件回调可能晚于 dispose，此时它们仍为 null，但子进程
    // 可能已被 controller.abort 路径 kill（killed=true）。
    if (child.killed) continue;
    try {
      child.kill(signal);
      n++;
    } catch (err) {
      // best-effort：单个 kill 失败不影响其他子进程（常见于进程刚退出、句柄竞态），
      // debug 级留诊断线索即可，不刷 info/warn
      logger.debug(
        `[session-runner] killAllSpawnedChildren: kill failed (best-effort continue): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // dispose 全量清理；正常路径的 close/error 事件 delete 保留作 per-child 精细清理，
  // 这里兑底防 close 事件漏触发的极端累积（主进程崩溃后 close 回调可能不再触发，
  // 不 clear 则下次 dispose 会重复向已 kill 的 child 发信号——虽然 killed=true 跳过，
  // 但 Set 无限增长泄漏内存）。
  spawnedChildren.clear();
  return n;
}

/**
 * 按 record id 查活子进程（busy 投递定位用，设计决策 6）。
 *
 * spawnedChildren 的 record→child 映射查询入口。busy 投递（follow_up/steer）需定位
 * record 对应的活 ChildProcess 写 stdin；进程 close/error 后已从 Map 移除，返回 undefined。
 *
 * @param recordId ExecutionRecord.id
 * @returns 活子进程；record 无活进程（未注册 / 已退出）时 undefined
 */
export function getChildByRecord(recordId: string): ChildProcess | undefined {
  return spawnedChildren.get(recordId);
}

/**
 * [M4 记账竞态守卫] 仅当 Map 当前值仍是本 child 句柄时才删除注册。
 *
 * 背景：spawnedChildren 是 Map<recordId, ChildProcess>，resume spawn 会 set 覆盖旧句柄。
 * 旧 child 的 close/error 事件异步到达（kill 后 close 回调可能晚数 tick），若 close/error
 * handler 无条件 delete(record.id)，会误删 resume spawn 刚注册的**新** child——
 * 时序：idle timer 对旧 child SIGTERM（killed=true 但 close 未到）→ deliverMessage 判
 * child.killed 走冷路径 resumeRound → spawn 新 child set 覆盖 → 旧 child close 此刻到达 →
 * 误删新注册。后果：新活进程脱离记账（killAllSpawnedChildren 漏杀孤儿 + getChildByRecord
 * undefined → busy 投递再走冷路径二次 resume → 两进程写同一 session 文件，v4 A-5 注释
 * 自述的 P7 双写者事故模式）。按句相等守卫：set 覆盖后旧句柄 ≠ Map 当前值，天然跳过。
 */
function removeChildRegistration(recordId: string, child: ChildProcess): void {
  if (spawnedChildren.get(recordId) === child) {
    spawnedChildren.delete(recordId);
  }
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
   * [D5a] 返回 Promise（注册表 pid 补全走跨进程锁内 RMW）；实现方保证不 reject
   * （WorktreeRegistry.mutate 内部降级兜底），本侧 fire-and-forget 安全。
   */
  onWorktreePid?: (branch: string, pid: number, sessionFile?: string) => void | Promise<void>;
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
  /**
   * [V2 模块 3] chatMode 本轮完成通知挂载点。
   *
   * V2 决策：chatMode 进程长驻（agent_end 不 kill），「本轮完成」的真空闲边界是
   * `agent_settled`（agent_end 之后、post-run 完成后 emit，见 pi `agent-session.js`
   * `_runAgentPrompt` finally 块），而非 agent_end（agent_end 时 post-run 可能仍在跑）。
   * session-runner 在 agent_settled 时调本回调，调用方（subagent-service）注入
   * notifyComplete 通知父 agent。
   *
   * **本步只定义挂载点，不接线**：subagent-service 未改，回调未注入 = no-op。
   * notify 端到端 + runSpawn resolve 语义重构留 Step 4（与统一投递 + subagent-service
   * 一起系统处理）。非 chatMode 路径不触发 agent_settled handler，本字段无影响。
   *
   * @param record 当前 ExecutionRecord（chatMode、已完成本轮）
   */
  onRoundSettled?: (record: ExecutionRecord) => void;
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

/**
 * 构造 schema 指令模板（拼入 task 末尾 + steer reminder 复用）。
 * 指令明确要求 agent 调用 structured-output tool，而非直接输出 JSON 文本。
 *
 * schema JSON 的 pretty-print（indent=2）由 shared/schema-jsonify.ts 的
 * stringifySchemaCached(schema, "pretty") 产出（IF7：与 resolver 的 compact 版
 * 共享 WeakMap 缓存条目，输出与 JSON.stringify(schema, null, 2) 逐字节一致）。
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
    // IF7(#13)：同 schema 对象引用的 pretty stringify 走 WeakMap 缓存
    // （与 agent-opts-resolver 的 compact 版共享缓存条目，输出逐字节不变）
    stringifySchemaCached(schema, "pretty"),
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
 * git branch 异步获取（execFile），按 cwd 缓存——缓存命中路径返回已 resolve 值零开销，
 * 仅每 cwd 首次调用发起 git（此前为同步阻塞调用，挂载盘慢 git 时阻塞 spawn 链最多 2s）。
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
export async function buildEnvBlock(
  cwd: string,
  forkDepth?: number,
  nestingDepth?: number,
): Promise<string> {
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
    // catch 兜底一切失败（含 execFile 未被 mock 的测试环境）：branch 静默为空，
    // env block 省略 Git branch 行——与旧同步版语义一致
    try {
      branch = await new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          { cwd, encoding: "utf8", timeout: ENV_GIT_TIMEOUT_MS },
          (err: Error | null, stdout: string) => {
            if (err) reject(err);
            else resolve(stdout.trim());
          },
        );
      });
    } catch (err) {
      // 非 git 目录 / git 不在 PATH 是高频正常路径，debug 级留诊断线索即可，不刷 info/warn
      logger.debug(
        `[session-runner] buildEnvBlock: git branch lookup failed for ${cwd}, fallback to empty: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
     * 镜像自主进程 argv 的 flag（--no-extensions/--approve/--extension/--no-context-files）。
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
  // 镜像主进程的 extension/approve/context-files flag：让子进程 extension 加载与
  // context files 行为与主进程一致。undefined/空值时不追加（向后兼容）。顺序紧跟
  // skill 之后，注入类 flag 集中。
  const mf = params.mirrorFlags;
  if (mf) {
    if (mf.noExtensions) args.push("--no-extensions");
    if (mf.approve) args.push("--approve");
    // 镜像 --no-context-files：@zhushanwen/pi-system-prompt（经 --extension 镜像进入
    // 子进程）靠子进程 argv 检测此 flag 守卫全局 AGENTS.md 注入——不镜像则用户的
    // context files opt-out 只对主进程生效，每个 subagent 仍被注入。
    if (mf.noContextFiles) args.push("--no-context-files");
    for (const ep of mf.extensionPaths) {
      args.push("--extension", ep);
    }
  }
  return args;
}

/**
 * [持久化 C] best-effort 写 alive marker（running 期间崩溃恢复用，子进程 pid + session id）。
 *
 * 两处调用点（header 分支 / get_state 握手回填）原为两段相同的空 catch try/catch——
 * 收敛为单函数后失败走 debug 日志（marker 是崩溃恢复的增强信号，缺失只降低可恢复性，
 * 不影响执行主流程），消除 taste/no-silent-catch。
 */
function writeAliveMarkerBestEffort(sessionFile: string, pid: number, id: string): void {
  try {
    writeAliveMarker(sessionFile, { pid, id, startedAt: Date.now() });
  } catch (err) {
    // best-effort：alive marker 失败不影响执行；debug 级留诊断线索即可，不刷 info/warn
    logger.debug(
      `[session-runner] alive marker write failed (best-effort continue): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ============================================================
// [SPAWN 改造] runSpawn 的阶段拆分（max-lines-per-function 383 > 300）
// ============================================================
//
// runSpawn 原为单函数内联全部闭包（事件累积器 / 参数准备 / stdout pump / 退出等待），
// 按执行阶段拆为下方模块级私有函数，闭包状态收拢进 SpawnRunState 经参数传递：
//   - createSpawnEventHandlers：a/b. pendingTools 寄存器 + turnLimiter + handleSdkEvent
//   - writeAppendSystemPromptFile：g. appendSystemPrompt 片段组装与落盘
//   - buildChildEnv：h. 子进程环境变量组装
//   - buildSpawnInvocation：i. pi CLI 参数组装与入口解析
//   - attachStdoutPump：stdout 逐行解析 + get_state 握手状态机 + agent_end keep-alive
//   - waitForChildExit：close/error → exitCode（含统一 cleanup）
// 拆分只移动代码不改行为——runSpawn 导出签名与事件语义不变。

/** runSpawn 各阶段共享的可变状态（原闭包变量收拢，经参数在阶段函数间传递）。 */
interface SpawnRunState {
  record: ExecutionRecord;
  opts: RunOptions;
  ctx: SessionRunnerContext;
  /** 当前子进程句柄（limiter abort 经此 kill）。 */
  proc: ChildProcess | undefined;
  /** watchdog timer（stdout handler 的 agent_end keep-alive 分支重挂，收尾统一 clearTimeout）。 */
  watchdog: NodeJS.Timeout | undefined;
  /** stdout 首行 header（json mode 才有；RPC mode 恒 undefined）——收尾 sessionFile 兜底查找用。 */
  sessionHeader: SpawnSessionHeader | undefined;
  /** get_state 握手结果（RPC mode）——收尾 sessionFile 兜底查找用。 */
  handshakeResult: GetStateResult | undefined;
  /**
   * [V2 决策 2] chatMode 首轮 resolveRun：agent_settled 时提前 resolve runSpawn 的
   * exitCode promise（waitForChildExit 装配指向）。非 chatMode 不触发（agent_end
   * handler 一次性 kill → close resolve）。chatMode 后续轮次到达时 resolve(code)
   * 是 no-op（Promise 只 resolve 一次）。
   */
  resolveRun: ((code: number) => void) | undefined;
}

/**
 * 事件累积器工厂（原 runSpawn 内联的 a/b 两段 + handleSdkEvent/agentEvent 闭包）。
 *
 * pendingTools 寄存器 / turnLimiter / accumulateMessageEnd 均闭包在工厂内部，
 * 对外只暴露 handleSdkEvent（stdout 解析出的 SdkEvent 的唯一喂入口）。
 */
function createSpawnEventHandlers(state: SpawnRunState): (raw: SdkEvent) => void {
  const { record, opts, ctx } = state;

  // a. transient 寄存器（同 run()：tool_end 缺 args 时回填）
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  // b. turnLimiter（spawn 版：abort = proc.kill；steer 是 no-op）
  // [M1] rpc mode 是长驻进程（agent_end 后不自动退出），maxTurns soft limit 依赖
  // graceTurns 后的 abort（proc.kill SIGTERM）兑现。agent 自然结束时由 stdout pump
  // 的 agent_end 拦截 kill（见 attachStdoutPump）。steer 通道当前未接通（见下方 steer no-op 注释）。
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
    steer: () => {
      // no-op：当前 runSpawn 未接通 rpc stdin steer 通道（rpc mode 支持 steer/followUp，
      // 但未实现写入逻辑）。补偿已在启动时注入 WRAP_UP_HINT 让 agent 主动收尾。
    },
    abort: () => {
      state.proc?.kill("SIGTERM");
    },
  });

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
    // [V2 模块 3] agent_settled：真空闲边界（agent_end 之后、post-run 完成后才 emit）。
    // chatMode：arm idle timer（超时 SIGTERM 回收）+ 通知本轮完成（onRoundSettled）。
    // 非 chatMode：忽略（agent_end handler 的一次性 kill 已处理，进程不会活到 agent_settled）。
    if (isAgentSettledEvt(raw)) {
      if (record.chatMode) {
        armIdleTimer(record.id, () => {
          // onTimeout 复用现有 kill 路径：child.kill("SIGTERM") 触发 close → close handler
          // 统一 cleanup（spawnedChildren.delete / get_stateListeners.clear / resolve）。
          // 与 agent_end handler 现有 SIGTERM 分支一致，不新造 cleanup。
          const child = getChildByRecord(record.id);
          if (child && !child.killed) child.kill("SIGTERM");
        }, record.idleTimeoutMs);
        // [SP-9] chatMode 每轮 reset turn-limiter：新一轮开始（续聊）时，
        // maxTurns/graceTurns 不跨轮累计（续聊本质是无限轮，累计上限违背 G1）。
        // reset steered/aborted 标志 + turnCount 归零，下一轮独立计数。
        limiter.reset();
        record.turnCount = 0;
        ctx.onRoundSettled?.(record);
        // [V2 决策 2] chatMode 首轮：agent_settled = 本轮真空闲，提前 resolve runSpawn
        //（exit code 0，进程仍保活 idle timer armed）。runAndFinalize 拿到 result 后走
        // chatMode 首轮分支（不进 finalize 分流），onRoundSettled 已 notify 主 agent。
        state.resolveRun?.(0);
      }
      return;
    }
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
        const mapped = mapAssistantMessageDelta(raw.assistantMessageEvent ?? {});
        if (mapped) agentEvent(mapped);
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
      // [review 修复] 已删除 turn_start / message_start 两 case 的 pendingMessages
      // 消费确认 shift（MF-5）：三段消费链（deliverToRunning push / message_start(user)
      // shift / redeliverPending 补投）随 deliverToRunning 一并移除——SP-5 upgrade 后
      // 无生产调用方，整条链路不可达。两 case 均为 no-op，落 default 即可。
      default:
        return;
    }
  };

  return handleSdkEvent;
}

/**
 * g. appendSystemPrompt 落盘：env block + agent body + 调用方片段拼成
 * --append-system-prompt 文件。返回临时文件句柄（无片段时 undefined，
 * runSpawn finally 统一清理）。
 */
async function writeAppendSystemPromptFile(
  record: ExecutionRecord,
  opts: RunOptions,
  ctx: SessionRunnerContext,
): Promise<{ dir: string; filePath: string } | undefined> {
  // [M1 恢复] 环境块（cwd / fork depth / git branch）拼在最前面，与旧 in-process
  // buildAppendSystemPrompt 顺序一致——parts[0] 是环境块，其后 agent systemPrompt、再后调用方片段。
  const ownForkDepth = opts.fork ? (opts.parentForkDepth ?? 0) + 1 : undefined;
  // [M9] buildEnvBlock 取 max(forkDepth, nestingDepth)：record.depth === nestingDepth（都从
  // execCtxAls 派生，见 createRecordForMode L425-427 与 execute L257-258），传它让 env block
  // 展示更严的约束（混合嵌套链下通用护栏可能先于 fork 护栏拒绝）。
  const appendParts: string[] = [await buildEnvBlock(ctx.cwd, ownForkDepth, record.depth)];
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
  // worktree 认知纠正：告知子 agent cwd 是 git worktree（非临时沙箱），含完整项目代码，
  // 直接在此工作。防 wave-agent 类误判 cwd 为空隔离目录后 cd 主 worktree 放弃隔离。
  if (opts.worktree) {
    appendParts.push(WORKTREE_GUIDANCE_PROMPT);
  }
  if (appendParts.length > 0) {
    return writePromptToTempFile(record.agent, appendParts.join("\n\n"));
  }
  return undefined;
}

/**
 * h. 子进程环境变量组装：继承 process.env + fork depth + 跨进程身份贯穿 4 元组 +
 * identity 专属字段 + worktree 隔离标志 + schemaEnv bridge。
 */
function buildChildEnv(
  record: ExecutionRecord,
  opts: RunOptions,
  ctx: SessionRunnerContext,
): Record<string, string | undefined> {
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
  // [M4 identity 子进程写] 子进程 session_start hook 读这些 env → pi.appendEntry 写
  // subagent-identity custom entry（V2 决策 5）。旧实现父进程 fs.appendFileSync 补写的
  // custom entry 缺 id/parentId → 污染 pi _buildIndex leafId → message tree 断成两棵
  // → 多轮对话丢上下文。改由子进程（session 文件所有者）用 appendEntry 写，pi 自动生成 id/parentId。
  // id/rootSessionId/depth/forkDepth 复用上方身份贯穿 env（SELF_RECORD_ID/ROOT_SESSION_ID/DEPTH/FORK_DEPTH），
  // 此处补 identity 专属字段：agent/mode/task/slug/startedAt/parentRecordId/chatMode。
  childEnv.PI_SUBAGENT_AGENT = record.agent;
  childEnv.PI_SUBAGENT_MODE = record.mode;
  childEnv.PI_SUBAGENT_TASK = record.task;
  childEnv.PI_SUBAGENT_SLUG = record.slug;
  childEnv.PI_SUBAGENT_STARTED_AT = String(record.startedAt);
  childEnv.PI_SUBAGENT_PARENT_RECORD_ID = record.parentRecordId;
  childEnv.PI_SUBAGENT_CHAT_MODE =
    record.chatMode !== undefined ? String(record.chatMode) : undefined;
  // [review round2] worktree 隔离标志贯穿：resume 轮 opts.worktree 来自 record.worktreeHandle
  //（同进程内保留），子进程 identity entry 据此记 worktree:true——跨重启重建时据此拒绝续聊
  //（WorktreeHandle 不可序列化，reattach 不可行，静默回落主 repo 会破坏隔离）。
  childEnv.PI_SUBAGENT_WORKTREE = opts.worktree !== undefined ? "true" : undefined;
  // [E 方案 §5.2-2] relay 帧归属 env：tee 帧路由键（→ 虚拟分区 subagent:<sid>:<rid>）。
  // 仅 relay 激活时写入实际值——未激活环境下子 pi 进程携带 record 值 env 是误导噪声
  //（归属 env 无消费者）；{...process.env} 继承值照旧保持。同源性对齐上方 PI_SUBAGENT_*
  // 四元组：SESSION_ID = ctx.sessionRootId（嵌套 spawn 时孙进程仍归属真 ROOT 会话），
  // RECORD_ID = record.id。
  if (isRelayActive(process.env)) {
    childEnv[RELAY_ENV_SESSION_ID] = ctx.sessionRootId;
    childEnv[RELAY_ENV_RECORD_ID] = record.id;
  }
  // D-A6 bridge: schema 激活 structured-output 扩展注册 tool（workflow 编排层需要）
  applySchemaEnvToChildEnv(childEnv, opts.schemaEnv);
  return childEnv;
}

/**
 * i. 组装 spawn args 并解析 pi 可执行入口。
 */
function buildSpawnInvocation(
  opts: RunOptions,
  ctx: SessionRunnerContext,
  resume: SpawnResumeOpts | undefined,
  tempPromptFile: { dir: string; filePath: string } | undefined,
  sessionDir: string,
  forkSource: string | undefined,
): ReturnType<typeof getPiInvocation> {
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
  return getPiInvocation(spawnArgs);
}

/** attachStdoutPump 返回的共享句柄（waitForChildExit / get_state 握手启动消费）。 */
interface StdoutPumpHandles {
  /** get_state RPC response 监听器注册（performGetStateHandshake 经此挂 resolver）。 */
  registerGetStateListener(id: string, resolver: (data: unknown) => void): void;
  /** 握手完成统一入口：记录结果 + 回填 sessionFile + 写 alive marker + settle。 */
  finishHandshake(r: GetStateResult): void;
  /** 立即放弃握手（close handler 用：子进程已退出，response 不会再来）。 */
  abandonHandshake(): void;
  /** 握手是否仍未 settle（header 加速路径 / get_state then 分支的覆盖守卫）。 */
  isHandshakePending(): boolean;
  /** 握手 settle promise（close handler await，保证回填结果对后续 identity 写入可见）。 */
  readonly handshakeSettled: Promise<void>;
  /** 处理 stdout 末尾残留行（无换行结尾的最后一段，close handler 用）。 */
  processTrailingLine(): void;
  /** 清空 get_state 监听器（子进程已退出，无更多 response）。 */
  clearGetStateListeners(): void;
}

/**
 * stdout pump + get_state 握手状态机（原 runSpawn 内联的 stdout data handler 整体迁入）。
 *
 * 逐行解析 stdout：header（json mode）/ SdkEvent / RPC response / UI 请求分发；
 * agent_end（willRetry=false）的条件 kill（keep-alive 分支重挂 state.watchdog）也在此。
 * 返回 StdoutPumpHandles 供 close handler 与握手启动方消费。
 */
function attachStdoutPump(
  child: ChildProcessWithoutNullStreams,
  state: SpawnRunState,
  sessionDir: string,
  handleSdkEvent: (raw: SdkEvent) => void,
): StdoutPumpHandles {
  const { record, opts, ctx } = state;

  // stdout pump：逐行解析 → handleSdkEvent / enqueueUiRequest
  const enqueueUiRequest = createUiRequestQueue(child, ctx);
  // FR-4: get_state RPC response 监听器（id → resolver）。
  // parseSpawnLine 返回 kind:"response" 时，按 command+id 匹配 resolver。
  const get_stateListeners = new Map<string, (data: unknown) => void>();
  let stdoutBuffer = "";

  // [#18] 握手状态变量在 stdout handler 注册之前定义，消除"handler 闭包依赖同 tick
  // 后续 const 初始化"的隐式顺序假设——handler 现在直接引用已初始化的变量，不靠
  // "data 事件必然在下一 tick 才触发"的运行时不变式兜底。
  let settleHandshake: (() => void) | undefined;
  const handshakeSettled: Promise<void> = new Promise((resolveSettled) => {
    settleHandshake = resolveSettled;
  });

  const settleHandshakeNow = (): void => {
    settleHandshake?.();
    settleHandshake = undefined;
  };

  /** 握手完成统一入口：记录结果 + 回填 sessionFile + 写 alive marker + settle。 */
  const finishHandshake = (r: GetStateResult): void => {
    state.handshakeResult = r;
    // 仅当 header 未先行设置 record.sessionFile 时回填（RPC mode 路径）。
    if (r.sessionFile && !record.sessionFile) {
      record.sessionFile = r.sessionFile;
      if (child.pid) {
        writeAliveMarkerBestEffort(r.sessionFile, child.pid, r.sessionId ?? record.id);
      }
    }
    settleHandshakeNow();
  };

  child.stdout.on("data", (data: string) => {
    stdoutBuffer += data;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? ""; // 保留最后未完整行
    for (const line of lines) {
      const parsed = parseSpawnLine(line);
      if (!parsed) continue;
      if (parsed.kind === "header") {
        state.sessionHeader = parsed.header;
        // 回填 record.sessionFile（deriveSessionFilePath 推导路径）
        record.sessionFile = deriveSessionFilePath(parsed.header, sessionDir);
        // [持久化 C] alive marker：running 期间崩溃恢复用。子进程 pid + session id。
        // 与 in-process 逻辑对齐（记 sessionFile + pid），改为子进程 pid。
        if (record.sessionFile && child.pid) {
          writeAliveMarkerBestEffort(record.sessionFile, child.pid, parsed.header.id);
        }
        // [全局注册表] worktree 模式：补全注册表条目的 pid。
        // create 时 pid 未知写 0 占位，此处拿到 child.pid 后回调 WorktreeManager.registerPid。
        // 取代旧的 .session mapping sidecar——注册表是 reaper 的唯一数据源。
        // [D5a] fire-and-forget：回调内部走跨进程锁（毫秒级），且实现方保证不
        // reject（锁降级兜底）；stdout data 回调是同步上下文，不 await。
        if (opts.worktree && child.pid) {
          // 透传 record.sessionFile：填入 registry entry（reaper 据 pid 死活判孤儿），
          // first header 时 sessionFile 已回填（deriveSessionFilePath 在本分支上方）。
          try {
            void ctx.onWorktreePid?.(opts.worktree.branch, child.pid, record.sessionFile);
          } catch (err) {
            // 同步段异常（回调本身 throw）不阻断 stdout 解析；锁内错误由回调内部 warn。
            bestEffort(err, "onWorktreePid callback (first header)");
          }
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
            // [V2 决策 1] chatMode：对话模式进程不因轮次死。agent_end 不 kill、不 MF-3/MF-4。
            // 等待 agent_settled（真空闲信号）arm idle timer + notify（onRoundSettled）。
            // 用 continue 而非 return：return 会跳出 stdout data handler 的 for(line) 循环，
            // 丢弃同一 flush 内 agent_end 之后的事件（如紧随的 agent_settled）。continue 只
            // 跳过当前行剩余（handleSdkEvent 对 agent_end 是 no-op），继续处理后续行。
            if (record.chatMode) {
              continue;
            }
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
              clearTimeout(state.watchdog);
              state.watchdog = setTimeout(() => child.kill("SIGTERM"), computeWatchdogMs(opts.maxTurns));
              state.watchdog.unref();
            } else if (pending.recentUnregister) {
              // 差集 0 但最近有 unregister：后代刚完成，notify 唤醒可能在路上（竞态窗口），
              // 保持进程——父被唤醒后的下一次 agent_end 会正常判定。
              // [MF-3] 秒级宽限：此分支在每层「最终 turn」必命中（closeout 的 agent_end 距
              // 最后一次 unregister <60s），挂长超时 = 空等 2h 才 kill + 冒牌完成通知级联。
              // 15s 内无新 agent_end（未被唤醒）即 kill；被唤醒后下一次 agent_end 重新评估。
              logger.debug(
                "[session-runner] agent_end: keep alive, recent descendant completion (wake-up in flight)",
              );
              clearTimeout(state.watchdog);
              state.watchdog = setTimeout(() => child.kill("SIGTERM"), WAKEUP_GRACE_MS);
              state.watchdog.unref();
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

  return {
    registerGetStateListener: (id, resolver) => {
      get_stateListeners.set(id, resolver);
    },
    finishHandshake,
    abandonHandshake: settleHandshakeNow,
    isHandshakePending: () => settleHandshake !== undefined,
    handshakeSettled,
    processTrailingLine: () => {
      // 处理 stdout 末尾残留行
      if (stdoutBuffer.trim()) {
        const parsed = parseSpawnLine(stdoutBuffer);
        if (parsed?.kind === "event" && isSdkEvent(parsed.event)) {
          handleSdkEvent(parsed.event);
        }
      }
    },
    clearGetStateListeners: () => {
      get_stateListeners.clear();
    },
  };
}

/**
 * 等待子进程退出（close/error → exitCode，原 runSpawn 内联的 exit promise 迁入）。
 *
 * [V2 决策 2] resolveRun 指向本 promise 的 resolve：chatMode 首轮 agent_settled 时
 * 由 handleSdkEvent 提前调 resolveRun(0)，close 最终到达时 resolve(code) 是 no-op。
 * close handler 统一执行 cleanup（句柄移除 / 握手放弃 / 残留行处理）。
 */
function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  state: SpawnRunState,
  spawnCwd: string,
  pump: StdoutPumpHandles,
): Promise<number> {
  return new Promise<number>((resolve) => {
    state.resolveRun = resolve;
    child.on("close", async (code: number | null) => {
      // [C1] 子进程已退出，从 orphan-tracking Map 移除（dispose 兜底无需再 kill 它）。
      // [M4] 按值守卫：close 事件晚于 resume spawn 到达时不误删新 child 注册。
      removeChildRegistration(state.record.id, child);
      // FR-4: 清理 get_state 监听器（子进程已退出，无更多 response）
      pump.clearGetStateListeners();
      // FR-4: 子进程已退出，get_state response 不会再来。若握手仍未 settle，立即放弃
      //（record.sessionFile 未回填则走 findSessionFileByHeaderId 兜底）。避免子进程快速
      // 失败/退出场景下 close handler 阻塞等待握手内部 6s 超时。
      pump.abandonHandshake();
      // await 立即返回（上方已 settle）：保证 header 加速路径或 get_state response 已
      // 完成的回填结果对后续 identity 写入可见。
      await pump.handshakeSettled;
      // 处理 stdout 末尾残留行
      pump.processTrailingLine();
      resolve(code ?? 0);
    });
    child.on("error", (err: Error) => {
      // spawn 本身失败（command not found 等）
      // [worktree-reaper-fix] 拼 spawnCwd 进错误消息：ENOENT 的 err.message 只含 command 名，
      // 无 cwd 线索（worktree 被 reaper 误删后 cwd 指向虚空）会导致误诊——2026-08-11 事故
      // AI 误判"node 被卸载"的直接原因。
      // [M4] 按值守卫：error 事件晚于 resume spawn 到达时不误删新 child 注册。
      removeChildRegistration(state.record.id, child);
      // [S3] code 读取带运行时 guard：非 ErrnoException（普通 Error）时 code 为 undefined，
      // 不加 cwd hint（行为与修复前一致）；仅 ENOENT 才拼 cwd。
      const errno = err as NodeJS.ErrnoException;
      const errCode = "code" in err ? errno.code : undefined;
      const cwdHint = errCode === "ENOENT" ? ` (cwd: ${spawnCwd})` : "";
      state.record.lastError = `${err.message}${cwdHint}`;
      resolve(SIGNAL_EXIT_CODE_THRESHOLD); // 非零退出
    });
  });
}

/**
 * spawn pi 子进程执行 session。
 *
 * 契约与 run() 一致：正常路径不抛错（prompt 失败/turn-limit abort/子进程崩溃
 * 均合成 failed AgentResult 返回）。创建期异常（spawn 本身失败）会抛。
 *
 * [拆分] 各执行阶段（事件累积 / 参数准备 / stdout pump / 退出等待）拆到上方
 * 模块级函数，闭包状态经 SpawnRunState 传递——只移动代码不改行为。
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

  // 各阶段共享状态（原闭包变量收拢：proc / watchdog / sessionHeader / handshakeResult / resolveRun）
  const state: SpawnRunState = {
    record,
    opts,
    ctx,
    proc: undefined,
    watchdog: undefined,
    sessionHeader: undefined,
    handshakeResult: undefined,
    resolveRun: undefined,
  };

  // a/b. 事件累积器（pendingTools 寄存器 + turnLimiter + handleSdkEvent/agentEvent 闭包）
  const handleSdkEvent = createSpawnEventHandlers(state);

  // c. schema 指令拼到 task 末尾（替代 in-process 的 turn_end steer 循环）
  const instruction = opts.schema ? formatSchemaInstruction(opts.schema) : "";
  const fullTask = task + instruction;

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

  // g. appendSystemPrompt 落盘（env block + agent body + 调用方片段）
  const tempPromptFile = await writeAppendSystemPromptFile(record, opts, ctx);

  // h. 子进程环境变量（fork depth / 身份贯穿 / identity / worktree 标志 / schemaEnv）
  const childEnv = buildChildEnv(record, opts, ctx);

  // i. 组装 args + 解析 pi 可执行入口
  const invocation = buildSpawnInvocation(opts, ctx, resume, tempPromptFile, sessionDir, forkSource);

  // 累积 stderr（错误诊断用）
  let stderrBuffer = "";

  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: spawnCwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    state.proc = child;
    // [worktree-reaper-fix] 同步补全注册表 pid：spawn 返回后 child.pid 立即可得（Node.js
    // 同步属性），无需等任何 stdout 事件。原补全点挂在 header 分支（下方 stdout handler 内），
    // 而 RPC mode（buildSpawnArgs 固定 --mode rpc）不输出 header 行——pid 恒为 0，超
    // SPAWN_GRACE_MS 后被 reaper 当孤儿误删活 worktree（2026-08-11 cw 递归编排整树失活事故）。
    // header 分支调用保留：json mode 回切时仍能补全，updatePid 同 branch 覆盖写幂等，无副作用。
    if (opts.worktree && child.pid) {
      // [D5a] void：回调可能返回 Promise（锁内 RMW），契约保证不 reject，fire-and-forget。
      void ctx.onWorktreePid?.(opts.worktree.branch, child.pid);
    }
    // [C1] track 子进程供 dispose 兜底 kill（sync + background 均注册——sync 无 controller，
    // abortRunningControllers 跳过它，靠本 Map 兜底）。close/error 后按句守卫移除（已退出无需再 kill）。
    spawnedChildren.set(record.id, child);
    // [V2 决策 3] spawn 后 child.pid 同步立即可得，记录到 record 内存（lifecycle-manager
    // 孤儿扫描用，Step 5 接入持久化）。resume spawn 时此处同样覆盖更新（pid 可能已变）。
    if (child.pid !== undefined) record.pid = child.pid;

    // [worktree-reaper-fix] 同步补全注册表 pid：spawn 返回后 child.pid 立即可得（Node.js
    // 同步属性），无需等任何 stdout 事件。原补全点挂在 header 分支（下方 stdout handler 内），
    // 而 RPC mode（buildSpawnArgs 固定 --mode rpc）不输出 header 行——pid 恒为 0，超
    // SPAWN_GRACE_MS 后被 reaper 当孤儿误删活 worktree（2026-08-11 cw 递归编排整树失活事故）。
    // header 分支调用保留：json mode 回切时仍能补全，updatePid 同 branch 覆盖写幂等，无副作用。
    // [S1] 防御：必须放在 spawnedChildren.add 之后（onWorktreePid 抛错时子进程已被跟踪，
    // dispose 兜底 kill 不会泄漏），且包 try/catch（补全失败不阻断 spawn 主流程——
    // 注册表写失败最坏后果是条目停留 pid=0，由 reaper 宽限回收兜底）。
    if (opts.worktree && child.pid) {
      try {
        // [D5a] void：回调可能返回 Promise（锁内 RMW），契约保证不 reject，fire-and-forget。
        void ctx.onWorktreePid?.(opts.worktree.branch, child.pid);
      } catch (err) {
        logger.warn("[worktree] worktree pid registration failed (defensive)", {
          branch: opts.worktree.branch,
          pid: child.pid,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // stdout/stderr 用 utf8 编码：stream 自动按字符边界切分，避免多字节
    // UTF-8（CJK/emoji）跨 chunk 时 toString() 产生 U+FFFD 替换符导致 JSON.parse 失败。
    // [m2] 先 setEncoding 再注册 signal listener/watchdog：若 setEncoding 抛错，try/finally
    //（下方）只清理 tempPromptFile，watchdog/signal listener 尚未注册则无需清理——避免泄漏。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // [v4 A-1] 异步 stdin 'error' listener。writeStdinLine 的 try/catch 只覆盖同步 write 抛错；
    // 子进程退出后内核回写 EPIPE 会以异步 stream 'error' event 到达，若无 listener 会让 Node
    // 抛 unhandled 'error' 崩主进程（P1）。必须在首次 stdin 写入（下方 sendPromptCommand）前注册。
    // handler 行为：①移出 spawnedChildren 标记 dead（与 child.on('error') 同模式）；
    // ②recordEpipeFailure 合并同步/异步计数；③logger.warn 记录一次。
    // [v4 A-1 裁决] handler 内**不 throw**——stream 'error' listener 内 throw 会经 Node 内部
    // emit() 传播为 uncaughtException 崩主进程，违背 A-1 防崩核心目标。达阈值的 throw 留给
    // 同步路径（deliverMessage catch 合并计数达 EPIPE_FAILURE_THRESHOLD 时同步 throw，不崩）。
    // async handler 只移句柄 + 计数 + warn；进程已 dead（移句柄），下次 deliverMessage 检测
    // dead 走冷路径，冷路径 write EPIPE 同步计数达阈值同步 throw——防死循环且不崩。
    child.stdin.on("error", (err: Error) => {
      // [M4] 按值守卫：resume spawn 已覆盖注册时不误删新 child（见 removeChildRegistration）
      removeChildRegistration(record.id, child);
      const count = recordEpipeFailure(record.id);
      logger.warn(`[subagents] async stdin error for ${record.id}`, {
        detail: err.message,
        epipeCount: count,
        threshold: EPIPE_FAILURE_THRESHOLD,
        hint:
          count >= EPIPE_FAILURE_THRESHOLD
            ? "sync path will throw on next write EPIPE"
            : undefined,
      });
    });

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
    state.watchdog = setTimeout(() => child.kill("SIGTERM"), watchdogMs);
    state.watchdog.unref();

    // [recursive-orchestration] agent_end 有活跃后代时的等待超时（不 kill 分支的兑底）。
    // 层主 subagent 空闲等待后代完成（steer 唤醒）期间不产生 turn，原 watchdog 已清；
    // 此后代卡死（永不完成）时此 timer 保证进程最终回收。超时 kill → finalize 视为正常
    // 完成 → 通知父（父查 cw status 发现未 closed 会走 L2/L3 重派，见 planning-agent 模板）。

    // stdout pump：逐行解析 → handleSdkEvent / enqueueUiRequest + get_state 握手状态机
    const pump = attachStdoutPump(child, state, sessionDir, handleSdkEvent);

    // FR-4: get_state RPC 握手——spawn 后无条件启动。
    // RPC mode（pi --mode rpc）不向 stdout 输出 header，record.sessionFile 无法靠 header
    // 推导，必须通过 get_state RPC 查询子进程回填。json mode 下 header 会先到达触发提前
    // resolve（加速路径），握手仍启动但无害——response 到达时外层已 resolve，resolver
    // 因 resolved=true 直接 return。
    //
    // 时序：握手在 stdout pump（get_stateListeners 已就绪）之后启动。get_state 命令写入
    // stdin，pi rebindSession 后读取并返回 response，经 stdout pump 匹配 resolver 触发 resolve。
    // close handler await handshakeSettled，保证无论 task 多快结束，close 时 sessionFile 已回填。
    // [#18] 握手状态变量已在 attachStdoutPump 内部（stdout handler 注册前）定义，此处直接发起握手。
    void performGetStateHandshake(child, pump.registerGetStateListener).then((r) => {
      // header 加速路径下 settleHandshake 已 undefined，跳过（避免覆盖 header 结果）。
      // 超时兜底（r 为空对象）也经此分支 settle，但 record.sessionFile 不回填。
      if (pump.isHandshakePending()) pump.finishHandshake(r);
    });

    child.stderr.on("data", (data: string) => {
      // 截断防 OOM：失控子进程持续打 stderr 会耗尽父进程内存。保留尾部便于诊断。
      stderrBuffer = (stderrBuffer + data).slice(-STDERR_MAX_CHARS);
    });

    // 等待子进程退出
    const exitCode = await waitForChildExit(child, state, spawnCwd, pump);

    opts.signal?.removeEventListener("abort", onAbort);
    clearTimeout(state.watchdog);

    // [持久化 A] sessionFile 兜底校验。
    // identity custom entry 已改由子进程 session_start hook 写（M4 / V2 决策 5），
    // 父进程不再 fs 补写——fs 补写的 entry 缺 id/parentId 污染 pi _buildIndex。
    // 此处仅保留 sessionFile 路径兜底（deriveSessionFilePath/握手路径可能不准）。
    if (record.sessionFile) {
      // 兜底：deriveSessionFilePath 推导或握手返回的路径可能不存在（pi 命名规则变化），
      // 用 sessionId 后缀匹配实际文件。匹配到则修正 record.sessionFile。
      // sessionId 来源：header（json mode）优先，其次握手结果（RPC mode）。
      if (!fs.existsSync(record.sessionFile)) {
        const lookupId = state.sessionHeader?.id ?? state.handshakeResult?.sessionId;
        if (lookupId) {
          const actual = findSessionFileByHeaderId(sessionDir, lookupId);
          if (actual) record.sessionFile = actual;
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
      sessionId: state.sessionHeader?.id ?? record.id,
      sessionFile: record.sessionFile,
    });
  } finally {
    // h. 清理临时 prompt 文件
    if (tempPromptFile) {
      await cleanupTempPrompt(tempPromptFile);
    }
  }
}
