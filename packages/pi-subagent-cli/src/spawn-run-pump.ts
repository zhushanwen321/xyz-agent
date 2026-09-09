// src/spawn-run-pump.ts
//
// stdout pump + close 收尾 + session 身份回填（自 runSpawnOnce 行为等价提取的
// 子进程生命周期接线面）。身份三路同源：header 行 / get_state 应答（响应行同步
// 路径 + 握手 promise 兜底）/ LC-4 后缀反查——写入口收敛在 identity tracker。

import type { ChildProcess } from "node:child_process";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import { unregisterActiveChild } from "./active-children.ts";
import { toErrorMessage } from "./error-message.ts";
import { extractGetStateFields, type GetStateResult } from "./get-state-handshake.ts";
import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
  type ExtensionUiRequest,
  type SdkEvent,
  type SpawnSessionHeader,
} from "./spawn-event-adapter.ts";
import type { SpawnRunCallbacks } from "./spawn-runner.ts";
import { recordEpipeFailure } from "./stdin-writer.ts";

const logger = getLogger("session-runner");

/** 无效 stdout 行的日志截断长度（够诊断、不刷屏）。 */
const INVALID_LINE_LOG_CHARS = 160;

/** 信号退出码合成值（close 无 code 只有 signal 时按 128+ 约定折算非零）。 */
const SIGNAL_EXIT_CODE_BASE = 128;

/** run 收尾状态（agent_end / agent_settled 与 close 收尾共享的可变句柄）。 */
export interface RunEndState {
  /** agent_end 置位：主动终结的 close 按成功口径（exit 0）收尾。 */
  endedCleanly: boolean;
  /** [chatMode] agent_settled 的 run resolve 句柄（exitPromise executor 内落位）。 */
  resolveChatRun?: (code: number) => void;
}

/** session 身份回填状态机（三路写同源；get_state 监听表随行持有）。 */
export interface SessionIdentityTracker {
  readonly sessionId: string | undefined;
  readonly sessionFile: string | undefined;
  /** header 行：id + session 文件路径全量落位（handleReady 双字段条件展开）。 */
  noteHeader(header: SpawnSessionHeader): void;
  /** get_state response 监听登记（握手 + 迟到 response 自弃）。 */
  addStateListener(id: string, resolver: (data: unknown) => void): void;
  /** response 帧分发（一次性消费；未知 id 自弃；失败帧以 undefined resolve）。 */
  dispatchStateResponse(id: string | undefined, success: boolean, data: unknown): void;
  /** get_state 字段落位（同步路径 + 握手兜底共用；新值才覆盖 + 重发 handleReady）。 */
  applyGetStateFields(fields: GetStateResult): void;
  /** 兜底反查（LC-4）：header/握手全 miss 时按 sessionId 后缀匹配 sessionDir。 */
  fallbackSessionFileByHeaderId(): void;
  /** close 收尾：未决监听表清空。 */
  clearStateListeners(): void;
}

/**
 * session 身份回填状态机。get_state 身份回填走响应行的同步路径（不经握手
 * promise 的 .then 微任务）：同一 stdout data 事件内握手应答行之后的轮终事件行
 * （chat 的 agent_settled → idle 相位 anchor）立即可见 sessionFile——整 chunk
 * 同帧处理时微任务时序不可靠。
 */
export function createSessionIdentityTracker(
  sessionDir: string,
  callbacks: SpawnRunCallbacks,
): SessionIdentityTracker {
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  const stateListeners = new Map<string, (data: unknown) => void>();

  const applyGetStateFields = (fields: GetStateResult): void => {
    if (fields.sessionId !== undefined && sessionId === undefined) sessionId = fields.sessionId;
    if (fields.sessionFile !== undefined && fields.sessionFile !== sessionFile) {
      sessionFile = fields.sessionFile;
      callbacks.onHandleReady?.({
        sessionRef: {
          ...(sessionId !== undefined ? { sessionId } : {}),
          sessionFile: fields.sessionFile,
        },
        poolKey: "shared",
      });
    }
  };

  return {
    get sessionId() {
      return sessionId;
    },
    get sessionFile() {
      return sessionFile;
    },
    noteHeader(header) {
      sessionId = header.id;
      sessionFile = deriveSessionFilePath(header, sessionDir);
      callbacks.onHandleReady?.({
        sessionRef: {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(sessionFile !== undefined ? { sessionFile } : {}),
        },
        poolKey: "shared",
      });
    },
    addStateListener(id, resolver) {
      stateListeners.set(id, (data: unknown) => {
        const picked: GetStateResult = {};
        extractGetStateFields(data, picked);
        applyGetStateFields(picked);
        resolver(data);
      });
    },
    dispatchStateResponse(id, success, data) {
      if (id === undefined || !stateListeners.has(id)) return;
      const resolver = stateListeners.get(id);
      stateListeners.delete(id);
      resolver?.(success ? data : undefined);
    },
    applyGetStateFields,
    fallbackSessionFileByHeaderId() {
      if (sessionFile === undefined && sessionId !== undefined) {
        sessionFile = findSessionFileByHeaderId(sessionDir, sessionId);
      }
    },
    clearStateListeners() {
      stateListeners.clear();
    },
  };
}

