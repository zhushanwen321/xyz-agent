// src/core/session-runner.ts
//
// spawn pi --mode rpc 子进程执行 session 的编排器。零 mode 感知。
//
// spawn 改造后：session 在独立子进程跑（进程隔离），事件经 stdout JSON 流回流。
// runSpawn 是唯一执行入口（sync/background 共用）。mode 分叉在 Runtime.execute 顶部。

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
  spawnSync,
} from "node:child_process";
import * as fs from "node:fs";

import { getLogger } from "../core/logger.ts";
import { bestEffort } from "./best-effort.ts";
import { disposeEngines } from "./engine/registry.ts";
import { armIdleTimer, DEFAULT_IDLE_TIMEOUT_MS } from "./lifecycle-manager.ts";
import {
  listActivePendingFromSessionFile,
  prunePendingCursor,
  readActivePendingFromSessionFile,
  type ActivePendingResult,
} from "./session-pending.ts";

import type { ExtensionMode } from "./host-mode.ts";

import { type MirrorFlags, mirrorMainProcessFlags } from "./argv-mirror.ts";
import { isProcessAlive, readAliveMarker, writeAliveMarker } from "./alive-store.ts";
import { type DialogGlobalQueue, type UiRequestHandler } from "./dialog-queue.ts";
import { updateFromEvent } from "./execution-record.ts";
import {
  type AddGetStateResponseListener,
  type GetStateResult,
  performGetStateHandshake,
  requestGetStateOnce,
} from "./get-state-handshake.ts";
import { willRespondToAskUser } from "./host-mode.ts";
import type { AgentConfig, ResolvedModel } from "./model-resolver.ts";
import { collectResult } from "./output-collector.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { isRelayActive, RELAY_ENV_RECORD_ID, RELAY_ENV_SESSION_ID } from "./relay-env.ts";
import { assertThinkingLevel, type ThinkingLevel } from "../shared/model-ref";
import {
  SCHEMA_ENV_MAX_BYTES,
  SCHEMA_ENV_VAR,
  schemaEnvByteLength,
} from "../shared/schema-env.ts";
import { assertSafeTimerDelay } from "../shared/timer-delay.ts";
import {
  armSettledWatchdog,
  disarmSettledWatchdog,
  SETTLED_WATCHDOG_TIMEOUT_MS,
} from "./settled-watchdog.ts";
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
 *  现改为基于 maxTurns 动态计算（见 maxTurnsToWatchdogMs）。 */
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
//   - 有活跃后代（count>0 / error）→ resolveSpawnWatchdogMs(maxTurns) 动态超时
//     （MF-4，不误杀慢后代；maxTurns 未传且无兑底 env 时不挂 timer，不限时等待）
//   - 仅 recentUnregister 竞态 → WAKEUP_GRACE_MS 秒级宽限（MF-3，不空等 2h）

/** [MF-3] agent_end keep-alive 的 recentUnregister 竞态宽限（ms）。
 *  notify steer 唤醒的竞态宽限——15s 内无新 agent_end（未被唤醒）即 kill；
 *  被唤醒后下一次 agent_end 重新评估。不用长超时：层主 closeout 的最终 agent_end
 *  必然命中此分支（距最后一次 unregister <60s），挂长超时 = 空等 2h 才回收
 *  + 冒牌完成通知级联。
 *  [export] 测试可观测（run-spawn-edges MF-3 用例用 fake timers 断言 15s 后 kill）。 */
export const WAKEUP_GRACE_MS = 15_000;

/**
 * [T2-① / P-T2 降级路径 B] keep-alive 裸缺省无进展检测的连续静默阈值（30min）。
 *
 * P-T2 探针裁决（probe/p-t2-report.md）：历史 89 样本 96.6% keep-alive 窗口 >30min
 * （P50=24.5min、长尾 95.5h、85/89 由 parent-shutdown 合法收敛）——固定 30min 上限
 * 会大面积误杀，「wave keep-alive 数小时是合法形态」被数据证实。按设计降级路径 B
 * 落地：上界语义从固定时长改为**无进展检测**——keep-alive 期间任何子进程 stdout
 * 活动刷新计时，仅**连续静默**达此阈值才处置（SIGTERM→SIGKILL 升级）。
 *
 * 阈值取 30min（对齐 SPAWN_WATCHDOG_FLOOR_MS 的旧 floor 量级）：真实 keep-alive 的
 * 合法性由「仍在活动」定义而非「不超过某时长」。层主 stdout 静默 ≠ 无进展——
 *「直接后代跑 >30min、层主静默」是合法形态（P-T2 数据 85/89 parent-shutdown 即此类，
 * 层主侧 stdout 刷新面看不到后代集合变化），故 fire 时不立即处置：先惰性复核层主是否
 * 有存活活跃后代（pending 差集 + 后代 pid 存活，与 descendant sweep 同源判据），有 →
 * 视为有进展重挂本 timer（固定 30min 复核节奏直到后代死光），无 → 真静默才处置。
 * 挂载面严格限定裸缺省（maxTurns/env 双缺省才挂）——显式 maxTurns<=0（显式不限时）
 * 与 resolveSpawnWatchdogMs fail-fast 降级不挂任何 timer（opt-out 保留）。
 * [export] 测试可观测（keep-alive-no-progress 用例锚定静默阈值、刷新与 fire 复核语义）。
 */
export const KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS = SPAWN_WATCHDOG_FLOOR_MS;

/**
 * [T1/RC-1] agent_end 决策点惰性回补的单次 get_state 超时预算（ms）。
 *
 * P-T1 探针实证（probe/p-t1-report.md）：agent_end 时 idle 子进程应答 0.3-0.4ms，
 * 1s 预算有 ~2500 倍余量。回补超时/失败不重试——走既有保守分支（行为不劣化），
 * 不把决策点变成第二个重试循环（与「被否：加长握手重试」的裁决一致）。
 */
const LAZY_GET_STATE_TIMEOUT_MS = 1000;

/**
 * [M-1] maxTurns → watchdog 毫秒换算（纯函数，可导出复用）。
 *
 * **换算语义（floor 文档化）**：`max(30min, maxTurns × 5min)`——按 maxTurns 线性估算，
 * 带 30 分钟下限（floor）。maxTurns 换算结果低于 30 分钟时（含 ≤6 的整数与小数，
 * 如 0.5）一律钳到 30 分钟：单 turn 约 5 分钟是经验值（复杂 tool + 长 LLM 响应约
 * 3-4 分钟，留 1-2 分钟余量），maxTurns 过小时不设 floor 会把 watchdog 紧到误杀。
 * - maxTurns=2 → 30min（floor 生效，非 2×5=10min——zsw 曾自实现无 floor 版本致该
 *   配置被 10min 误杀，见 sink 设计 §2.1 例 1；两宿主统一消费本函数即同语义）
 * - maxTurns=6 → 30min（恰为 floor 临界）
 * - maxTurns=20 → 100 分钟
 * - maxTurns=100 → 500 分钟（8 小时+，覆盖全量重构）
 *
 * 旧实现固定 30 分钟（SPAWN_WATCHDOG_MS），与 maxTurns 无关：maxTurns=100 的长任务
 * （全量重构/大规模迁移）正常需数小时，30 分钟到达即被误杀，limiter 机制形同虚设。
 *
 * [预算语义对齐 2026-08] maxTurns 未传/<=0 → 不挂 watchdog（不限）的挂载判定**不归本
 * 函数**——本函数只做换算，挂载判定单一入口是 resolveSpawnWatchdogMs（未传时走
 * SPAWN_WATCHDOG_ENV 兑底，显式 <=0 = 显式不限压过 env）。用户须知风险：watchdog 防
 * 的是 pi 子进程 hang 泄漏（卡死在单个 tool 内 turn_end 永不触发，limiter 失效），
 * 默认关闭意味着无 maxTurns 的 spawn 若 hang 将永不自动回收——须用 SPAWN_WATCHDOG_ENV
 * 显式兑底。
 *
 * [MF-4] 同时是 agent_end keep-alive 的「有活跃后代」等待超时（不 kill 分支），
 * 替代旧固定 2h（WAIT_DESCENDANT_TIMEOUT_MS，已删除）——wave 开发 >2h 不被误杀。
 * [export] 测试可观测（run-spawn-edges MF-4 用例断言 keep-alive 等待超时 = 动态值；
 * max-turns-to-watchdog-ms.test.ts 锚定 floor/边界换算）。
 *
 * @param maxTurns 调用方指定的 turn 上限；调用方保证 > 0（否则走 resolveSpawnWatchdogMs）
 */
export function maxTurnsToWatchdogMs(maxTurns: number): number {
  return Math.max(SPAWN_WATCHDOG_FLOOR_MS, maxTurns * WATCHDOG_MS_PER_TURN);
}

/**
 * spawn watchdog 毫秒兑底 env（可选，默认未设 = 不挂 watchdog）。
 * 
 * 仅当 maxTurns 未传（undefined/null）时生效：设置后按该绝对时限挂 watchdog，
 * 未设则完全不挂（不限）。显式传 maxTurns（含 0/负数）压过 env（U5，SP-6 参数 > env）
 * ——旧实现 maxTurns:0 落到 env 兑底，参数显式关不掉 watchdog。
 * 前缀用 XYZ_SUBAGENT_*：本 env 是父侧（pi 进程内）读的配置
 * env，xyz-agent 桌面 spawn 链会按 ENV_WHITELIST_PREFIXES（只有 XYZ_ 等，无 PI_）过滤，
 * PI_ 前缀在桌面场景被静默丢弃——同 XYZ_SUBAGENT_IDLE_TIMEOUT_MS 的改名教训。
 * 注意与 PI_SUBAGENT_* 系（extension spawn 子进程时直接注入 childEnv）的机制区别。
 * 与 launcher 的 XYZ_SUBAGENT_RUN_WATCHDOG_MS（workflow run 轮询兑底）对称：
 * 两者都是「默认关、显式设置才挂绝对时限」的 hang 兑底通道（U7）。
 */
export const SPAWN_WATCHDOG_ENV = "XYZ_SUBAGENT_SPAWN_WATCHDOG_MS";

/**
 * [LC-9/T7②] stdout invalid 行样本留痕上限：前 N 条逐条 debug，其后仅累计计数
 *（防长尾调试输出刷屏）；总数与样本在 close 聚合一次性输出。
 */
const MAX_INVALID_LINE_SAMPLES = 3;
/** 单条样本截断长度（pi 调试行可能超长，截断保日志可用）。 */
const INVALID_LINE_SAMPLE_MAX_LENGTH = 160;

/**
 * 解析 spawn watchdog 毫秒数；env 未设返回 undefined（调用方不挂 timer）。
 *
 * [LC-7/T7①] env 已设但非法（非数字/<=0）同样返回 undefined——watchdog 不挂载 =
 * **等价关闭**，但必须 warn 留痕：运维设 `XYZ_SUBAGENT_SPAWN_WATCHDOG_MS="30m"`
 * 本意加兜底，静默失效会造成「以为有兜底、实际裸奔」（设计 §4.3 LC-7），
 * 生效行为必须可见。
 */
