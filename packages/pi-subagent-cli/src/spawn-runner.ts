// src/spawn-runner.ts
//
// 协议化 spawn 执行器（W7，impl-plan §2.7）——runSpawn 的引擎侧本体迁移。
//
// core engines/pi/session-runner.ts 的 runSpawn 在壳进程内直接操纵 ExecutionRecord /
// session-pending / settled-watchdog 等宿主编排件；协议化后引擎进程内只保留
// 「spawn pi 子进程 + stdout pump + 事件翻译 + UI 请求发射 + 结果收集」，宿主侧
// 记账由 core 经 `event` 通知与 host/* 反向通道完成（W8 宿主接线 / W10 conformance
// 收口）。本文件是引擎侧的协议化形态：
//
//   - 子进程 spawn 必经 SDK spawnEngineChild（detached:false / 子 stdin 自有 pipe，
//     W10 静态断言目标）+ buildOutboundChildEnv（deny 键剥除）；
//   - 事件经 SdkEvent → AgentEvent 翻译（spawn-args 纯函数）→ SDK journal-replay
//     reducer 累积（ReplayRecordView——core updateFromEvent 的 SDK 下沉副本）；
//   - extension_ui_request 经 ui-request-queue FIFO → host/askUser 反向请求
//     （ack 两阶段，R9-2 语义；handler 缺失时本地去重告警 + cancelled）；
//   - childSpawned / childStateChanged 上报（core 镜像数据源）；
//   - relay 归属键按 W8/H12 重写：SOCKET/NODE/SCRIPT 原样转发，SESSION_ID/
//     RECORD_ID 从 run ctx 重写（不靠 env 继承——spawn env 的 deny 清单已剥）。
//
// 保留在 core 的面（deviations 登记）：chatMode 长驻轮次 / idle timer / 冷续轮
// resume 的宿主编排（ChatRoundTicket / HostBridge 消费面）——v1.x（chat-domain 设计
// §3.2 D1-A）后轮次执行与轮终事件已由本包承载（chatMode 参数 + chat-session 会话
// 管理器），core 侧保留的是编排面（record 状态回写 / idle+activate lock 定时器 /
// 交互编排——host-bridge 头注裁定），engines/pi inproc 分支待 W3 删除。

import type { ChildProcess } from "node:child_process";

import * as fs from "node:fs";
import { dirname } from "node:path";

import {
  buildOutboundChildEnv,
  createReplayRecord,
  getLogger,
  killChain,
  resolveEngineDataDir,
  spawnEngineChild,
  updateFromEvent as updateRecordFromEvent,
  type AgentEvent,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

import { mirrorMainProcessFlags, type MirrorFlags } from "./argv-mirror.ts";
import { registerActiveChild, unregisterActiveChild } from "./active-children.ts";
import { PI_KILL_GRACE_MS } from "./constants.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { collectOutcome, type CollectedOutcome } from "./output-collector.ts";
import { toErrorMessage } from "./error-message.ts";
import {
  asThinkingLevel,
  buildEnvBlock,
  buildSpawnArgs,
  mapAssistantMessageDelta,
  parseSpawnModelRef,
  resolveToolEndArgs,
} from "./spawn-args.ts";
import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
  type SdkEvent,
} from "./spawn-event-adapter.ts";
import { performGetStateHandshake, extractGetStateFields, type GetStateResult } from "./get-state-handshake.ts";
import { clearEpipeFailure, recordEpipeFailure, sendPromptCommand } from "./stdin-writer.ts";
import { cleanupTempPrompt, writePromptToTempFile } from "./temp-prompt.ts";
import { createTurnLimiter, WRAP_UP_HINT } from "./turn-limiter.ts";
import { applySchemaEnvToChildEnv } from "./spawn-args.ts";
import { createUiRequestQueue } from "./ui-request-queue.ts";
import { isRelayActive, RELAY_ENV_RECORD_ID, RELAY_ENV_SESSION_ID } from "./relay-env.ts";
import {
  cleanupSiblingStderrLogs,
  rotateStderrLogIfNeeded,
  stderrLogPathFor,
  stderrRotationParams,
} from "./logs/stderr-rotation.ts";

