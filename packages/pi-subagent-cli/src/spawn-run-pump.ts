// src/spawn-run-pump.ts
//
// stdout pump + close 收尾 + session 身份回填（自 runSpawnOnce 行为等价提取的
// 子进程生命周期接线面）。身份四路同源：header 行 / get_state 应答（响应行同步
// 路径 + 握手 promise 兜底）/ LC-4 后缀反查 / M4 close 兜底扫描（prompt 头部键，
// 见 session-file-locator.ts）——写入口收敛在 identity tracker。

import type { ChildProcess } from "node:child_process";

import { getLogger, pumpNdjsonLines } from "@zhushanwen/subagent-engine-sdk";

import { unregisterActiveChild } from "./active-children.ts";
import { toErrorMessage } from "./error-message.ts";
import { extractGetStateFields, type GetStateResult } from "./get-state-handshake.ts";
import { locateSessionFileByPromptHead, type SessionFileScanResult } from "./session-file-locator.ts";
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
      if (sessionFile !== undefined || sessionId === undefined) return;
      const found = findSessionFileByHeaderId(sessionDir, sessionId);
      if (found === undefined) return;
      // 走既有回填面（与 M2 回补 / M4 采纳同一条路）：sessionFile 落位（collectOutcome
      // 的 outcome.sessionFile 生效）+ handleReady 通知宿主回写 record——chat 域的 run
      // 在 agent_settled 已应答，close 兜底是 record 补 transcript 锚点的最后时机，
      // 与 M4 采纳面保持一致（只补 sessionFile，sessionId 已知不再变更）。
      applyGetStateFields({ sessionFile: found });
    },
    clearStateListeners() {
      stateListeners.clear();
    },
  };
}

/**
 * M4 close 兜底扫描输入（prompt 头部键找回 sessionFile，设计决策 4）。
 *
 * 调用方（runSpawnOnce）在装配 pump deps 时提供；缺省 = 不扫描（LC-4 之后仍缺
 * sessionFile 时只 warn 留痕，无最后一道兜底）。
 */