function getEnvSpawnWatchdogMs(): number | undefined {
  const raw = process.env[SPAWN_WATCHDOG_ENV];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[session-runner] ${SPAWN_WATCHDOG_ENV}="${raw}" is invalid (expected a positive millisecond number) — spawn watchdog NOT armed, equivalent to disabled; set a plain ms value (e.g. 1800000) to enable`,
    );
    return undefined;
  }
  return parsed;
}

/**
 * 解析 spawn watchdog 超时（挂载判定的单一入口）。
 * 
 * 优先级（SP-6 参数 > env，U5）：maxTurns 显式传参时压过 env——有效（>0）按 turns
 * 估算（maxTurnsToWatchdogMs）；显式 0/负 = 显式不限（不挂 watchdog）；仅 undefined/null
 * （未传）才落 SPAWN_WATCHDOG_ENV 兑底；env 也未设 → undefined（不挂 watchdog，不限）。
 * 
 * [U1] 返回值（env 兑底或 turns 估算两条路径）流入 setTimeout 前校验安全域：
 * >2^31-1 的 delay 被 Node 置 1ms 立即触发（watchdog 变「启动即杀」），fail-fast。
 * 
 * [export] 测试可观测（timeout-integration 用例断言 maxTurns 缺省/env 兑底分支）。
 */
export function resolveSpawnWatchdogMs(maxTurns: number | undefined | null): number | undefined {
  if (maxTurns === undefined || maxTurns === null) {
    const envMs = getEnvSpawnWatchdogMs();
    if (envMs !== undefined) assertSafeTimerDelay(envMs, SPAWN_WATCHDOG_ENV);
    return envMs;
  }
  // [F-R3] 显式传参先数值规范化 + 有限性校验。旧实现直接走 maxTurns>0 判断：
  // NaN / ""（Number("")===0）等垃圾值比较为 false 落到 return undefined——既绕过
  // Number.isFinite 校验，又压过 SPAWN_WATCHDOG_ENV 兑底，把调用方 bug 静默变成
  // 「显式不限」。现非有限数（NaN/±Infinity）与 timer-delay 同语义 fail-fast（U1，
  // 非有限 delay 在 Node setTimeout 塔缩为 1ms 立即触发，比静默不限更危险，必须暴露）；
  // Number("") === 0 → 与显式 0 同路径（显式不限，压过 env，U5 语义不回归）。
  const turns = Number(maxTurns);
  if (!Number.isFinite(turns)) {
    assertSafeTimerDelay(turns, `maxTurns=${String(maxTurns)}`);
  }
  if (turns > 0) {
    const estimated = maxTurnsToWatchdogMs(turns);
    assertSafeTimerDelay(estimated, `maxTurnsToWatchdogMs(maxTurns=${maxTurns})`);
    return estimated;
  }
  return undefined;
}

/**
 * [A1-1] keep-alive 无进展 timer 的挂载资格：仅「裸缺省」（maxTurns 未传且 env 未设）。
 *
 * resolveSpawnWatchdogMs 返回 undefined 有三种来源，语义不同：
 *   a. 裸缺省（本函数为 true）→ 挂无进展检测上界（T2-① 降级 B）；
 *   b. 显式 maxTurns<=0（显式不限时，压过 env，U5）→ 不挂任何 timer（opt-out 保留）；
 *   c. resolveSpawnWatchdogMs throw 的 F-R2 降级 → 不挂任何 timer（fail-fast 不静默
 *      换兜底）。
 * env 存在性用原始 process.env 判（不经 getEnvSpawnWatchdogMs 的 parse）——避免与
 * resolveSpawnWatchdogMs 内部的 invalid-env warn 重复出声。判据是 raw falsy（undefined
 * 或空串都算未设），与 getEnvSpawnWatchdogMs 对 raw 的判定逐字一致；env 已设且非空
 *（含非法值如 "abc"）即「显式配置」语义，非裸缺省。
 */
function isBareDefaultKeepAlive(maxTurns: number | undefined | null): boolean {
  return (maxTurns === undefined || maxTurns === null) && !process.env[SPAWN_WATCHDOG_ENV];
}

/** stderr 累积上限——按字符截断（.slice 语义），非字节；64K 规模沿自原实现。
 *  防止失控子进程打满父进程内存。保留尾部便于诊断。 */
const STDERR_MAX_CHARS = 65_536;

/**
 * 跨包契约 env 名与注入上限（SCHEMA_ENV_VAR / SCHEMA_ENV_MAX_BYTES）：
 * 实装已抽到 shared/schema-env.ts（零依赖叶子，S5），顶部 import + 下方 re-export。
 *
 * [跨包契约 SSOT] 此字面量是两个独立 npm 包（@zhushanwen/pi-subagent-workflow 与
 * @zhushanwen/pi-structured-output）之间的隐式 env 契约。structured-output 包内同名常量为
 * `ENV_SCHEMA = "PI_WORKFLOW_SCHEMA"`（见 extensions/universal/structured-output/src/index.ts）。
 * 两包是独立 npm 包不能直接 import，故各自保留常量但显式标注此契约关系——
 * 任一端改名必须同步另一端，否则权威 schema 注入会静默断桥（子进程不注册 tool/hook）。
 * 抽叶子的目的：跨包契约测试从 session-runner import 会拖入整条 spawn/pi SDK 依赖树，
 * 叶子模块提供稳定 import 点（导出名与值不变）。
 */
export { SCHEMA_ENV_MAX_BYTES, SCHEMA_ENV_VAR };

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
 * [R1 D6③] 编排扩容：先触发 engine registry 各已实例化引擎的 dispose（常驻资源
 * 归引擎所有，见 EnginePort.dispose / registry.disposeEngines），再杀 per-record
 * children——顺序不可反（D6①：SIGTERM 先发会导致引擎侧 close 帧必丢）。dispose
 * 触发不等待：本函数保持同步契约（宿主调用点零改动，函数签名与导出名不变），
 * 引擎 dispose 的同步面（fire close 帧 + 同步 SIGTERM）由引擎实现保证，异步
 * promise 段（grace→SIGKILL）的 rejection 由 registry 侧 catch 吞掉，防
 * unhandledRejection 崩宿主。
 *
 * [R1 D6 注释契约] spawnedChildren Map 是 per-record 一次性 spawn 模态（一任务一
 * 进程，key=record.id）；引擎持有的常驻进程（跨任务共享）**不进本 Map**——其生命
 * 周期完全归引擎 dispose 管理（边界声明见 RunContext.onChildSpawned）。常驻进程的
 * 注册/回收问题在引擎层解决（R4），此处只立 Map 模态契约。
 *
 * 遍历 spawnedChildren Map 的 values()，对每个「未确认死亡」的子进程发信号。
 * 已退出的子进程在 close/error 事件时已从 Map 移除（按句守卫 removeChildRegistration——
 * Map 当前值仍是该 child 才删，防误删 resume spawn 的新注册），故 Map 中只剩「活着的」
 * 或「已被 kill 但 close 事件尚未回调的」。
 *
 * [T2-⑤ / LC-2] 死亡判定按 exitCode/signalCode 而非 killed 标记——killed=true 只表示
 * 「发过 kill 请求」，不等于「已死」：SIGTERM 可能被无视（卡死在不可中断 native 调用），
 * 旧实现按 killed 跳过会让这类进程脱离最后一次回收窗口。现规则：
 *   - 已确认死亡（exitCode/signalCode 任一非 null）→ 跳过（无论 killed 与否）；
 *   - killed 但未确认死亡（SIGTERM 已发、进程仍在）→ 直接升级 SIGKILL（dispose 是
 *     最后兜底，没有 30s 升级窗口可等——killAllSpawnedChildren 保持快速返回契约）；
 *   - 未 killed 且未确认死亡 → 发调用方指定 signal。
 *
 * 用于 SubagentService.dispose（进程退出路径）：覆盖 sync 子进程（controller 为 undefined，
 * abortRunningControllers 跳过它们）。background 子进程此时已被 abortRunningControllers 经
 * controller.abort 路径 kill，本函数对它们的再处理是 SIGKILL 升级检查（T2-⑤ 语义），
 * 对已死句柄 child.kill 返回 false 无害。
 *
 * 不 await 子进程退出（dispose 要快速返回）。
 *
 * @returns 被 kill 的子进程数（诊断用）
 */
export function killAllSpawnedChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  // [R1 D6③] 先全部触发引擎 dispose（含时序与等待策略说明的完整注释见函数 doc），
  // 后遍历杀 per-record children。
  disposeEngines();
  let n = 0;
  for (const child of spawnedChildren.values()) {
    // [T2-⑤ / LC-2] killed=发过 kill 请求 ≠ 已死：只有 exitCode/signalCode 非 null
    //（进程已确认死亡）才跳过。close 事件回调可能晚于 dispose 到达，此时两个字段
    // 仍为 null 但进程可能已被 controller.abort 路径 kill（killed=true）——不跳过，
    // 走下方 SIGKILL 升级检查（SIGTERM 可能被无视，不能赌它生效）。
    // 字段缺失（?? null 兜底，如 test double）按「无法确认死亡」保守视为存活，
    // 进入 kill 分支——宁多发一次无害信号，不漏一个未死进程。
    const confirmedDead = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
    if (confirmedDead) continue;
    try {
      child.kill(child.killed ? "SIGKILL" : signal);
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
  // 不 clear 则下次 dispose 会重复向已 kill 的 child 发信号——虽然已确认死亡者被
  // 跳过，但 Map 无限增长泄漏内存）。
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

/**
 * [U0 D10] 非 pi 引擎路径的子进程记账注册入口（宿主经 RunContext.onChildSpawned 调用）。
 *
 * 与 pi runSpawn 内联注册同构：set 进 Map + close/error 按句守卫移除（M4 竞态守卫语义
 * 复用 removeChildRegistration）。pi 路径保持内联不动（其 close/error handler 还承担
 * EPIPE 记账等 pi 专属副作用，不适合收敛到本函数）——两入口写同一 Map，dispose 的
 * killAllSpawnedChildren / cancelBackground 的 getChildByRecord 对两域 record 均生效。
 */
export function registerSpawnedChildForRecord(recordId: string, child: ChildProcess): void {
  spawnedChildren.set(recordId, child);
  child.once("close", () => removeChildRegistration(recordId, child));
  child.once("error", () => removeChildRegistration(recordId, child));
}

// ============================================================
// [T2-② / P-T2b 主路径] 后代级联补杀 sweep
// ============================================================
//
// 背景（设计 §7.2 T2-② + 探针 probe/p-t2b-report.md）：keep-alive 上界 kill 的是层主
// 进程，其后台化 pi 后代不会随层主 SIGTERM 级联死亡（P-T2b 三次稳定复现 NO-CASCADE，
// 实装机制层 rpc-mode SIGTERM handler 只 kill tracked detached children，agent_end 后
// bash 已 untrack）。补杀时序分两步：层主确认死亡（close）后从其 sessionFile 冻结
// 快照采集活跃后代清单（此刻 pending entries 最完整，避开「kill 前采集」的垂死窗口
// 漏项），再对清单内每个后代迭代展开至叶（递归读各后代的 pending 差集）逐个
// escalation kill。

/** sweep 内 ps -p <pid> -o command= 探测的超时（处置路径一次性调用，防 ps 挂死拖住收尾）。 */
const DESCENDANT_CMDLINE_PROBE_TIMEOUT_MS = 3000;

/**
 * 读目标 pid 的完整命令行（macOS + Linux 通用的 `ps -p <pid> -o command=`）。
 * 返回 undefined：ps 失败 / 超时 / 空输出（进程刚死等）——调用方按「校验不过」保守跳过。
 */
function readProcessCmdline(pid: number): string | undefined {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: DESCENDANT_CMDLINE_PROBE_TIMEOUT_MS,
    });
    if (r.error || r.status !== 0) return undefined;
    const out = typeof r.stdout === "string" ? r.stdout.trim() : "";
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * cmdline 校验：目标进程须是 pi --mode rpc 形态才允许 kill。
 *
 * [防误杀] 层主死后窗口内 pid 可能被操作系统复用给无关进程——存活校验（isProcessAlive）
 * 只证明「有进程」，cmdline 校验进一步证明「是 pi rpc 子进程」才动手（P-T2b 实测后代
 * 即以 `pi --mode rpc` 形态存活，可命中）。
 *
 * [export] 测试可观测（descendant-sweep 用例断言 pi 形态命中 / 无关进程拒绝）。
 */
export function looksLikePiRpcProcess(cmdline: string): boolean {
  // pi 词形：裸命令 "pi"、路径段 ".../pi"、带扩展名的入口脚本 ".../pi.js"。
  const hasPi = /(^|[\s/])pi(\.js|\.cjs|\.mjs)?(\s|$)/.test(cmdline);
  // --mode rpc：分离参数（"--mode rpc"）与连写（"--mode=rpc"）两形态。
  const hasRpcMode = /(^|\s)--mode[=\s]rpc(\s|$)/.test(cmdline);
  return hasPi && hasRpcMode;
}

/**
 * 对外部 pid（无 ChildProcess 句柄的后代进程）发 SIGTERM 并武装 SIGKILL 升级：
 * PID_KILL_ESCALATION 后仍存活则 SIGKILL。语义对齐 killChildWithEscalation，
 * 但后代是 detached 孤儿（非本进程 spawn 的句柄），只能按 pid 操作。
 */
function killPidWithEscalation(pid: number, label: string): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // SIGTERM 发送即失败（进程恰死 / 权限）：无需升级，诊断留痕
    logger.debug(
      `[session-runner] ${label}: SIGTERM to pid ${pid} failed (best-effort continue): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  assertSafeTimerDelay(SIGKILL_ESCALATION_MS, `descendant SIGKILL escalation (${label})`);
  const escalation = setTimeout(() => {
    if (isProcessAlive(pid)) {
      logger.warn(
        `[session-runner] ${label}: descendant pid ${pid} still alive ${
          SIGKILL_ESCALATION_MS / MS_PER_SECOND
        }s after SIGTERM, escalating to SIGKILL`,
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程在窗口内自行退出：目标已达成
      }
    }
  }, SIGKILL_ESCALATION_MS);
  escalation.unref();
}