const logger = getLogger("session-runner");

/** 默认 grace turns（soft limit 后宽限轮数，core 现状值）。 */
const DEFAULT_GRACE_TURNS = 2;

/** 无效 stdout 行的日志截断长度（够诊断、不刷屏）。 */
const INVALID_LINE_LOG_CHARS = 160;

/** 信号退出码合成值（close 无 code 只有 signal 时按 128+ 约定折算非零）。 */
const SIGNAL_EXIT_CODE_BASE = 128;

/** run 的宿主回调面（server.ts 注入：协议通知 + host/* 反向请求）。 */
export interface SpawnRunCallbacks {
  /** AgentEvent 出口（→ `event` 通知，runId + 单调 seq 由 server 层组装）。 */
  onEvent: (event: AgentEvent) => void;
  /** sessionFile/sessionId 就绪回填（→ host/handleReady）。 */
  onHandleReady?: (partial: { sessionRef: Record<string, string>; poolKey: string }) => void;
  /** 一次性子进程 pid 上报（→ host/childSpawned）。 */
  onChildSpawned?: (pid: number, recordId: string) => void;
  /** 子进程状态变更（→ host/childStateChanged；killed 必含）。 */
  onChildStateChanged?: (p: {
    pid: number;
    recordId: string;
    state: "running" | "exited";
    killed: boolean;
    exitCode?: number;
    signal?: string;
  }) => void;
  /** host/askUser 两阶段等待体（handler 缺失时队列自动 cancelled 降级）。 */
  askUser?: (request: UiRequest) => Promise<UiResponse>;
  /** text_delta 分流出口（→ host/streamDelta）。 */
  onDelta?: (delta: string) => void;
  /**
   * [chatMode] agent_end（非 willRetry，队列排空）到达：本轮收敛。不 kill 子进程
   * （长驻），由调用方（chat-session）上报 roundLifecycle settled 相位。
   */
  onChatRoundEnd?: () => void;
  /**
   * [chatMode] agent_settled（真空闲边界）到达：run 在此 resolve（exit 0 口径），
   * 进程保活。调用方（chat-session）据此上报 idle 相位（usage + anchor）。
   */
  onChatAgentSettled?: () => void;
}

/** runSpawnOnce 的入参（协议 RunParams 的引擎侧还原形态）。 */
export interface SpawnRunParams {
  /** record 锚（= run.params.runId；镜像键 / relay RECORD_ID 重写源）。 */
  recordId: string;
  /** 完整 task 文本（含 schema 指令——协议 task.prompt）。 */
  task: string;
  /** agent 名（slug 派生 + prompt 临时文件名）。 */
  agentName: string;
  /** canonical "provider/id"（缺省回落 pi 自身解析）。 */
  model: string | undefined;
  /** thinking level 白名单字面量（协议 ctx 透传）。 */
  thinkingLevel?: string;
  /** subagent session 目录（--session-dir）。 */
  sessionDir: string;
  /** spawn cwd。 */
  cwd: string;
  /** schema env JSON 字符串（PI_WORKFLOW_SCHEMA 注入）。 */
  schemaEnv?: string;
  /** hard turn limit。 */
  maxTurns?: number;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns?: number;
  /** 中断信号（协议 cancel → server 层 AbortController）。 */
  signal?: AbortSignal;
  /** 根 session id（relay SESSION_ID 重写源，协议 ctx 还原）。 */
  sessionRootId?: string;
  /** 追加 system prompt 片段（agent body 之外的调用方片段）。 */
  appendSystemPrompt?: string[];
  /** skill 路径（--skill 多值）。 */
  skillPaths?: string[];
  /** agent 工具白名单（--tools）。 */
  agentTools?: string[];
  /** fork 源 session 文件（--fork）。 */
  forkSource?: string;
  /** 镜像 flag 覆盖（缺省自动镜像主进程 argv）。 */
  mirrorFlags?: MirrorFlags;
  /** resume 目标 session 文件（冷续写：--session 续写原文件）。 */
  resumeSessionFile?: string;
  /**
   * [v1.x chat 会话形态] 长驻模式：agent_end（非 willRetry）不 kill 子进程（轮收敛
   * 交 callbacks.onChatRoundEnd 上报），agent_settled（真空闲）resolve run（exit 0
   * 口径，进程保活——对齐 inproc chatMode「进程长驻」语义）。缺省 = 一次性 run。
   */
  chatMode?: boolean;
}