export interface SessionFileFallbackInput {
  /** 任务 prompt 全文（扫描器内部截头部作匹配键）。 */
  prompt: string;
  /** run spawn 起始时刻（mtime 窗口下界，ms）。 */
  spawnStartedAtMs: number;
  /** 子进程 session 目录（--session-dir）。 */
  sessionDir: string;
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
  /**
   * M4 close 兜底扫描输入（设计决策 4）：LC-4 之后 sessionFile 仍缺时按 prompt
   * 头部键扫 sessionDir。缺省 = 不扫描（保留既有调用面的可选性）。
   */
  sessionFileFallback?: SessionFileFallbackInput;
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

/**
 * 放弃诊断里的候选数渲染（U-A4）：时间门/收集期异常打断时 candidateCount 只是
 * **部分计数**，窗口总数未知——必须写明，否则 warn 会让人误判「窗口内候选很少」。
 */
export function formatCandidateCount(scan: Pick<SessionFileScanResult, "candidateCount" | "candidateTotalKnown">): string {
  return scan.candidateTotalKnown
    ? `candidates=${scan.candidateCount}`
    : `candidates=${scan.candidateCount} so far (collection aborted: window total unknown)`;
}

/**
 * M4 close 兜底（设计决策 4）：LC-4 之后 sessionFile 仍缺时的第五路获取——按任务
 * prompt 头部键扫 sessionDir（mtime 窗口 + 首 64KB 头读 + 单命中才采纳）。
 *
 * 不抛错契约：扫描器自持 try-catch，此处再兜一层调用期异常（含 identity 回填链
 * onHandleReady → server 组帧抛出）——close finalizer 的 resolveExit 必达是硬约束
 * （设计 §3.4；先例 stderrTee.close 的 best-effort 注释）。采纳/放弃均 warn 留痕，
 * 采纳的 warn 附审计证据（候选文件名 + mtime + prompt 头哈希，不落 prompt 明文）。
 */
function recoverSessionFileByPromptHead(deps: StdoutPumpDeps): void {
  const { recordId, identity, sessionFileFallback } = deps;
  if (identity.sessionFile !== undefined) return;
  if (sessionFileFallback === undefined) {
    logger.warn(
      `[sessionfile] unobtainable for ${recordId} (M4 prompt-head scan not wired: StdoutPumpDeps.sessionFileFallback absent); ` +
        `record finalized without transcript anchor. Recovery: archive the session file via session-reader by sessionDir mtime window, or re-dispatch the task.`,
    );
    return;
  }
  try {
    const scan = locateSessionFileByPromptHead({
      sessionDir: sessionFileFallback.sessionDir,
      spawnStartedAtMs: sessionFileFallback.spawnStartedAtMs,
      closeAtMs: Date.now(),
      prompt: sessionFileFallback.prompt,
    });
    if (scan.sessionFile === undefined) {
      const errorSuffix = scan.errorMessage !== undefined ? `, error=${scan.errorMessage}` : "";
      logger.warn(
        `[sessionfile] unobtainable for ${recordId} (M4 prompt-head scan gave up: reason=${scan.reason}, ` +
          `${formatCandidateCount(scan)}, promptHeadHash=${scan.promptHeadHash}${errorSuffix}); ` +
          `record finalized without transcript anchor. Recovery: archive the session file via session-reader by sessionDir mtime window, or re-dispatch the task.`,
      );
      return;
    }
    logger.warn(
      `[sessionfile] recovered for ${recordId} by M4 prompt-head scan (single match): file=${scan.matchedFileName}, ` +
        `mtime=${scan.matchedMtimeMs}, promptHeadHash=${scan.promptHeadHash} (audit evidence for mis-binding review)`,
    );
    // 回填走 identity 既有通路（与迟到 response / M2 回补同一条面）：sessionFile 落位
    // → collectOutcome 的 outcome.sessionFile 生效；handleReady 通知 core 回写 record。
    identity.applyGetStateFields({ sessionFile: scan.sessionFile });
  } catch (err) {
    logger.warn(
      `[sessionfile] M4 prompt-head scan threw for ${recordId} (treated as miss, close finalizer continues)`,
      { detail: toErrorMessage(err) },
    );
  }
}

/**
 * close/exit 收尾：监听表清理 + tee 关闭 + 镜像上报 + LC-4 反查 + M4 兜底扫描 + 退出码折算 resolve。
 *
 * 必达契约（U-A5，G1 破口）：链上任一步抛错都不许跳过后续步骤，尤其不许跳过
 * `resolveExit`——`reportChildExited` 直调宿主回调（server 组帧链）且原先无包裹，
 * 宿主回调抛出即让 LC-4/M4 与 resolveExit 全部丢失 = run 永挂（G1 要根除的形态）。
 * 故每步独立 best-effort（单个步骤抛错只降级该步并 warn 留痕），resolveExit 放
 * finally 必达区；异常也不得逃出 close 监听器（逃出即宿主 uncaughtException）。
 */
function createCloseFinalizer(
  deps: StdoutPumpDeps,
  resolveExit: (code: number) => void,
): (code: number | null, signal: NodeJS.Signals | null) => void {
  const { child, recordId, callbacks, identity, stderrTee, runEnd } = deps;
  const bestEffort = (step: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.warn(
        `[session-runner] close finalizer step '${step}' failed for ${recordId} `
          + `(degraded; remaining steps and resolveExit still run)`,
        { detail: toErrorMessage(err) },
      );
    }
  };
  return (code, signal) => {
    try {
      bestEffort("clearStateListeners", () => identity.clearStateListeners());
      bestEffort("stderrTee.close", () => stderrTee?.close());
      bestEffort("unregisterActiveChild", () => unregisterActiveChild(recordId, child));
      // 宿主回调（onChildStateChanged → server 组帧链）：抛错不得阻断下面的兜底链
      bestEffort("reportChildExited", () => reportChildExited(child, recordId, callbacks, code, signal));
      bestEffort("LC-4 suffix lookup", () => identity.fallbackSessionFileByHeaderId());
      // M4（设计决策 4）：LC-4 之后仍缺 → prompt 头部键扫描（必达区内的最后一路兜底）
      bestEffort("M4 prompt-head scan", () => recoverSessionFileByPromptHead(deps));
    } finally {
      // agent_end 主动终结的 close 是正常完成（exit code 0 口径）；其余信号退出
      // 保持 128+ 折算（异常路径判据）。resolveExit 无条件必达。
      resolveExit(normalizeExitCode(runEnd.endedCleanly, code, signal));
    }
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
    pumpNdjsonLines(child.stdout, consumeLine);
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