/** 后代补杀结果（诊断/测试可观测）。 */
export interface DescendantSweepResult {
  /** 已发 SIGTERM（挂升级）的后代 pid。 */
  killed: number[];
  /** 被守卫拦下的后代（pid 反查失败 / 已死 / 非 pi 形态），reason 面向排查。 */
  skipped: Array<{ sessionId: string; pid?: number; reason: string }>;
}

/**
 * 从层主 sessionFile 出发迭代补杀全部活跃后代（迭代至叶）。
 *
 * 采集：层主 sessionFile 的 pending register−unregister 差集（listActivePendingFromSessionFile，
 * 与 keep-alive 判定的 count 口径共享增量游标）给出活跃后代的 sessionId 清单；每个
 * sessionId 经 findSessionFileByHeaderId 反查后代 sessionFile，其自身差集继续展开
 * （BFS + visited 防环）直至叶。
 *
 * kill 前双校验（防 pid 复用误杀）：readAliveMarker 取后代 pid → isProcessAlive 存活
 * 校验 → readProcessCmdline + looksLikePiRpcProcess 形态校验，通过才 escalation kill。
 *
 * 残余窗口（设计如实标注）：个别后代 pid 反查失败时归 T5 marker 机制兜底（见下
 * TODO 锚点）——marker 失真时该后代可能被孤儿恢复误终态，本函数不押注 marker 精确性。
 *
 * 同步实现：后代树规模有限、每步有界（ps 探测 3s 超时、文件读取增量游标），调用方
 * （runSpawn 收尾）一次性执行不悬挂。
 */