/** stdout pump 接线依赖（runSpawnOnce 装配后的每 run 依赖集）。 */
export interface StdoutPumpDeps {
  child: ChildProcess;
  recordId: string;
  callbacks: SpawnRunCallbacks;
  identity: SessionIdentityTracker;
  handleSdkEvent: (raw: SdkEvent) => void;
  enqueueUi: (id: string, request: ExtensionUiRequest) => void;
  stderrTee: { close(): void } | undefined;
  runEnd: RunEndState;
}

/** stdout 行消费（parseSpawnLine 分类 → 身份/事件/响应/UI 各通道）。 */
function createLineConsumer(deps: StdoutPumpDeps): (line: string) => void {
  const { recordId, identity, handleSdkEvent, enqueueUi } = deps;
  return (line: string): void => {
    const parsed = parseSpawnLine(line);
    if (parsed === null) return;
    switch (parsed.kind) {
      case "header":
        identity.noteHeader(parsed.header);
        return;
      case "event":
        handleSdkEvent(parsed.event);
        return;
      case "response":
        identity.dispatchStateResponse(parsed.id, parsed.success, parsed.data);
        return;
      case "extension_ui_request":
        enqueueUi(parsed.id, parsed.request);
        return;
      case "invalid":
        logger.debug(
          `[session-runner] invalid stdout line from ${recordId} (ignored): ${parsed.raw.slice(0, INVALID_LINE_LOG_CHARS)}`,
          { error: parsed.error },
        );
        return;
    }
  };
}

/** 镜像上报：子进程退出态（core childStateChanged 数据源；pid 缺失不上报）。 */
function reportChildExited(
  child: ChildProcess,
  recordId: string,
  callbacks: SpawnRunCallbacks,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (child.pid === undefined) return;
  callbacks.onChildStateChanged?.({
    pid: child.pid,
    recordId,
    state: "exited",
    killed: child.killed,
    ...(code !== null ? { exitCode: code } : {}),
    ...(signal !== null ? { signal } : {}),
  });
}

/** close 退出码口径：agent_end 主动终结 = 0；其余 signal 退出按 128+ 折算（异常判据）。 */
function normalizeExitCode(
  endedCleanly: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  return endedCleanly ? 0 : code ?? (signal !== null ? SIGNAL_EXIT_CODE_BASE : 0);
}

/** close/exit 收尾：监听表清理 + tee 关闭 + 镜像上报 + LC-4 反查 + 退出码折算 resolve。 */
function createCloseFinalizer(
  deps: StdoutPumpDeps,
  resolveExit: (code: number) => void,
): (code: number | null, signal: NodeJS.Signals | null) => void {
  const { child, recordId, callbacks, identity, stderrTee, runEnd } = deps;
  return (code, signal) => {
    identity.clearStateListeners();
    stderrTee?.close();
    unregisterActiveChild(recordId, child);
    reportChildExited(child, recordId, callbacks, code, signal);
    identity.fallbackSessionFileByHeaderId();
    // agent_end 主动终结的 close 是正常完成（exit code 0 口径）；其余信号退出
    // 保持 128+ 折算（异常路径判据）。
    resolveExit(normalizeExitCode(runEnd.endedCleanly, code, signal));
  };
}

/**
 * stdout pump + close 收尾接线（resolve = 子进程 close/exit/error；返回 exit
 * promise）。注册序（data → close → error → stdin error）与事件时序契约见
 * runSpawnOnce 各步注释。
 */
export function wireChildStdoutPump(deps: StdoutPumpDeps): Promise<number> {
  const { child } = deps;
  return new Promise<number>((resolveExit) => {
    // [chatMode] agent_settled resolve 句柄落位（见 runEnd 声明处注释）
    deps.runEnd.resolveChatRun = resolveExit;
    const consumeLine = createLineConsumer(deps);
    const onClose = createCloseFinalizer(deps, resolveExit);
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
    child.once("close", onClose);
    child.once("error", (err) => {
      logger.error(`[session-runner] child ${deps.recordId} error event`, {
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
        recordEpipeFailure(deps.recordId);
      }
    });
  });
}

/** 镜像上报：spawn 成功（childSpawned 先行——未收上报前宿主 = 无句柄）。 */
export function reportChildSpawned(
  child: ChildProcess,
  recordId: string,
  callbacks: SpawnRunCallbacks,
): void {
  if (child.pid === undefined) return;
  callbacks.onChildSpawned?.(child.pid, recordId);
  callbacks.onChildStateChanged?.({
    pid: child.pid,
    recordId,
    state: "running",
    killed: false,
  });
}