/** runSpawnOnce 的产物。 */
export interface SpawnRunResult extends Omit<CollectedOutcome, "sessionId"> {
  /** 会话头身份（header / get_state 握手回填；全 miss 时 undefined）。 */
  sessionId: string | undefined;
}

/**
 * SdkEvent → AgentEvent 翻译 + reducer 累积的闭包工厂（core
 * createSpawnEventHandlers 的协议化提取）。
 */
function createSdkEventTranslator(
  record: ReturnType<typeof createReplayRecord>,
  opts: {
    maxTurns?: number;
    graceTurns?: number;
    onEvent: (e: AgentEvent) => void;
    onDelta?: (d: string) => void;
    abort: () => void;
    /** agent_end（非 willRetry）到达：turn 已终态、pi rpc 常驻进程需外部终结。 */
    onAgentEnd?: () => void;
    /** [chatMode] agent_settled（真空闲）到达：run resolve 点 + idle 相位锚点。 */
    onAgentSettled?: () => void;
  },
): (raw: SdkEvent) => void {
  // a. transient 寄存器（tool_end 缺 args 时回填）
  const pendingTools = new Map<string, { toolName: string; args?: unknown }>();

  // b. turnLimiter（spawn 版：abort = kill 子进程；steer 未接通，靠 WRAP_UP_HINT 补偿）
  const limiter = createTurnLimiter({
    maxTurns: opts.maxTurns ?? 0,
    graceTurns: opts.graceTurns ?? DEFAULT_GRACE_TURNS,
    steer: () => {
      // no-op：rpc stdin steer 通道未接通；启动时已注入 WRAP_UP_HINT 让 agent 主动收尾。
    },
    abort: opts.abort,
  });

  // agentEvent 统一出口：reducer + limiter + 协议通知
  const agentEvent = (event: AgentEvent): void => {
    updateRecordFromEvent(record, event);
    if (event.type === "turn_end") limiter.onTurnEnd(record.turnCount);
    if (event.type === "text_delta") opts.onDelta?.(event.delta);
    opts.onEvent(event);
  };

  const accumulateMessageEnd = (raw: SdkEvent): void => {
    const msg = raw.message;
    if (msg?.usage) {
      const { cost: costObj } = msg.usage;
      const usage = {
        input: msg.usage.input ?? 0,
        output: msg.usage.output ?? 0,
        cacheRead: msg.usage.cacheRead ?? 0,
        cacheWrite: msg.usage.cacheWrite ?? 0,
        ...(costObj?.total !== undefined ? { cost: costObj.total } : {}),
      };
      agentEvent({ type: "message_end", usage });
    }
    const stopReason = msg?.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      const errMsg = msg?.errorMessage ?? raw.reason ?? stopReason;
      agentEvent({ type: "error", message: errMsg });
    }
  };

  return (raw: SdkEvent): void => {
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
        agentEvent({
          type: "tool_end",
          toolName,
          args: resolveToolEndArgs(raw, pendingTools),
          result: raw.result,
          isError: raw.isError,
        });
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
      case "agent_end": {
        // [F1.2 根修，Gate B 2026-09-09] pi rpc 模式 turn 完成后进程常驻不退出；
        // 旧 core runSpawn 的 routeAgentEnd（agent_end → 非 willRetry → 终结子进程
        // → close → runSpawn resolve）在 W7 协议化提取时丢失，导致 run 永不终态
        // （事件流出齐全、outcome 悬挂）。此处恢复终结语义：message_end/turn_end
        // 已先于 agent_end 到达并累积进 record，kill 触发 close 后正常收尾。
        // 旧实现的 pending 后代 keep-alive 分支（session 文件 pending:register 差集
        // 判活 + no-progress timer + notifier steer 唤醒）未随迁移——本执行器口径是
        // workflow 域单次 run（见文件头），后台后代保活编排登记为协议化偏差。
        // [v1.x chatMode] 长驻形态分支：不 kill（轮收敛交 onChatRoundEnd 上报），
        // resolve 改挂 agent_settled（真空闲）——对齐 inproc chatMode。
        if (raw.willRetry !== true) opts.onAgentEnd?.();
        return;
      }
      case "agent_settled": {
        // [v1.x chatMode] 真空闲边界（agent_end 之后、post-run 完成后才 emit——
        // pi agent-session _runAgentPrompt finally 块）。仅长驻形态消费：run 在此
        // resolve，turn 计数与 limiter 标志按轮重置（SP-9 对齐：续聊轮独立预算，
        // maxTurns 不跨轮累计）。一次性 run 不消费（agent_end 已 kill，进程不会
        // 活到 settled）。
        if (opts.onAgentSettled !== undefined) {
          record.turnCount = 0;
          limiter.reset();
          opts.onAgentSettled();
        }
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
}

/** 子进程 env 组装（deny 剥除 + schemaEnv 注入 + relay 归属键重写）。 */
function buildChildEnv(params: SpawnRunParams): Record<string, string> {
  const extras: Record<string, string | undefined> = {};
  applySchemaEnvToChildEnv(extras, params.schemaEnv);
  const childEnv = buildOutboundChildEnv({ parentEnv: process.env, extras });
  // relay 归属键重写（W8/H12）：SESSION_ID/RECORD_ID 在 ENGINE_ENV_DENY_LIST，
  // buildOutboundChildEnv 的 deny 在 extras 之后执行——经 extras 注入会被剥掉
  // （旧实现的 RECORD_ID 重写因此从未送达 relay.mjs，归属键缺失 → 退出码 13）。
  // 必须在 deny 终态之后按 run ctx 显式写回（不靠 env 继承）。SESSION_ID 缺省
  // 回落 L0 身份键 PI_SUBAGENT_ROOT_SESSION_ID（协议 v1 ctx 无 sessionRootId
  // 字段；协议补字段后收敛）。
  if (isRelayActive(process.env)) {
    const rootId = params.sessionRootId ?? process.env["PI_SUBAGENT_ROOT_SESSION_ID"];
    if (rootId !== undefined && rootId !== "") childEnv[RELAY_ENV_SESSION_ID] = rootId;
    childEnv[RELAY_ENV_RECORD_ID] = params.recordId;
  }
  return childEnv;
}

/**
 * 单次 spawn run（workflow 域形态）：spawn pi rpc 子进程 → pump stdout → 收集结果。
 *
 * 生命周期：resolve = 子进程 close（exit/error）。abort（signal）经 spawnEngineChild
 * 的 signal 通道发 SIGTERM，升级链由 killPiChild 兜底。
 */
/**
 * stderr tee（W11）：实例维度路径 + 懒打开 + 尺寸轮转（超 XYZ_LOG_MAX_BYTES rename
 * 副本重开）+ 三判据过期清理（同前缀 + pid 已死 + mtime 过期）。失败面全部静默
 * 降级（取证面不拖垮任务主通道——调用方对无 tee 形态 resume 排空防背压）。
 */
function createStderrTee(child: ChildProcess): { close(): void } | undefined {
  if (child.stderr === null) return undefined;
  let dataDir: string;
  try {
    dataDir = resolveEngineDataDir(process.env);
  } catch {
    return undefined;
  }
  const pid = child.pid;
  if (pid === undefined) return undefined;
  const logPath = stderrLogPathFor(dataDir, pid);
  let stream: fs.WriteStream | null = null;
  let failed = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (failed) return;
    try {
      if (stream === null) {
        fs.mkdirSync(dirname(logPath), { recursive: true });
        stream = fs.createWriteStream(logPath, { flags: "a" });
        stream.on("error", () => {
          failed = true;
        });
        cleanupSiblingStderrLogs(logPath, process.env);
      }
      stream.write(chunk);
      if (rotateStderrLogIfNeeded(logPath, stderrRotationParams(process.env))) {
        stream.end();
        stream = null;
      }
    } catch {
      failed = true;
    }
  });
  return {
    close() {
      try {
        stream?.end();
      } catch (err) {
        // best-effort：进程已在退出路径上，tee 关闭失败仅 debug 留痕（不抛——
        // close 挂在 onClose 清理链，抛出会遮蔽真实退出码处理）。
        logger.debug(`[session-runner] stderr tee close best-effort failed: ${toErrorMessage(err)}`);
      }
      stream = null;
    },
  };
}