export function sweepDescendantsOfSession(
  rootSessionFile: string | undefined,
  sessionDir: string,
  source: string,
): DescendantSweepResult {
  const result: DescendantSweepResult = { killed: [], skipped: [] };
  if (!rootSessionFile) return result;

  const visited = new Set<string>();
  const queue: string[] = [rootSessionFile];
  while (queue.length > 0) {
    const sessionFile = queue.shift() as string;
    if (visited.has(sessionFile)) continue;
    visited.add(sessionFile);

    const list = listActivePendingFromSessionFile(sessionFile);
    if (list.error) {
      // 差集读不出 = 无法证明有活跃后代：保守跳过该分支（不杀不在清单内的进程）
      logger.debug(
        `[session-runner] descendant sweep (${source}): pending list unreadable for ${sessionFile}: ${list.error}`,
      );
      continue;
    }

    for (const item of list.items) {
      if (!item.sessionId) {
        // TODO(T5 marker fallback)：register entry 缺 sessionId，pid/sessionFile 反查
        // 无门。兜底归 T5 的 marker 机制（后续单元实施：按 pending id 关联 alive
        // marker 反查）；当前仅留痕——该后代成为孤儿后由 marker/孤儿恢复收敛，存在
        // 设计已标注的「marker 失真残余窗口」。
        result.skipped.push({
          sessionId: item.id,
          reason: "pending register entry has no sessionId (marker-based fallback pending T5)",
        });
        continue;
      }
      const childFile = findSessionFileByHeaderId(sessionDir, item.sessionId);
      if (!childFile) {
        // TODO(T5 marker fallback)：sessionDir 反查失败（session 文件未 flush / 非本
        // store 树）。同上归 T5 marker 机制兜底，当前留痕。
        result.skipped.push({
          sessionId: item.sessionId,
          reason: "session file not found in sessionDir (marker-based fallback pending T5)",
        });
        continue;
      }
      // 迭代至叶：后代自身的 pending 差集在后续轮次继续展开（visited 防环）。
      queue.push(childFile);

      const marker = readAliveMarker(childFile);
      if (!marker) {
        // 后代 sessionFile 存在但无 .alive sidecar：无法定位 pid。TODO(T5 marker
        // fallback) 同上——marker 机制实施后按 record 关联补齐。
        result.skipped.push({ sessionId: item.sessionId, reason: "no alive marker for session file" });
        continue;
      }
      if (!isProcessAlive(marker.pid)) {
        // 存活校验不过：后代已死（自然完成 / 随层主 cascade），无需补杀。
        result.skipped.push({
          sessionId: item.sessionId,
          pid: marker.pid,
          reason: "pid not alive (already exited)",
        });
        continue;
      }
      const cmdline = readProcessCmdline(marker.pid);
      if (cmdline === undefined || !looksLikePiRpcProcess(cmdline)) {
        // [防误杀] pid 复用守卫：探测失败或非 pi --mode rpc 形态一律不动手。
        result.skipped.push({
          sessionId: item.sessionId,
          pid: marker.pid,
          reason:
            cmdline === undefined
              ? "cmdline probe failed (ps unavailable)"
              : `cmdline is not pi --mode rpc (pid reuse guard): ${cmdline}`,
        });
        continue;
      }
      logger.warn(
        `[session-runner] descendant sweep (${source}): killing orphan descendant pid=${marker.pid} session=${item.sessionId} (${item.id})`,
      );
      killPidWithEscalation(marker.pid, `descendant sweep (${source})`);
      result.killed.push(marker.pid);
    }
  }
  return result;
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
  /**
   * [v8.5 B] 显式 --fork 源文件覆盖：优先于 opts.fork 推导的 ctx.mainSessionFile。
   * 由 service.execute 从 ExecuteOptions.forkFromSessionFile 透传（fork-from action）。
   * undefined = 沿用旧语义（opts.fork ? mainSessionFile : undefined），行为不变。
   */
  forkSource?: string;
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
 *
 * [SO-DATA-4] 注入前按 UTF-8 字节长度校验，超 SCHEMA_ENV_MAX_BYTES（256KiB）fail-fast
 * 拒绝：env 值过大叠加全量继承的 process.env 可能触发 execve 的 E2BIG（ARG_MAX 约束），
 * spawn 直接失败且错误难归因。提前在注入点报错，消息含实际大小与精简指引。
 *
 * @throws Error schemaEnv 序列化后超过 SCHEMA_ENV_MAX_BYTES
 */
export function applySchemaEnvToChildEnv(
  childEnv: Record<string, string | undefined>,
  schemaEnv?: string,
): void {
  if (schemaEnv) {
    const sizeBytes = schemaEnvByteLength(schemaEnv);
    if (sizeBytes > SCHEMA_ENV_MAX_BYTES) {
      throw new Error(
        `[subagent-workflow] schema env too large: ${sizeBytes} bytes exceeds the ${SCHEMA_ENV_MAX_BYTES}-byte limit for ${SCHEMA_ENV_VAR}. ` +
          "Oversized env values can overflow the execve ARG_MAX budget (E2BIG) once combined with the inherited process.env, failing the spawn with a hard-to-attribute error. " +
          "Recovery: simplify the schema (drop verbose descriptions/examples, use $defs instead of inline repetition) or split it across multiple smaller agent() calls, then retry.",
      );
    }
    childEnv[SCHEMA_ENV_VAR] = schemaEnv;
  }
}

// ============================================================
// 环境信息块（M1 恢复）
// ============================================================

/** buildEnvBlock 的 git 命令超时（ms）。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/**
 * git branch 缓存的 LRU 上限 [LC-8/T6③]。
 *
 * 缓存 key 是 cwd——worktree 场景每次路径唯一，无上限则条目按 path 永久累积（长寿命
 * orchestrator 内存无界，设计 §4.3 LC-8「实锤·轻微」）。64 对「同 cwd 高频 session
 * 创建」的缓存收益零影响（活跃 worktree 数远小于此），仅封顶最坏形态。
 */
export const BRANCH_CACHE_MAX_ENTRIES = 64;

/** git branch 缓存（key=cwd）——避免每次 session 创建都 spawn git。[LC-8] LRU 有界。 */
const branchCache = new Map<string, string>();

/** [LC-8] get 命中刷新 LRU 序：重插至 Map 尾（Map 迭代序 = 插入序，首元素即最旧）。 */
function getCachedBranch(cwd: string): string | undefined {
  const branch = branchCache.get(cwd);
  if (branch !== undefined) {
    branchCache.delete(cwd);
    branchCache.set(cwd, branch);
  }
  return branch;
}

/** [LC-8] set 入缓存并淘汰超限的最旧条目（重 set 前先删，已存在时刷新 LRU 序）。 */
function setCachedBranch(cwd: string, branch: string): void {
  branchCache.delete(cwd);
  branchCache.set(cwd, branch);
  while (branchCache.size > BRANCH_CACHE_MAX_ENTRIES) {
    const oldest = branchCache.keys().next();
    if (oldest.done === true) break; // 防御：空 Map 但 size 判定异常时退出
    branchCache.delete(oldest.value);
  }
}

/** 测试钩子：清空 branchCache（模块级单例状态隔离，对齐 _resetLifecycleState 先例）。 */
export function _resetBranchCacheForTest(): void {
  branchCache.clear();
}

/** 测试钩子：branchCache 当前条目数（LRU 上界断言的观察点）。 */
export function _getBranchCacheSizeForTest(): number {
  return branchCache.size;
}

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
  let branch = getCachedBranch(cwd);
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
    setCachedBranch(cwd, branch);
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
//   e. schema enforcement：经 resolver 注入 appendSystemPrompt（ASP 单点，不再拼
//      task 后缀——工具 parameters 是 pi 必然注入的权威展示，机制登记 PS-21：
//      pi-ai provider 层 convertTools 把 tool.parameters 随请求下发（anthropic
//      :1000/:1017 input_schema、openai :1099 parameters），见 agent-opts-resolver）
//   f. spawn + pump stdout（替代 session.prompt）
//   g. collectResult → AgentResult（完全复用）
//   h. proc cleanup（替代 session.dispose）
//
// fork 保留：--fork <mainSessionFile> 传父 session，子进程建分支会话。
//   depth 经环境变量 PI_SUBAGENT_FORK_DEPTH 传给子进程（W3 子进程侧初始化读取）。

/** 子进程退出码阈值：>=128 表示被信号终止（SIGTERM=143 等）。 */
const SIGNAL_EXIT_CODE_THRESHOLD = 128;

/**
 * spawn 侧已裁决的模型身份（U1 D2）：buildSpawnArgs 只接受经 assertCanonicalModelRef /
 * modelRefFromVerified 裁决的 {provider, id}，拼接值 = `${provider}/${id}`。
 * 类型层面裸字符串不可达——任何未经 D1 裁决的模型串无法流入 `--model`。
 */
export interface SpawnModelRef {
  provider: string;
  id: string;
}

/**
 * 组装 pi CLI 参数（不含 task 本身，task 作为最后一个位置参数）。
 *
 * 抽取自 runSpawn 便于单测（纯函数，不依赖进程状态）。
 *
 * [U1 D2 spawn 前置守卫] 入参收窄：model 字符串 → modelRef（SpawnModelRef），
 * thinkingLevel → ThinkingLevel 白名单字面量联合。`--model` 值恒为
 * `${modelRef.provider}/${modelRef.id}`（+ 可选白名单 `:level` 后缀）。
 */
export function buildSpawnArgs(
  params: {
    modelRef: SpawnModelRef;
    thinkingLevel: ThinkingLevel | undefined;
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
  //
  // [单写者不变量·MF-8｜第五轮元审查结论] session JSONL 完整性依赖「每 session
  // 单写进程」架构不变量：子进程写独立 subagent sessionDir（getSubagentSessionDir
  // 编码隔离），主 session 仅本进程单线程写。pi 0.84.1 写入原语（dist/core/
  // session-manager.js，机制登记 PS-18）只在「唯一写者」前提下原子：_persist
  //（:724-753）首写用 wx flag 整体落盘缓冲 entry（:739），此后一律 appendFileSync
  // 追加（:730/:751）；运行时 compaction 走 appendCompaction（:803-818）→
  // _appendEntry → _persist 的 append-only 追加（agent-session.js:1432 手动 /
  // :1670 自动），不重写文件；截断重写 _rewriteFile（openSync(path,"w")，:693-705）
  // 仅在加载期触发：空文件归一（:627）/ 版本迁移（:634）/ branch 换新文件（:1143）。
  // 引入第二写进程（如父进程补写/双进程同 sessionDir）则全部失守：appendFileSync
  // 无 O_APPEND 与对方交错截断，加载期重写吞掉并发追加的尾部 entry，历史上已造成
  // 双写者事故（v4 A-5/P7）。任何改动不得让两个进程指向同一 session 文件写路径。
  const args: string[] = ["--mode", "rpc", "--session-dir", params.sessionDir];
  // resume：紧跟 --session-dir 追加 --session <file>，pi 续写原 session 文件（P-8）。
  if (params.sessionFile) {
    args.push("--session", params.sessionFile);
  }
  // [U1 D2] 只拼接已裁决 ModelRef；thinkingLevel 类型已收窄为白名单字面量联合。
  args.push("--model", `${params.modelRef.provider}/${params.modelRef.id}`);
  if (params.thinkingLevel) {
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

/**
 * [T5② / PS-7a] keep-alive 期 agent_end 心跳：覆盖写 .alive marker 刷新软超时基准。
 *
 * 1h 软超时（ALIVE_SOFT_TIMEOUT_MS）的隐含假设是「marker 写后进程短命」——被 keep-alive
 * 打破（MF-4 数小时 keep-alive 是设计内可达态）后，活记录会被异进程孤儿恢复误盖
 * .finalized sidecar（PS-7a）。keep-alive 的每次 agent_end 重写 marker，把「实例活跃」
 * 的证明持续推新，软超时只在进程真死后才可能到期。
 *
 * [P-T5 探针裁决] 主路径成立（probe/p-t5-report.md）：历史 4747 个 subagent session 回溯，
 * agent_end 密度 P95 ≈10 次/分钟，单次覆盖写 0.0315ms（56 字节）——开销可忽略，不降级
 * 软超时对齐。
 *
 * [语义登记] marker.startedAt 语义由「实例启动时刻」扩展为「最后一次活跃证明时刻」：
 * 三处软超时消费方（record-store buildRecord 活态分支 ×2 + findForeignLiveInstance）
 * 判据 `now - startedAt < ALIVE_SOFT_TIMEOUT_MS` 语义统一收紧为「最后心跳后 1h 内算活」，
 * 活跃实例不再被误判陈旧（方向安全）；marker 的 pid/id 字段保持不变（id 取现有 marker
 * 值，缺失时兜底 record.id，与 finishHandshake 写点兜底一致）。
 */
function touchAliveMarkerForHeartbeat(sessionFile: string | undefined, pid: number | undefined, recordId: string): void {
  if (!sessionFile || !pid) return;
  const existingId = readAliveMarker(sessionFile)?.id ?? recordId;
  writeAliveMarkerBestEffort(sessionFile, pid, existingId);
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
  /** [race-F4] SIGKILL 升级 timer（killChildWithEscalation 挂载；exit 事件自动 clear，
   *  收尾统一 clearTimeout 兑底）。 */
  escalationTimer: NodeJS.Timeout | undefined;
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
  /**
   * [T2-① / P-T2 降级 B] keep-alive 裸缺省的无进展检测 timer（仅 isBareDefaultKeepAlive
   * 的 keep-alive 分支挂载）：子进程 stdout 活动刷新计时，连续静默
   * KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 且 fire 时惰性复核无存活后代才处置。undefined =
   * 未挂载（显式配置走既有固定时长 state.watchdog / 显式 opt-out 不挂任何 timer）。
   */
  keepAliveNoProgressTimer: NodeJS.Timeout | undefined;
  /**
   * [T2-② / P-T2b 主路径] keep-alive 上界处置层主后置 true：runSpawn 收尾（层主
   * close 确认死亡 + sessionFile 冻结为最终快照）时对活跃后代做级联补杀 sweep。
   */
  sweepDescendantsOnClose: boolean;
  /**
   * [T2-③ / LC-1] chatMode 首轮 settled 等待固定硬上限（timer 句柄记账在
   * settled-watchdog.ts 的 armedTimers Map，按 recordId arm/disarm；双挂载原语，
   * 热路径挂载在 subagent-service deliverMessage，u-t2b 接线）。
   */
  /** [T2-③] settled watchdog 已触发——runSpawn 收尾据此转 failed + 恢复指引（非正常完成）。 */
  settledWatchdogFired: boolean;
}

/**
 * 事件累积器工厂（原 runSpawn 内联的 a/b 两段 + handleSdkEvent/agentEvent 闭包）。
 *
 * pendingTools 寄存器 / turnLimiter / accumulateMessageEnd 均闭包在工厂内部，
 * 对外只暴露 handleSdkEvent（stdout 解析出的 SdkEvent 的唯一喂入口）。
 */

/**
 * [race-F4] SIGTERM 后升级 SIGKILL 的等待窗口：30s 未见 exit 视为 SIGTERM 被无视，强杀。
 */
const SIGKILL_ESCALATION_SECONDS = 30;
const SIGKILL_ESCALATION_MS = SIGKILL_ESCALATION_SECONDS * MS_PER_SECOND;

/**
 * [race-F4] 发 SIGTERM 并武装 SIGKILL 升级 timer：SIGKILL_ESCALATION_MS 后子进程
 * 仍未退出（exitCode/signalCode 双 null）则 SIGKILL。
 *
 * 背景：watchdog/limiter/idle timer/abort 触发只发一次 SIGTERM——子进程若无视
 * SIGTERM（卡死在不可中断的 native 调用 / SIGTERM handler 挂死），close 永不触发
 * → runSpawn 悬挂、background 槽位/worktree/alive marker 泄漏，旧实现永不回收。
 *
 * - 升级 timer unref（不阻止主进程退出；dispose 路径 killAllSpawnedChildren 兜底）
 * - assertSafeTimerDelay：包内 timer 挂载入口统一校验（常量 30s 恒通过，防未来改
 *   可配置时静默引入 1ms 溢出语义反转）
 * - child exit 事件 clear 升级 timer（自然退出/被 SIGTERM 杀死均不升级）
 * - state.escalationTimer 记录句柄：watchdog re-arm 场景先清旧升级窗口，收尾兜底 clear
 *
 * @param source 升级来源标识（warn 日志定位用，如 "spawn watchdog" / "turn limiter"）
 */
function killChildWithEscalation(state: SpawnRunState, child: ChildProcess, source: string): void {
  child.kill("SIGTERM");
  if (state.escalationTimer) clearTimeout(state.escalationTimer);
  assertSafeTimerDelay(SIGKILL_ESCALATION_MS, `SIGKILL escalation (${source})`);
  const escalation = setTimeout(
    () => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(
          `[session-runner] child ${state.record.id} still alive ${SIGKILL_ESCALATION_MS / MS_PER_SECOND}s after SIGTERM, escalating to SIGKILL (source: ${source})`,
        );
        child.kill("SIGKILL");
      }
    },
    SIGKILL_ESCALATION_MS,
  );
  escalation.unref();
  child.once("exit", () => clearTimeout(escalation));
  state.escalationTimer = escalation;
}

/**
 * [T2-④ / LC-2] 服务侧 kill 收敛入口：无 SpawnRunState 的调用方（subagent-service 的
 * closeChatIdle / closeAfterRoundSettled / cancelBackground / disposeAllRecords）经本函数
 * 发 SIGTERM + 武装 30s SIGKILL 升级——替代四处裸 `child.kill("SIGTERM")`。
 *
 * 背景（LC-2）：SIGTERM 可能被无视（子进程卡死在不可中断 native 调用 / SIGTERM handler
 * 挂死），裸 SIGTERM 后进程不退 → record 已终态归档 → 幽灵进程，且 dispose 兜底
 * killAllSpawnedChildren 的升级检查也可能不再触达（Map 条目已随 close 移除前的窗口）。
 * 服务侧 kill 时机都在「record 即将/已经终态化」——此后再无其他回收通道，必须有升级。
 *
 * 与 runSpawn 内 killChildWithEscalation 的差异：调用方没有 SpawnRunState（runSpawn 已
 * 返回 / 从未在本进程跑），升级 timer 记账在模块级 Map（recordId → timer），子进程 exit
 * 自动清除（对齐 state.escalationTimer 的 exit-clear 语义）；同 record 重复调用先清旧
 * 升级 timer 防叠加。child 不在 spawnedChildren（已 close 移除 / 从未注册）或已发过
 * kill 请求（killed=true，升级窗口已由先前路径武装）时 no-op——与旧 `child && !child.killed`
 * 守卫语义逐字对齐，仅补升级。
 */
const serviceEscalationTimers = new Map<string, NodeJS.Timeout>();

export function killRecordChildWithEscalation(recordId: string, source: string): void {
  const child = spawnedChildren.get(recordId);
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  assertSafeTimerDelay(SIGKILL_ESCALATION_MS, `SIGKILL escalation (${source})`);
  if (serviceEscalationTimers.has(recordId)) {
    clearTimeout(serviceEscalationTimers.get(recordId));
  }
  const escalation = setTimeout(
    () => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(
          `[session-runner] child ${recordId} still alive ${SIGKILL_ESCALATION_MS / MS_PER_SECOND}s after SIGTERM, escalating to SIGKILL (source: ${source})`,
        );
        child.kill("SIGKILL");
      }
    },
    SIGKILL_ESCALATION_MS,
  );
  escalation.unref();
  child.once("exit", () => {
    clearTimeout(escalation);
    if (serviceEscalationTimers.get(recordId) === escalation) {
      serviceEscalationTimers.delete(recordId);
    }
  });
  serviceEscalationTimers.set(recordId, escalation);
}

/** [T2-④] 测试隔离：清空服务侧升级 timer 记账（命名对齐 _resetSettledWatchdogsForTest）。 */
export function _resetServiceKillStateForTest(): void {
  for (const timer of serviceEscalationTimers.values()) {
    clearTimeout(timer);
  }
  serviceEscalationTimers.clear();
}

/**
 * [A1-2] 层主是否有「存活且活跃」的直接后代（no-progress fire 时的惰性复核）。
 *
 * 与 descendant sweep（sweepDescendantsOfSession）同源判据：层主 sessionFile 的
 * pending register−unregister 差集（listActivePendingFromSessionFile）给出活跃后代
 * 清单，逐个经 sessionId 反查后代 sessionFile → readAliveMarker 取 pid → isProcessAlive
 * 探活；任一后代 pid 存活即视为有进展。刻意不做 sweep kill 前双校验的另一半
 *（cmdline pi 形态校验）——本函数只决定「不杀层主、再等一个复核周期」，pid 复用误报
 * 只延后节奏 30min（方向安全）；pid 探不出的后代（register 缺 sessionId / 文件未
 * flush / 无 marker）不计入存活——与 sweep 同盲区，归 T5 marker 兜底，不以此永久豁免
 * 层主的无进展上界。
 *
 * 复核失败（层主 sessionFile 读不出）→ false（按无后代处置）+ warn 留痕。方向与
 * readActivePendingFromSessionFile 调用方的既有保守约定（error = 不杀）相反是刻意的：
 * 此处的「不确定」发生在已坐实的 30min 无进展之后，处置走 killChildWithEscalation
 * 升级链，外部 signal / dispose 兜底通道仍在，warn 保证行为可见。
 */
function hasLiveActiveDescendant(sessionFile: string | undefined, sessionDir: string): boolean {
  const list = listActivePendingFromSessionFile(sessionFile);
  if (list.error) {
    logger.warn(
      `[session-runner] keep-alive no-progress re-check failed (treating as no live descendants): ${list.error}`,
    );
    return false;
  }
  for (const item of list.items) {
    if (!item.sessionId) continue;
    const childFile = findSessionFileByHeaderId(sessionDir, item.sessionId);
    if (!childFile) continue;
    const marker = readAliveMarker(childFile);
    if (marker && isProcessAlive(marker.pid)) return true;
  }
  return false;
}

/**
 * [T2-① / P-T2 降级 B] 挂载（或刷新）keep-alive 裸缺省无进展检测 timer。
 *
 * 仅在 keep-alive 分支的裸缺省形态（isBareDefaultKeepAlive：无 maxTurns 无 env）挂载。
 * 刷新机制：stdout pump 的每次 data 事件经 refreshKeepAliveNoProgressTimer 重挂（先清旧）
 * ——「连续静默」由「每次活动重置计时」实现；重复 arm 不叠加（旧 timer 先 clear）。
 *
 * [A1-2] 到期不立即处置：层主 stdout 静默 ≠ 无进展（fire 回调内先复核存活后代，
 * 见 hasLiveActiveDescendant）。无存活后代才真静默处置：SIGTERM→killChildWithEscalation
 * + 置 sweepDescendantsOnClose（T2-② 后代级联补杀的两步时序前半）。
 *
 * [A1-2 补修] 重挂分支随行心跳（touchAliveMarkerForHeartbeat）：本 timer 合法化的
 * 目标形态「层主静默 + 后代长跑数小时」期间层主无 agent_end，原心跳写点（agent_end
 * 处置）不再触达——marker.startedAt 停在最后一次 agent_end，超 ALIVE_SOFT_TIMEOUT_MS
 * （1h）被判陈旧 → findForeignLiveInstance 放行透明重生（活层主被双写）+ record-store
 * 孤儿恢复误终态活 record（正是 T5②/PS-7a 心跳要防的失效）。复核发现存活后代本身就是
 * 「层主仍被需要」的活跃证明，每次重挂刷新软超时基准。sessionFile 为空由心跳函数
 * 自身守卫跳过（与既有写点同语义）。
 */
function armKeepAliveNoProgressTimer(
  state: SpawnRunState,
  child: ChildProcess,
  sessionDir: string,
): void {
  if (state.keepAliveNoProgressTimer) clearTimeout(state.keepAliveNoProgressTimer);
  assertSafeTimerDelay(KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS, "keep-alive no-progress watchdog");
  state.keepAliveNoProgressTimer = setTimeout(() => {
    // [A1-2] fire 惰性复核：有存活活跃后代 = 有进展 → 重挂（固定 30min 再复核，
    // 直到后代死光才落处置分支）。
    if (hasLiveActiveDescendant(state.record.sessionFile, sessionDir)) {
      // [A1-2 补修] 重挂 = 层主仍被需要：随行心跳刷新 marker 软超时基准（详见函数 doc）。
      touchAliveMarkerForHeartbeat(state.record.sessionFile, child.pid, state.record.id);
      logger.debug(
        `[session-runner] keep-alive no-progress re-check: live descendant(s) present for ${state.record.id}, re-arm (cadence ${
          KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS / MS_PER_SECOND / SECONDS_PER_MINUTE
        } min)`,
      );
      armKeepAliveNoProgressTimer(state, child, sessionDir);
      return;
    }
    logger.warn(
      `[session-runner] keep-alive no-progress watchdog fired for ${state.record.id}: no child output for ${
        KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS / MS_PER_SECOND / SECONDS_PER_MINUTE
      } min and no live descendant (bare-default keep-alive without maxTurns/env), terminating`,
    );
    // [T2-②] 同 keep-alive watchdog 处置：层主 close 确认死亡后级联补杀活跃后代。
    state.sweepDescendantsOnClose = true;
    killChildWithEscalation(state, child, "keep-alive no-progress watchdog");
  }, KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS);
  state.keepAliveNoProgressTimer.unref();
}

/**
 * [T2-①] 子进程有 stdout 活动 → 刷新静默计时。
 *
 * 未挂载（显式 maxTurns/env 的固定时长等待、显式 opt-out、非 keep-alive 阶段）时
 * no-op——刷新面严格限定在裸缺省上界，显式配置的行为不变（opt-out 语义保留）。
 */
function refreshKeepAliveNoProgressTimer(
  state: SpawnRunState,
  child: ChildProcess,
  sessionDir: string,
): void {
  if (!state.keepAliveNoProgressTimer) return;
  armKeepAliveNoProgressTimer(state, child, sessionDir);
}