export async function runSpawnOnce(
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
): Promise<SpawnRunResult> {
  const record = createReplayRecord();
  const startTime = Date.now();
  const modelRef = parseSpawnModelRef(params.model);

  // 1. append-system-prompt 文件（环境块 + wrap-up 提示 + 调用方片段）
  const appendParts: string[] = [await buildEnvBlock(params.cwd)];
  if (params.maxTurns && params.maxTurns > 0) appendParts.push(WRAP_UP_HINT);
  if (params.appendSystemPrompt) appendParts.push(...params.appendSystemPrompt);
  const tempFile = appendParts.length > 0
    ? await writePromptToTempFile(params.agentName, appendParts.join("\n\n"))
    : undefined;

  // 2. spawn 参数 + invocation
  let sessionId: string | undefined;
  let sessionFile: string | undefined;

  if (modelRef === undefined) {
    throw new Error(
      `[pi-subagent-cli] run requires a canonical model ref ("provider/id") in ctx.model, got: ${JSON.stringify(params.model)}. ` +
        `Recovery: the host must resolve the model before dispatching (run.params.ctx.model); check the engine routing layer.`,
    );
  }

  try {
    const args = buildSpawnArgs({
      modelRef,
      thinkingLevel: asThinkingLevel(params.thinkingLevel),
      agentTools: params.agentTools,
      appendSystemPromptPath: tempFile?.filePath,
      sessionDir: params.sessionDir,
      sessionFile: params.resumeSessionFile,
      forkSource: params.forkSource,
      skillPaths: params.skillPaths,
      mirrorFlags: params.mirrorFlags ?? mirrorMainProcessFlags(process.argv),
    });
    const invocation = getPiInvocation(args);
    const child = spawnEngineChild({
      command: invocation.command,
      args: invocation.args,
      env: buildChildEnv(params),
      cwd: params.cwd,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });

    const killChild = (source: string): void => {
      void killChain(child, {
        graceMs: PI_KILL_GRACE_MS,
        unrefTimers: true,
        escalationNote: `child ${params.recordId} (source: ${source})`,
      });
    };
    // agent_end 终结（F1.2）：正常完成后的主动 kill，close 带信号但语义是成功
    // （旧 core waitForChildExit 的 code ?? 0 同义——signal 退出码 143 只属异常路径）。
    let agentEndedCleanly = false;
    // [chatMode] agent_settled 的 run resolve 句柄（inproc state.resolveRun 同款：
    // 声明先于 handler 装配，exitPromise executor 内赋值——事件只会在 pump 启动后
    // 异步到达，无空窗）。
    let resolveChatRun: ((code: number) => void) | undefined;
    const chatMode = params.chatMode === true;
    const handleSdkEvent = createSdkEventTranslator(record, {
      maxTurns: params.maxTurns,
      graceTurns: params.graceTurns,
      onEvent: callbacks.onEvent,
      onDelta: callbacks.onDelta,
      abort: () => killChild("turn limiter abort"),
      onAgentEnd: chatMode
        ? () => {
          // [chatMode] 轮收敛（输出完整）：不 kill，交 chat-session 上报 settled 相位；
          // agentEndedCleanly 置位让「end 与 settled 之间被杀」的 close 也按 0 口径收尾。
          agentEndedCleanly = true;
          callbacks.onChatRoundEnd?.();
        }
        : () => {
          agentEndedCleanly = true;
          killChild("agent_end final kill");
        },
      ...(chatMode
        ? {
          onAgentSettled: () => {
            // 相位上报先于 run resolve（idle 帧先于 run 应答帧——协议事件流时序）
            agentEndedCleanly = true;
            callbacks.onChatAgentSettled?.();
            resolveChatRun?.(0);
          },
        }
        : {}),
    });

    // 2b. stderr tee 落盘（W11，设计 §3.9 同款契约）：pi 任务子进程 stderr 此前
    // 无消费面（pipe 出来即弃，写满会背压卡死子进程）——tee 到实例维度文件
    // <engineDataDir>/logs/pi-task-stderr-<pid>.log（懒打开 + 尺寸轮转 + 三判据
    // 过期清理）；dataDir 不可解析（宿主未注入且无 fallback）时仅排空防背压。
    const stderrTee = createStderrTee(child);
    if (stderrTee === undefined && child.stderr !== null) {
      child.stderr.resume();
    }

    // 3. 镜像上报（childSpawned 先行——未收上报前宿主 = 无句柄）+ 引擎侧记账
    registerActiveChild(params.recordId, child);
    if (child.pid !== undefined) {
      callbacks.onChildSpawned?.(child.pid, params.recordId);
      callbacks.onChildStateChanged?.({
        pid: child.pid,
        recordId: params.recordId,
        state: "running",
        killed: false,
      });
    }

    // 4. UI 请求队列（host/askUser 两阶段等待体注入）
    const enqueueUi = createUiRequestQueue(child, {
      ...(callbacks.askUser !== undefined ? { uiRequestHandler: callbacks.askUser } : {}),
    });

    // 5. get_state response 监听表（握手 + 迟到 response 自弃）
    //    身份回填走响应行的同步路径（不经握手 promise 的 .then 微任务）：同一 stdout
    //    data 事件内握手应答行之后的轮终事件行（chat 的 agent_settled → idle 相位
    //    anchor）立即可见 sessionFile——整 chunk 同帧处理时微任务时序不可靠。
    const stateListeners = new Map<string, (data: unknown) => void>();
    const addStateListener = (id: string, resolver: (data: unknown) => void): void => {
      stateListeners.set(id, (data: unknown) => {
        const picked: GetStateResult = {};
        extractGetStateFields(data, picked);
        if (picked.sessionId !== undefined && sessionId === undefined) sessionId = picked.sessionId;
        if (picked.sessionFile !== undefined && picked.sessionFile !== sessionFile) {
          sessionFile = picked.sessionFile;
          callbacks.onHandleReady?.({
            sessionRef: {
              ...(sessionId !== undefined ? { sessionId } : {}),
              sessionFile: picked.sessionFile,
            },
            poolKey: "shared",
          });
        }
        resolver(data);
      });
    };

    // 6. stdout pump
    const exitPromise = new Promise<number>((resolveExit) => {
      // [chatMode] agent_settled resolve 句柄落位（见上方 resolveChatRun 声明处注释）
      resolveChatRun = resolveExit;
      let buffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          consumeLine(line);
          nl = buffer.indexOf("\n");
        }
      });
      const consumeLine = (line: string): void => {
        const parsed = parseSpawnLine(line);
        if (parsed === null) return;
        switch (parsed.kind) {
          case "header": {
            sessionId = parsed.header.id;
            sessionFile = deriveSessionFilePath(parsed.header, params.sessionDir);
            callbacks.onHandleReady?.({
              sessionRef: {
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(sessionFile !== undefined ? { sessionFile } : {}),
              },
              poolKey: "shared",
            });
            return;
          }
          case "event": {
            handleSdkEvent(parsed.event);
            return;
          }
          case "response": {
            if (parsed.id !== undefined && stateListeners.has(parsed.id)) {
              const resolver = stateListeners.get(parsed.id);
              stateListeners.delete(parsed.id);
              resolver?.(parsed.success ? parsed.data : undefined);
            }
            return;
          }
          case "extension_ui_request": {
            enqueueUi(parsed.id, parsed.request);
            return;
          }
          case "invalid": {
            logger.debug(
              `[session-runner] invalid stdout line from ${params.recordId} (ignored): ${parsed.raw.slice(0, INVALID_LINE_LOG_CHARS)}`,
              { error: parsed.error },
            );
            return;
          }
        }
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        stateListeners.clear();
        stderrTee?.close();
        unregisterActiveChild(params.recordId, child);
        if (child.pid !== undefined) {
          callbacks.onChildStateChanged?.({
            pid: child.pid,
            recordId: params.recordId,
            state: "exited",
            killed: child.killed,
            ...(code !== null ? { exitCode: code } : {}),
            ...(signal !== null ? { signal } : {}),
          });
        }
        // 兜底反查（LC-4）：header/握手全 miss 时按 sessionId 后缀匹配 sessionDir
        if (sessionFile === undefined && sessionId !== undefined) {
          sessionFile = findSessionFileByHeaderId(params.sessionDir, sessionId);
        }
        // agent_end 主动终结的 close 是正常完成（exit code 0 口径）；其余信号退出
        // 保持 128+ 折算（异常路径判据）。
        resolveExit(agentEndedCleanly ? 0 : code ?? (signal !== null ? SIGNAL_EXIT_CODE_BASE : 0));
      };
      child.once("close", onClose);
      child.once("error", (err) => {
        logger.error(`[session-runner] child ${params.recordId} error event`, {
          detail: toErrorMessage(err),
        });
        onClose(null, null);
      });
      // stdin 异步 error（EPIPE 半面②）：计数留痕（热路径投递据此判死）
      child.stdin?.on("error", (err) => {
        if (
          err !== null && typeof err === "object" && "code" in err &&
          ((err as NodeJS.ErrnoException).code === "EPIPE" ||
            (err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED")
        ) {
          recordEpipeFailure(params.recordId);
        }
      });
    });

    // 7. get_state 握手 fire-and-forget（RPC mode 无 header 行，靠握手回填身份）——
    //    先于 prompt 发出：chat 会话形态的 idle 相位 anchor 与 run 应答 handle 都需要
    //    sessionFile，身份先知再驱动轮次（stdout 流序保证握手应答先于轮终事件）。
    //    身份回填主体在 addStateListener 的同步路径（见第 5 步注释），此处仅兜底
    //    超时重试轮次拿到的新值（同值去重，不重发 handleReady）。
    void performGetStateHandshake(child, addStateListener).then((r) => {
      if (r.sessionId !== undefined && sessionId === undefined) sessionId = r.sessionId;
      if (r.sessionFile !== undefined && r.sessionFile !== sessionFile) {
        sessionFile = r.sessionFile;
        callbacks.onHandleReady?.({
          sessionRef: {
            ...(sessionId !== undefined ? { sessionId } : {}),
            sessionFile: r.sessionFile,
          },
          poolKey: "shared",
        });
      }
    });

    // 8. prompt 命令（rpc mode 唯一任务驱动通道）
    sendPromptCommand(child, params.task);

    // 9. 等待退出
    const exitCode = await exitPromise;
    clearEpipeFailure(params.recordId);

    const outcome = collectOutcome(record, {
      startTime,
      success: exitCode === 0,
      error: exitCode === 0 ? undefined : `pi child exited with code ${exitCode}`,
      sessionId: sessionId ?? "",
      sessionFile,
      ...(params.schemaEnv !== undefined ? { schemaExpected: true } : {}),
    });
    return { ...outcome, sessionId };
  } finally {
    if (tempFile !== undefined) await cleanupTempPrompt(tempFile);
  }
}

// 活跃子进程记账（自本文件提取至 active-children.ts，行为等价）：
// re-export 保持既有导入面（index.ts / pi-engine.ts / chat-session.ts / __tests__）。
export {
  getActiveChild,
  killAllActiveChildren,
  registerActiveChild,
  unregisterActiveChild,
} from "./active-children.ts";

// spawn-runner 内部消费：handshake 结果防 unused（诊断面保留导出读取器）