/** [T2-①] 清除无进展检测 timer（keep-alive 重评估 / 收尾清理；未挂载时 no-op）。 */
function disarmKeepAliveNoProgressTimer(state: SpawnRunState): void {
  if (state.keepAliveNoProgressTimer) {
    clearTimeout(state.keepAliveNoProgressTimer);
    state.keepAliveNoProgressTimer = undefined;
  }
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
      // [race-F4] 升级路径：SIGTERM 后 30s 未 exit 则 SIGKILL（挂住子进程永不回收防线）
      if (state.proc) killChildWithEscalation(state, state.proc, "turn limiter abort");
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
        // [T2-③ / LC-1] settled 到达：本轮等待窗口结束，固定硬上限即清（resolveRun
        // 在本分支同点调用，天然同清）。清除必须先于后续逻辑——idle timer / 回调 /
        // resolve 抛错时 watchdog 已确保撤下，不会误杀下一个正常轮次。
        disarmSettledWatchdog(record.id);
        // [F-R2] 本闭包经 stdout data 回调同步调用（handleSdkEvent ← attachStdoutPump）：
        // armIdleTimer → assertSafeTimerDelay fail-fast 的 throw 若逃出回调 = uncaughtException
        // 崩宿主。包 try/catch 降级，错误经 bestEffort("error") 可见但不升级为进程崩溃；
        // 后续 limiter.reset / onRoundSettled / resolveRun 照常执行（本轮完成通知不因 GC
        // timer 故障丢失）。
        // [T4② / PS-4] 降级语义修正：旧降级「不挂 idle timer」保住了「不崩进程」，却丢掉
        // timer 承载的两个下游不变量——isIdle 放行门（hasIdleTimer=false → 轮次完成通知被
        // lifecycle-predicates 吞）与进程回收（进程活着却无 timer 永久泄漏）。现降级改为
        // 「挂 DEFAULT_IDLE_TIMEOUT_MS + warn 留痕」：非配置替换（配置错误已在 spawn 入口
        // fail-fast，见 subagent-service），此处是防御性兜底，兜底必须可见且保住不变量。
        const armIdleTimerOnTimeout = (): void => {
          // onTimeout 复用现有 kill 路径：child.kill("SIGTERM") 触发 close → close handler
          // 统一 cleanup（spawnedChildren.delete / get_stateListeners.clear / resolve）。
          // 与 agent_end handler 现有 SIGTERM 分支一致，不新造 cleanup。
          // [race-F4] 升级：idle timer SIGTERM 后挂住 → 30s 后 SIGKILL。
          const child = getChildByRecord(record.id);
          if (child && !child.killed) killChildWithEscalation(state, child, "idle timer");
        };
        try {
          armIdleTimer(record.id, armIdleTimerOnTimeout, record.idleTimeoutMs);
        } catch (err) {
          bestEffort(err, "armIdleTimer (agent_settled chatMode)", "error");
          try {
            armIdleTimer(record.id, armIdleTimerOnTimeout, DEFAULT_IDLE_TIMEOUT_MS);
            logger.warn(
              `[session-runner] idleTimeoutMs invalid for ${record.id}, fell back to DEFAULT_IDLE_TIMEOUT_MS (${DEFAULT_IDLE_TIMEOUT_MS}ms) — idle GC and round notification gate stay active`,
            );
          } catch (fallbackErr) {
            // 双重失败（理论上不可达：DEFAULT 恒在安全域内）——退回旧「不挂」语义但留痕。
            bestEffort(fallbackErr, "armIdleTimer fallback (agent_settled chatMode)", "error");
          }
        }
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
  // [U1 D2] modelRef 来源：
  //   - 非 resume：opts.resolved.model（resolveModel 裁决放行的 registry 全等条目）。
  //   - resume：resume.model 是 SpawnResumeOpts 回显（record.model，"provider/id" 系统自产
  //     已裁决形态，P-10 防漂移），按第一个 / 拆分（与 subagent-service record 回读同构），
  //     不再经 assertCanonicalModelRef（registry 快照可能已刷新，拒绝回显会破坏续聊）。
  const modelRef: SpawnModelRef = resume?.model
    ? splitRecordModelRef(resume.model)
    : { provider: opts.resolved.model.provider, id: opts.resolved.model.id };
  // [M1 resume] resume 时 model/thinkingLevel 优先用 resume 值（防多轮对话模型漂移，P-10），
  // 否则回退 opts.resolved。thinkingLevel 经白名单断言收窄（非法值同步拒，不静默降级）。
  const effectiveThinkingLevel = assertThinkingLevel(
    resume?.thinkingLevel ?? opts.resolved.thinkingLevel,
  );
  const spawnArgs = buildSpawnArgs(
    {
      modelRef,
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

/**
 * 拆分 record 回显的 "provider/id" 模型串（resume 路径专用）。
 *
 * [U1 D2 豁免依据] 输入是 SubagentService 从 record.model 读出的系统自产回显
 * （createRecordForMode 写入 `${provider}/${id}`，源头已裁决），非用户自由字符串——
 * 不经 assertCanonicalModelRef。modelId 可含 /，按第一个 / 分割（与 lookup 同构）。
 * 异常形态（无 /）兜底 provider="unknown"（与 subagent-service.ts record 回读同构）。
 */
function splitRecordModelRef(model: string): SpawnModelRef {
  const slashIdx = model.indexOf("/");
  if (slashIdx <= 0) return { provider: "unknown", id: model };
  return { provider: model.slice(0, slashIdx), id: model.slice(slashIdx + 1) };
}

/** attachStdoutPump 返回的共享句柄（waitForChildExit / get_state 握手启动消费）。 */
interface StdoutPumpHandles {
  /**
   * get_state RPC response 监听器注册（performGetStateHandshake / requestGetStateOnce 经此挂 resolver）。
   * 返回注销函数（从监听表移除该 resolver）——requestGetStateOnce 自清理消费；
   * performGetStateHandshake 忽略返回值（条目由 close 统一清，既有语义）。
   */
  registerGetStateListener(id: string, resolver: (data: unknown) => void): () => void;
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
  /** [LC-9/T7②] 本子进程生命周期内 stdout invalid 行累计数（可观测性出口）。 */
  invalidLineCount(): number;
  /** 清空 get_state 监听器（子进程已退出，无更多 response）。 */
  clearGetStateListeners(): void;
}

/**
 * [T1/RC-1+RC-2] agent_end 处置决策（非 chatMode、willRetry=false）。异步化以支持惰性回补。
 *
 * ① 惰性回补：record.sessionFile 缺失（RC-1 形态：RPC mode 的 get_state 握手 7s 预算
 *    一次性耗尽后永不再试，sessionFile 成为永久缺失）时，现场向 idle 子进程单次
 *    get_state（此刻 turn 已完成，探针 P-T1 实证应答 0.3-0.4ms，预算 1s 量级）。
 *    回填 record.sessionFile + 写 alive marker + 补 handshakeResult.sessionId（对齐
 *    finishHandshake 的回填面）后走正常三分支——「有后代 keep-alive / 无后代 final
 *    kill / 读不出保守不杀」不再被一次性握手失败劫持进保守分支。
 * ② 回补失败（超时 / 空 response / stdin 已断同步 throw）不重试：readActivePending 对
 *    undefined 返回 error → 既有保守分支（行为不劣化）。决策点不变成第二个重试循环。
 *
 * fire-and-forget 契约：调用点在 stdout 同步回调链内，rejection 无人接 = unhandledRejection。
 * 内部唯一 await 对象 requestGetStateOnce 按契约永不 reject（同步写失败转空结果）；
 * 同步段不抛（resolveSpawnWatchdogMs 的 fail-fast 已由 [F-R2] try/catch 承接）。
 *
 * 竞态边界：决策延迟窗口内 child 可能已被 abort/watchdog kill——回补前按 child.killed
 * 跳过（killed 后无回补意义）；后续 kill 对已死句柄 no-op，timer 收尾统一 clearTimeout。
 */
async function runAgentEndDisposition(
  state: SpawnRunState,
  child: ChildProcessWithoutNullStreams,
  sessionDir: string,
  registerGetStateListener: AddGetStateResponseListener,
): Promise<void> {
  const { record } = state;

  if (!record.sessionFile && !child.killed) {
    await backfillSessionFileViaGetState(state, child, registerGetStateListener);
  }

  // [A1-3] 回补 await 的异步窗口内 child 可能已死（close / abort / watchdog）。进程已死
  // 则 close 收尾已完成 timer 清理与句柄移除，三分支不再执行——否则 keep-alive 分支会
  // re-arm 泄漏 timer、touch marker 向死 pid 写心跳，final kill / warn 在已收尾进程上
  // 误导排查。存活判据用 exitCode/signalCode 双 null（close 后即非 null），不用
  // child.killed——它只表示「收到过 kill 请求」，close 之后恒 true，区分不了生死。
  if (child.exitCode !== null || child.signalCode !== null) return;

  // ── 以下三分支与同步化前逐行一致（仅随函数迁移）──
  const pending = readActivePendingFromSessionFile(record.sessionFile);
  if (pending.count > 0 || pending.error) {
    keepAliveOnAgentEnd(state, child, sessionDir, pending);
  } else if (pending.recentUnregister) {
    keepAliveForWakeupGrace(state, child);
  } else {
    disarmKeepAliveNoProgressTimer(state);
    killChildWithEscalation(state, child, "agent_end final kill");
  }
}

/**
 * [T1/RC-1+RC-2] 惰性回补：record.sessionFile 缺失时向 idle 子进程单次 get_state，
 * 回填 sessionFile + 写 alive marker + 补 handshakeResult.sessionId（对齐
 * finishHandshake 的回填面）。回补失败不重试（决策点不变成第二个重试循环）。
 */
async function backfillSessionFileViaGetState(
  state: SpawnRunState,
  child: ChildProcessWithoutNullStreams,
  registerGetStateListener: AddGetStateResponseListener,
): Promise<void> {
  const { record } = state;
  const r = await requestGetStateOnce(child, registerGetStateListener, LAZY_GET_STATE_TIMEOUT_MS);
  // 仅当本次回补拿到且此前仍缺失时回填（与 finishHandshake 的 !record.sessionFile 守卫一致）。
  if (r.sessionFile && !record.sessionFile) {
    record.sessionFile = r.sessionFile;
    if (child.pid) {
      writeAliveMarkerBestEffort(r.sessionFile, child.pid, r.sessionId ?? record.id);
    }
    logger.warn(
      `[session-runner] agent_end: sessionFile backfilled via lazy get_state (spawn handshake had failed): ${r.sessionFile}`,
    );
  }
  // sessionId 一并补入 handshakeResult：close 路径 LC-4 兜底查找的 lookupId 来源。
  if (r.sessionId && !state.handshakeResult?.sessionId) {
    state.handshakeResult = { ...state.handshakeResult, sessionId: r.sessionId };
  }
}

/**
 * keep-alive 分支（有活跃后代 / 读不出保守不杀）：心跳 + 清原 watchdog 换等待后代超时。
 * 空闲等待期间不消耗 turn（每次 agent_end 重新计时）。
 * [MF-4] 动态超时 = maxTurnsToWatchdogMs(maxTurns)：真实后代在跑，慢任务（wave 开发
 * 数小时）不能被固定 2h 误杀——2h 到点 kill 会连坐 SubagentService.dispose 的
 * killAllSpawnedChildren 杀全部子进程，L2 重派丢在途工作。maxTurns 大则超时长。
 * [A1-1 挂载面三分] keepAliveMs === undefined 的三种来源语义不同，只有裸缺省挂
 * 无进展上界：显式 maxTurns>0 → 固定时长动态 watchdog（不变）；裸缺省（maxTurns
 * 未传且 env 未设）→ [T2-① / P-T2 降级 B] 挂无进展检测上界；显式 maxTurns<=0（显式
 * 不限时，压过 env，U5）与 resolveSpawnWatchdogMs fail-fast 降级 → 维持旧「不
 * re-arm（等待后代不限时）」语义——opt-out 通道保留，无进展 timer 的挂载面严格
 * 限定裸缺省（isBareDefaultKeepAlive）。
 * [F-R2] resolveSpawnWatchdogMs → assertSafeTimerDelay fail-fast 的 throw 不升级为
 * 进程崩溃：包 try/catch 降级为「不 re-arm」（与显式 opt-out 同归「不挂 timer」，
 * 不落入裸缺省分支），错误经 bestEffort("error") 可见。
 */
function keepAliveOnAgentEnd(
  state: SpawnRunState,
  child: ChildProcessWithoutNullStreams,
  sessionDir: string,
  pending: ActivePendingResult,
): void {
  const { record, opts } = state;
  // [T5② / PS-7a] keep-alive 心跳：决定保活即刷新 .alive marker（软超时基准推新，
  // 防 keep-alive 数小时的活记录被异进程孤儿恢复误终态；P-T5 探针裁决写盘开销可忽略）。
  touchAliveMarkerForHeartbeat(record.sessionFile, child.pid, record.id);
  if (pending.error) {
    logger.warn(
      `[session-runner] agent_end: keep alive (sessionFile unreadable, conservative): ${pending.error}`,
    );
  } else {
    logger.debug(
      `[session-runner] agent_end: keep alive, ${pending.count} active descendant(s) pending`,
    );
  }
  clearTimeout(state.watchdog);
  disarmKeepAliveNoProgressTimer(state);
  // 裸缺省判定必须在 try 之前做：env 原始存在性检查（不经 parse），resolveSpawnWatchdogMs
  // 内部的 invalid-env warn 不因此重复出声。
  const bareDefaultKeepAlive = isBareDefaultKeepAlive(opts.maxTurns);
  let keepAliveMs: number | undefined;
  try {
    keepAliveMs = resolveSpawnWatchdogMs(opts.maxTurns);
  } catch (err) {
    bestEffort(err, "resolveSpawnWatchdogMs (agent_end keep-alive re-arm)", "error");
    keepAliveMs = undefined;
  }
  if (keepAliveMs !== undefined) {
    state.watchdog = setTimeout(() => {
      // [T2-② / P-T2b 主路径] keep-alive 上界处置层主的两步时序前半：kill 层主；
      // close（确认死亡 + sessionFile 冻结为最终快照）后由 runSpawn 收尾 sweep
      // 活跃后代（后半）。SIGTERM 对后台化 pi 后代无级联（P-T2b NO-CASCADE 三次
      // 复现），补杀必须显式做，不能押注子进程自行级联。
      state.sweepDescendantsOnClose = true;
      killChildWithEscalation(state, child, "keep-alive watchdog");
    }, keepAliveMs);
    state.watchdog.unref();
  } else if (bareDefaultKeepAlive) {
    // [T2-① / P-T2 降级路径 B] 裸缺省（无 maxTurns 无 env）：挂无进展检测上界。
    // P-T2 探针实证固定 30min 上限会误杀 96.6% 真实 keep-alive（长尾 95.5h 合法），
    // 上界语义改为「连续静默达 KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS 且复核无存活后代
    // 才处置」——子进程 stdout 活动刷新计时，后代集合变化由 fire 时惰性复核承接
    //（hasLiveActiveDescendant），真实 keep-alive 不被时长上限误杀，纯静默且无
    // 存活后代的 wedged 层主仍有界回收。回收由外部 signal / dispose / 后代自然完成
    // 驱动的旧兜底通道全部保留。
    armKeepAliveNoProgressTimer(state, child, sessionDir);
  }
}

/**
 * recentUnregister 分支：差集 0 但最近有 unregister——后代刚完成，notify 唤醒可能
 * 在路上（竞态窗口），保持进程——父被唤醒后的下一次 agent_end 会正常判定。
 */
function keepAliveForWakeupGrace(
  state: SpawnRunState,
  child: ChildProcessWithoutNullStreams,
): void {
  const { record } = state;
  // [T5② / PS-7a] 保活分支同样心跳（进程仍活，软超时基准应推新）。
  touchAliveMarkerForHeartbeat(record.sessionFile, child.pid, record.id);
  // [MF-3] 秒级宽限：此分支在每层「最终 turn」必命中（closeout 的 agent_end 距
  // 最后一次 unregister <60s），挂长超时 = 空等 2h 才 kill + 冒牌完成通知级联。
  // 15s 内无新 agent_end（未被唤醒）即 kill；被唤醒后下一次 agent_end 重新评估。
  logger.debug(
    "[session-runner] agent_end: keep alive, recent descendant completion (wake-up in flight)",
  );
  clearTimeout(state.watchdog);
  disarmKeepAliveNoProgressTimer(state);
  state.watchdog = setTimeout(
    () => killChildWithEscalation(state, child, "wakeup grace timer"),
    WAKEUP_GRACE_MS,
  );
  state.watchdog.unref();
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

  // [LC-9/T7②] stdout invalid 行可见性：per-child 计数 + debug 级前 N 条样本留痕。
  // 容错原则不变（invalid 行不中断流——stdout 可能有调试输出），但「事件行损坏被
  // 静默丢弃」曾使 LC-1 形态 (c) 完全不可排查（设计 §4.3 LC-9）。前 N 条逐条 debug，
  // 之后仅累计（防刷屏）；总数与样本在 close 路径（processTrailingLine）聚合输出，
  // 并经 StdoutPumpHandles.invalidLineCount() 暴露给测试/调用方。
  let invalidLineCount = 0;
  const invalidLineSamples: string[] = [];
  const recordInvalidLine = (line: string, reason: string): void => {
    invalidLineCount++;
    const truncated =
      line.length > INVALID_LINE_SAMPLE_MAX_LENGTH
        ? `${line.slice(0, INVALID_LINE_SAMPLE_MAX_LENGTH)}…`
        : line;
    if (invalidLineSamples.length < MAX_INVALID_LINE_SAMPLES) {
      invalidLineSamples.push(truncated);
    }
    if (invalidLineCount <= MAX_INVALID_LINE_SAMPLES) {
      logger.debug(
        `[session-runner] stdout invalid line #${invalidLineCount} dropped (${reason}): ${truncated}`,
      );
    }
  };

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
    // [T2-① / P-T2 降级 B] 子进程有输出 = keep-alive 仍有进展迹象：刷新静默计时。
    // 任何 stdout 活动（header / 事件行 / invalid 调试行）都算——keep-alive 的合法性
    // 由「仍在活动」定义（P-T2 探针裁决：真实 keep-alive 96.6% 超 30min，合法性不看
    // 时长看活动）。[A1-2] stdout 刷新面只覆盖「层主自己有输出」半边：「直接后代跑
    // >30min、层主静默」的合法形态刷新不到——由 no-progress fire 时的惰性复核承接
    //（armKeepAliveNoProgressTimer 内 hasLiveActiveDescendant）。未挂载（显式
    // maxTurns/env / opt-out）时 no-op。
    refreshKeepAliveNoProgressTimer(state, child, sessionDir);
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
          } else if (record.chatMode) {
            // [V2 决策 1] chatMode：对话模式进程不因轮次死。agent_end 不 kill、不 MF-3/MF-4。
            // 等待 agent_settled（真空闲信号）arm idle timer + notify（onRoundSettled）。
            // 用 continue 而非 return：return 会跳出 stdout data handler 的 for(line) 循环，
            // 丢弃同一 flush 内 agent_end 之后的事件（如紧随的 agent_settled）。continue 只
            // 跳过当前行剩余（handleSdkEvent 对 agent_end 是 no-op），继续处理后续行。
            continue;
          } else {
            // [recursive-orchestration] 条件 kill：读子进程 session 文件算活跃后代
            // （pending:register − unregister 差集）。有活跃后代（background subagent /
            // workflow）→ 保持进程 idle，等后代完成时 notifier triggerTurn steer 唤醒；
            // 无 → 正常完成，kill 触发 close → runSpawn resolve。
            //
            // [T1/RC-1] 处置决策异步化（fire-and-forget）：sessionFile 缺失（RC-1 握手失败
            // 形态）时现场惰性 get_state 回补后再判定，见 runAgentEndDisposition。原同步
            // 三分支逐行迁入该函数；异步化后决策最晚 1s（回补超时预算）落地，期间子进程
            // 仍在原 watchdog 保护下，kill 延迟无语义影响。
            void runAgentEndDisposition(state, child, sessionDir, registerGetStateListener);
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
      } else {
        // [LC-9/T7②] invalid 行（非法 JSON / 缺 type 字段）：不中断流（stdout 可能有
        // 调试输出），但不再静默——计数 + debug 样本留痕（防刷屏：前 N 条逐条、
        // 其后仅累计），close 时聚合输出总数。
        recordInvalidLine(parsed.raw, parsed.error);
      }
    }
  });

  /** get_state 监听器注册（返回注销函数供 requestGetStateOnce 自清理；见 StdoutPumpHandles）。 */
  const registerGetStateListener = (
    id: string,
    resolver: (data: unknown) => void,
  ): (() => void) => {
    get_stateListeners.set(id, resolver);
    // 按句守卫删除：resolver 已被同 id 覆盖（理论不发生——reqId 是 UUID）时不误删新条目。
    return () => {
      if (get_stateListeners.get(id) === resolver) get_stateListeners.delete(id);
    };
  };

  return {
    registerGetStateListener,
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
        } else if (parsed?.kind === "invalid") {
          // [LC-9/T7②] 残留行同计 invalid 统计（处理行为不变：event 以外仍不分发）。
          recordInvalidLine(parsed.raw, parsed.error);
        }
      }
      // [LC-9/T7②] close 聚合：本子进程生命周期的 invalid 行总数在此暴露一次
      //（processTrailingLine 由 close handler 必经调用），样本随行——LC-1 形态 (c)
      //「事件行损坏被静默丢弃」的排查入口。
      if (invalidLineCount > 0) {
        logger.debug(
          `[session-runner] stdout had ${invalidLineCount} invalid line(s) dropped in total; sample(s): ${invalidLineSamples.join(" | ")}`,
        );
      }
    },
    invalidLineCount: () => invalidLineCount,
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
      // [T2-③ / LC-1] close：settled 等待窗口必然结束（含首轮 settled watchdog 自身
      // 触发 kill 后的 close——timer 已触发执行完毕，clear 幂等无害）。
      disarmSettledWatchdog(state.record.id);
      // FR-4: 清理 get_state 监听器（子进程已退出，无更多 response）
      pump.clearGetStateListeners();
      // FR-4: 子进程已退出，get_state response 不会再来。若握手仍未 settle，立即放弃
      //（record.sessionFile 未回填则走 findSessionFileByHeaderId 兜底）。避免子进程快速
      // 失败/退出场景下 close handler 阻塞等待握手内部 6s 超时。
      pump.abandonHandshake();
      // await 立即返回（上方已 settle）：保证 header 加速路径或 get_state response 已
      // 完成的回填结果对后续 identity 写入可见。
      await pump.handshakeSettled;
      // [LC-6/T6②] 进程 close 回收其 sessionFile 的 pending 增量游标（cursors Map 按
      // 「进程 close」剪枝的接线点，设计 §7.2 T6②）：进程死后该文件不再有 agent_end
      // 判定，cursor 只会滞留。必须放在 handshakeSettled 之后——sessionFile 回填完成才
      // 拿得到剪枝键；未回填（快速失败）跳过，此时也不存在 cursor（判定从未发生）。
      // error 事件路径不重复剪：spawn 失败时 Node 必发 close，此处单点覆盖。
      if (state.record.sessionFile) {
        prunePendingCursor(state.record.sessionFile);
      }
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
    escalationTimer: undefined,
    sessionHeader: undefined,
    handshakeResult: undefined,
    resolveRun: undefined,
    keepAliveNoProgressTimer: undefined,
    sweepDescendantsOnClose: false,
    settledWatchdogFired: false,
  };

  // a/b. 事件累积器（pendingTools 寄存器 + turnLimiter + handleSdkEvent/agentEvent 闭包）
  const handleSdkEvent = createSpawnEventHandlers(state);

  // [审查项#2] 原 c.（schema 指令拼 task 末尾）已删：resolver 经 appendSystemPrompt
  // 单点注入，task 不再被每 agent 变化的指令后缀污染（可缓存 + 省 ~730 tokens/子进程）。

  // d. session 目录（与 in-process 一致：list/恢复可发现同一目录）
  // [MF-3] 用 ctx.rootCwd（贯穿真 ROOT）而非 ctx.mainCwd 编码：worktree 模式下 mainCwd 是
  // 子进程的 checkout 路径，按它编码会让深层 record 落到 enc(worktree) 段，ROOT 磁盘重建
  // 扫不到 → 全树可见性深度 ≥ 2 断裂。rootCwd 与 store 构造同源（subagent-service 同键），
  // 保证 runSpawn 写入的 session 文件就在本进程/ROOT store 扫描的目录里。
  //
  // [单写者不变量·MF-8｜第五轮元审查结论] session JSONL 完整性依赖「每 session 单写
  // 进程」架构不变量：本目录是子进程专属 sessionDir，session 文件写入方仅此子进程
  //（单进程单线程）；主进程只读（扫描/重建/统计），绝不写。pi 0.84.1 的写入原语
  //（session-manager.js，完整锚点见 buildSpawnArgs 注释 / PS-18）：_persist
  //（:724-753）首写 wx flag + 后续 appendFileSync 追加；compaction 为 append-only
  // 追加（appendCompaction :803-818），截断重写 _rewriteFile（:693-705）只在加载期
  //（归一 :627 / 迁移 :634 / branch :1143）触发——第二写进程会破坏全部这些写入的
  // 原子性（尾部丢 entry / 交错截断，见 v4 A-5/P7 双写者事故）。 resume/
  // 续聊走冷路径重开同一文件时也必须先确认旧进程已死（resumesInFlight 守卫），
  // 本质仍是单写者。
  const sessionDir = getSubagentSessionDir(ctx.agentDir, ctx.rootCwd);
  fs.mkdirSync(sessionDir, { recursive: true });

  // e. worktree 模式：checkout 路径作为 spawn cwd（隔离文件系统）
  // worktree checkout 已由 worktree-manager 在 execute 前创建，此处只取路径。
  const spawnCwd = opts.worktree?.path ?? ctx.cwd;

  // f. fork source：父 session 文件路径（--fork 参数）。
  // [v8.5 B] opts.forkSource 显式覆盖优先（fork-from 指定旧 subagent session 作源）；
  // 否则回退旧语义 opts.fork → 主 session 文件。两者均未设则无继承。
  const forkSource = opts.forkSource ?? (opts.fork ? ctx.mainSessionFile : undefined);

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
    sendPromptCommand(child, task);

    // [T2-③ / LC-1] chatMode 首轮 settled 等待固定硬上限（双挂载原语之首轮调用点；
    // 热路径调用点在 subagent-service deliverMessage，u-t2b 接线）。prompt 发出后挂、
    // settled 到达（handleSdkEvent）/ close（waitForChildExit）/ resolveRun 任一发生
    // 即清——settled 永不到达（事件行丢失 / 子进程 wedged）时本 timer 是唯一独立
    // 回收通道。到期处置：kill 层主 + settledWatchdogFired 标记（收尾据此转 failed
    // + 恢复指引，见下方 success 判定），与被信号终止视为正常完成的既有语义区分。
    if (record.chatMode) {
      armSettledWatchdog(record.id, () => {
        logger.warn(
          `[session-runner] settled watchdog fired for ${record.id}: no agent_settled within ${SETTLED_WATCHDOG_TIMEOUT_MS / MS_PER_SECOND / SECONDS_PER_MINUTE} min of first-round prompt, terminating (LC-1 wedge recovery)`,
        );
        state.settledWatchdogFired = true;
        killChildWithEscalation(state, child, "settled watchdog");
      });
    }

    // d. signal → proc.kill 监听（一次性，替代 session.abort）
    // [race-F4] 用户取消同样升级：SIGTERM 后挂住 → 30s 后 SIGKILL 兑现取消语义。
    const onAbort = (): void => {
      killChildWithEscalation(state, child, "abort signal");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // 前置检查：signal 在 spawn 前已 aborted 时 addEventListener 不会触发 onAbort，
    // 子进程会跑到自然结束。立即 kill 兑现取消语义。
    if (opts.signal?.aborted) onAbort();

    // e. watchdog：子进程整体超时兜底。卡死在单 tool 内（turn_end 永不触发）时
    //    limiter 失效，此 timer 保证最终 SIGTERM，防止 background 槽位/资源泄漏。
    // [M-1] timeout 基于 maxTurns 动态计算（maxTurnsToWatchdogMs）：旧实现固定 30 分钟
    //    误杀长任务，现按 maxTurns 线性估算（每 turn ~5 分钟，下限 30 分钟）。
    // [预算语义对齐] maxTurns 未传/<=0 → 不挂 watchdog（不限，用户明确裁决——旧实现按
    //    10 turns 估出 50min 默认 SIGTERM 且 maxTurns:0 也关不掉，已废）；
    //    SPAWN_WATCHDOG_ENV 设置时按绝对时限兑底挂载（hang 泄漏防线 opt-in）。
    // [R0] unref：不阻止 Node 进程退出。安全性由 SubagentService.dispose 保证——
    // 主进程退出时（session_shutdown reason=quit）dispose 会 abort running controller
    // → 本监听器 kill 子进程。无此 unref，watchdog timer 会拖住 event loop 阻止退出。
    const watchdogMs = resolveSpawnWatchdogMs(opts.maxTurns);
    if (watchdogMs !== undefined) {
      state.watchdog = setTimeout(
        () => killChildWithEscalation(state, child, "spawn watchdog"),
        watchdogMs,
      );
      state.watchdog.unref();
    }

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
    // [F2] .catch 兜底：performGetStateHandshake 的 Promise executor 同步调 tryOnce →
    // sendGetStateCommand → writeStdinLine 在 stdin 已断（EPIPE/ERR_STREAM_DESTROYED）时同步
    // throw → executor 内同步异常被 Promise 构造器转为 reject。若无人接（旧实现只有 .then），
    // reject 无人消费 → unhandledRejection（Node 15+ 默认 mode=throw）可崩父 pi 进程。
    // catch 内：logger.error 留证 + pump.abandonHandshake 记录握手失败终态——close handler
    // await 的 handshakeSettled 立即 settle，isHandshakePending() 归 false，不阻塞收尾链路
    //（sessionFile 兜底由收尾时的 existsSync 校验 + findSessionFileByHeaderId 承担）。
    void performGetStateHandshake(child, pump.registerGetStateListener).then((r) => {
      // header 加速路径下 settleHandshake 已 undefined，跳过（避免覆盖 header 结果）。
      // 超时兜底（r 为空对象）也经此分支 settle，但 record.sessionFile 不回填。
      if (pump.isHandshakePending()) pump.finishHandshake(r);
    }).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      logger.error(`[session-runner] get_state handshake failed: ${m}`);
      pump.abandonHandshake();
    });

    child.stderr.on("data", (data: string) => {
      // 截断防 OOM：失控子进程持续打 stderr 会耗尽父进程内存。保留尾部便于诊断。
      stderrBuffer = (stderrBuffer + data).slice(-STDERR_MAX_CHARS);
    });

    // 等待子进程退出
    const exitCode = await waitForChildExit(child, state, spawnCwd, pump);

    opts.signal?.removeEventListener("abort", onAbort);
    clearTimeout(state.watchdog);
    // [race-F4] 兑底清升级 timer（exit 事件自动 clear 的双保险：close 先于升级触发的
    // 竞态窗口内不误杀下一个占用同 state 的子进程）
    clearTimeout(state.escalationTimer);
    // [T2-①③] 收尾兜底清新增 timer（正常清除点已覆盖；防收尾路径遗漏泄漏）
    disarmKeepAliveNoProgressTimer(state);
    disarmSettledWatchdog(record.id);

    // [持久化 A] sessionFile 兜底校验。
    // identity custom entry 已改由子进程 session_start hook 写（M4 / V2 决策 5），
    // 父进程不再 fs 补写——fs 补写的 entry 缺 id/parentId 污染 pi _buildIndex。
    // 此处仅保留 sessionFile 路径兜底（deriveSessionFilePath/握手路径可能不准）。
    //
    // [T1/LC-4] findSessionFileByHeaderId 兜底查找移出 `if (record.sessionFile)` 守卫：
    // 原守卫条件恰等于它要兜底的缺失本身——RC-1 握手失败留下的「sessionId 有、
    // sessionFile 无」形态（两字段独立采集）永远不可达本兜底，下游 finalize marker /
    // alive marker / identity 写入全部失去依据（PS-9 放大）。现在两种形态都反查：
    // sessionFile 有但路径不存在（推导错 / pi 命名变化）；sessionFile 无而 sessionId 有
    // （header 或握手部分成功，含 agent_end 惰性回补补入的 handshakeResult.sessionId）。
    {
      const lookupId = state.sessionHeader?.id ?? state.handshakeResult?.sessionId;
      const needsLookup = record.sessionFile
        ? !fs.existsSync(record.sessionFile)
        : lookupId !== undefined;
      if (lookupId && needsLookup) {
        const actual = findSessionFileByHeaderId(sessionDir, lookupId);
        if (actual && actual !== record.sessionFile) record.sessionFile = actual;
      }
    }

    // [T2-② / P-T2b 主路径] keep-alive 上界处置层主的两步时序后半：此刻 close 已发生
    //（waitForChildExit 已 resolve = 层主确认死亡），且 sessionFile 已完成 LC-4 反查
    // = 冻结为最终快照（pending entries 最完整，避开「kill 前采集」的垂死窗口漏项）。
    // 从层主 sessionFile 差集采集活跃后代清单，对清单内每个后代迭代展开至叶（递归读
    // 各后代的 pending 差集），kill 前做存活 + cmdline（pi/--mode rpc）校验防 pid 复用
    // 误杀，逐个 escalation kill（SIGTERM→SIGKILL）。同步执行：后代树规模有限 + 每
    // 步有界（ps 探测 3s 超时），不阻塞 runSpawn 收尾的可感时长。
    if (state.sweepDescendantsOnClose) {
      try {
        const sweep = sweepDescendantsOfSession(record.sessionFile, sessionDir, "keep-alive watchdog");
        if (sweep.killed.length > 0 || sweep.skipped.length > 0) {
          logger.warn(
            `[session-runner] descendant sweep (keep-alive watchdog): killed=[${sweep.killed.join(", ")}] skipped=${JSON.stringify(sweep.skipped)}`,
          );
        }
      } catch (err) {
        // sweep 整体失败不掩盖层主自身的收尾结果（best-effort 可见）
        bestEffort(err, "descendant sweep (keep-alive watchdog)", "error");
      }
    }

    // 判定成功/失败（三来源：exitCode + record.lastError + abort 原因）
    let success: boolean;
    let error: string | undefined;
    if (state.settledWatchdogFired) {
      // [T2-③ / LC-1] settled 硬上限到期回收 ≠ 正常完成：被信号终止视为正常完成的
      // 既有语义（maxTurns 达限 kill）不适用于本形态——runSpawn 以错误返回（设计
      // §6.2），错误消息含恢复指引（S-B 验收判据）。closedReason 的 "watchdog" 映射
      // 由 finalize 侧按 error 标记承接（ClosedReason 枚举封闭，不在此擅自扩枚举）。
      success = false;
      error =
        `subagent did not reach agent_settled within ${SETTLED_WATCHDOG_TIMEOUT_MS / MS_PER_SECOND / SECONDS_PER_MINUTE} min (settled watchdog); the process was terminated to bound the wait. ` +
        `Recovery: check state with subagents action:'list', then re-send your message to continue.`;
    } else if (record.lastError) {
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
    // [F-1] schemaExpected：schema/schemaEnv 任一存在即要求结构化产出（耦合形态
    // 两者同设；解耦形态仅 schemaEnv 也要——tool 已注册，产出预期相同）。无有效
    // parsedOutput 时由 collectResult 标注失败，不再静默 success。
    return collectResult(record, {
      startTime,
      success,
      error,
      sessionId: state.sessionHeader?.id ?? record.id,
      sessionFile: record.sessionFile,
      schemaExpected: opts.schema !== undefined || opts.schemaEnv !== undefined,
    });
  } finally {
    // h. 清理临时 prompt 文件
    if (tempPromptFile) {
      await cleanupTempPrompt(tempPromptFile);
    }
  }
}
