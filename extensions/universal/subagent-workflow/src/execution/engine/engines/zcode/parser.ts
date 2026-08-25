// src/execution/engine/engines/zcode/parser.ts
//
// ZcodeEngine parser（P3）：stdout 有界收集 → 终 JSON 解析 → 合成 coarse AgentEvent
// 流（设计 §3.3.7「批量引擎进程退出后一次性 emit 合成事件」形态）。TS 重写自 zsub
// driver.js 的 createBoundedLineBuffer / parseStdoutJson，机制保留：
//   - 有界双缓冲（头 4K + 尾 64K）：zcode response 可达数十 KB，无上限累加在长任务
//     下爆内存；超限以「行」为单位丢弃，头尾各自保持可读。代价：单行 JSON 超过尾部
//     窗口时无法完整解析——按错误路径处理（错误信息带尾部），内存安全优先。
//   - 容错解析：正常是单个 JSON 文档；混入日志行则截取首尾大括号间内容。
//
// 事件产出不变量（设计 §3.3.7，coarse 口径）：turn_end 前至少一个 message_end；
// message_end.usage 出现时为完整 AgentUsage 形状（缺数据给显式 0，不给残缺对象）。

import type { Readable } from "node:stream";

import type { AgentUsage as ExecutionAgentUsage } from "../../../types.ts";
import type { AgentUsage as OutcomeAgentUsage } from "../../../../orchestration/models/types.ts";
import type { AgentEvent } from "../../types.ts";
import { ZCODE_ERROR_TAIL_CHARS } from "./constants.ts";
import type { ZcodeLaunchedProcess } from "./launcher.ts";

// ============================================================
// 有界行缓冲（zsub createBoundedLineBuffer 移植）
// ============================================================

export interface BoundedLineBuffer {
  push(chunk: string): void;
  flush(): void;
  text(): string;
  tail(n: number): string;
}

const DEFAULT_HEAD_BYTES = 4096;
// eslint-disable-next-line no-magic-numbers -- 64KB = 64 * 1024 bytes
const DEFAULT_TAIL_BYTES = 64 * 1024;

export function createBoundedLineBuffer(opts: { headLimit?: number; tailLimit?: number } = {}): BoundedLineBuffer {
  const headLimit = opts.headLimit ?? DEFAULT_HEAD_BYTES;
  const tailLimit = opts.tailLimit ?? DEFAULT_TAIL_BYTES;
  let pending = "";
  let head = "";
  let headFull = false;
  const tailLines: string[] = [];
  let tailBytes = 0;
  let droppedBytes = 0;

  function addLine(line: string): void {
    if (!headFull) {
      if (head.length + line.length <= headLimit) {
        head += line;
        return;
      }
      headFull = true;
    }
    tailLines.push(line);
    tailBytes += line.length;
    // 超出尾部窗口：从最旧的行开始丢
    while (tailBytes > tailLimit && tailLines.length > 1) {
      const dropped = tailLines.shift()!;
      tailBytes -= dropped.length;
      droppedBytes += dropped.length;
    }
    // 单行超过整个尾部窗口：只保留该行结尾（JSON 的错误信息通常在末尾）
    if (tailBytes > tailLimit && tailLines.length === 1) {
      const over = tailBytes - tailLimit;
      tailLines[0] = tailLines[0]!.slice(over);
      tailBytes -= over;
      droppedBytes += over;
    }
  }

  return {
    push(chunk: string): void {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        addLine(pending.slice(0, nl + 1));
        pending = pending.slice(nl + 1);
      }
    },
    flush(): void {
      if (pending !== "") {
        addLine(pending);
        pending = "";
      }
    },
    text(): string {
      this.flush();
      const mid =
        droppedBytes > 0 ? `\n[zcode-engine] 输出过长，头尾之间已丢弃 ${droppedBytes} 字节\n` : "";
      return head + mid + tailLines.join("");
    },
    tail(n: number): string {
      const t = this.text();
      return t.length > n ? t.slice(t.length - n) : t;
    },
  };
}

// ============================================================
// 终 JSON 解析（含运行时 guard——禁 any）
// ============================================================

/** stdout 里的原生 usage 形状（2026-08-25 实测 0.16.5，字段名带 Tokens 后缀）。 */
export interface ZcodeRawUsage {
  source?: unknown;
  modelRequestCount?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
}

/** 容错解析 stdout：直接 JSON.parse；失败则截取首尾大括号间内容再试。 */
export function parseZcodeStdoutJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // 混入日志行等形态——吞掉异常继续首尾大括号容错提取（malformed 是降级输入不是错误态）
    void err;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function finiteOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 原生 usage → 事件层 AgentUsage（execution 版：四项 token；cost 无来源缺省）。 */
export function mapZcodeUsage(raw: unknown): ExecutionAgentUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as ZcodeRawUsage;
  if (r.inputTokens === undefined && r.outputTokens === undefined) return undefined;
  return {
    input: finiteOr(r.inputTokens, 0),
    output: finiteOr(r.outputTokens, 0),
    cacheRead: finiteOr(r.cacheReadTokens, 0),
    cacheWrite: finiteOr(r.cacheWriteTokens, 0),
  };
}

/**
 * 原生 usage + projection → 终态层 AgentUsage（orchestration 版：cost/contextTokens/
 * turns 为必填）。zcode 不回传 cost（调研附录 A「cost 回传 ❌」）——显式 0（消费方按
 * 「显示降级」处理，不给残缺）；contextTokens 取 projection.contextUsed（当前上下文
 * 占用），turns 取 projection.turnCount。
 */
export function mapZcodeOutcomeUsage(rawUsage: unknown, projection: unknown): OutcomeAgentUsage | undefined {
  const base = mapZcodeUsage(rawUsage);
  if (base === undefined) return undefined;
  const p =
    typeof projection === "object" && projection !== null ? (projection as Record<string, unknown>) : {};
  const r = typeof rawUsage === "object" && rawUsage !== null ? (rawUsage as ZcodeRawUsage) : {};
  const contextTokens = firstFinite(p["contextUsed"], r.totalTokens, 0);
  const turns = firstFinite(p["turnCount"], 1);
  return { ...base, cost: 0, contextTokens, turns };
}

function firstFinite(...vals: unknown[]): number {
  for (const v of vals) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 终 JSON 的解析产物（引擎消费面——response 必须是 string 才算合法终态）。 */
export interface ZcodeTerminalPayload {
  sessionId?: string;
  response: string;
  /** 事件层 usage（execution 版 AgentUsage——message_end 合成用）。 */
  usage?: ExecutionAgentUsage;
  /** 终态层 usage（orchestration 版 AgentUsage——AgentOutcome.usage 用）。 */
  outcomeUsage?: OutcomeAgentUsage;
  /** projection.turnCount（gui/record 的轮数参考；解析不出则缺省）。 */
  turnCount?: number;
}

export type ZcodeTerminalParse =
  | { ok: true; payload: ZcodeTerminalPayload }
  | { ok: false; reason: string };

/** 解析终 JSON 并做形状校验（sessionId/usage/turnCount 逐字段 guard）。 */
export function parseZcodeTerminal(stdout: string): ZcodeTerminalParse {
  const parsed = parseZcodeStdoutJson(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "stdout 不是 JSON 对象" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.response !== "string") {
    return { ok: false, reason: "终 JSON 缺 string 型 response 字段（zcode 格式漂移嫌疑）" };
  }
  const usage = mapZcodeUsage(obj.usage);
  const projection =
    typeof obj.projection === "object" && obj.projection !== null
      ? (obj.projection as Record<string, unknown>)
      : undefined;
  const outcomeUsage = mapZcodeOutcomeUsage(obj.usage, projection);
  const turnCountRaw = projection?.turnCount;
  return {
    ok: true,
    payload: {
      response: obj.response,
      ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(outcomeUsage !== undefined ? { outcomeUsage } : {}),
      ...(typeof turnCountRaw === "number" && Number.isFinite(turnCountRaw) ? { turnCount: turnCountRaw } : {}),
    },
  };
}

// ============================================================
// 输出收集（进程退出 + 有界缓冲终态）
// ============================================================

export interface ZcodeCollectedOutput {
  exitCode: number | null;
  signal?: string;
  /** 有界 stdout 全文（头 4K + 尾 64K，中间丢弃段有标记行）。 */
  stdoutText: string;
  /** stderr 尾部（有界 4K）。 */
  stderrTail: string;
}

/**
 * 等待可读流终止（end/close/error 任一，1s 超时兜底）。
 * 为什么不能只 await 进程退出：宿主在微任务上下文里续跑时（vitest / async 编排链），
 * 进程 exited 的 promise 续跑可能先于流 data/end 事件的 nextTick 冲刷——直接读缓冲
 * 会拿到空串。等流终止事件是确定性的「数据已收完」判据；超时兜底防流异常挂起。
 */
/** 流终止等待超时（兜底挂起流；比杀链 grace 短一个量级即可）。 */
const DRAIN_TIMEOUT_MS = 1_000;

function drainReadable(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("end", finish);
      stream.removeListener("close", finish);
      stream.removeListener("error", finish);
      clearTimeout(timer);
      resolve();
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
    const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** 消费进程输出直到退出（事件 emit 前的收集段——终态解析素材）。 */
export async function collectZcodeOutput(
  proc: Pick<ZcodeLaunchedProcess, "stdout" | "stderr" | "exited">,
): Promise<ZcodeCollectedOutput> {
  const outBuf = createBoundedLineBuffer();
  // stderr 只做诊断：不进解析路径，尾部 4K 足够
  const errBuf = createBoundedLineBuffer({ headLimit: 0, tailLimit: DEFAULT_TAIL_BYTES });
  proc.stdout.on("data", (d: Buffer | string) => {
    outBuf.push(typeof d === "string" ? d : d.toString("utf8"));
  });
  proc.stderr.on("data", (d: Buffer | string) => {
    errBuf.push(typeof d === "string" ? d : d.toString("utf8"));
  });
  const { code, signal } = await proc.exited;
  await drainReadable(proc.stdout);
  await drainReadable(proc.stderr);
  outBuf.flush();
  errBuf.flush();
  return {
    exitCode: code,
    ...(signal !== undefined ? { signal } : {}),
    stdoutText: outBuf.text(),
    stderrTail: errBuf.text(),
  };
}

// ============================================================
// coarse 事件合成（不变量：turn_end 最后、其前至少一个 message_end）
// ============================================================

/** 终态成功时合成的最小事件序列（coarse 引擎只有终态级信息——设计 D3 eventGranularity）。 */
export function synthesizeCoarseEvents(response: string, usage?: ExecutionAgentUsage): AgentEvent[] {
  return [
    // usage 给不出完整形状时显式缺省整个字段，不给残缺对象（不变量 2）
    { type: "message_end", ...(usage !== undefined ? { usage } : {}) },
    { type: "turn_end" },
  ] as AgentEvent[];
}

// ============================================================
// engine_run_failed 错误文案（设计 §3.3.3 错误规格行）
// ============================================================

/**
 * 运行中失败的结构化文案：stdout 尾部 2000 字 + exit code + 恢复指引。
 *
 * 指引按 stderr 特征归因（2026-08-25 真机教训：LLM 端点不可达导致的
 * AI_APICallError 曾套用「查版本/重跑探针/补 golden」指引，误导排查方向）：
 *   - LLM API 调用失败（stderr 含 AI_APICallError）：CLI 本体与输出解析正常，
 *     指向池内 provider 的 baseURL/apiKey 排查；
 *   - 其余（spawn 成功但格式漂移/解析失败）：保留 probe/golden 指引。
 */
/** 错误文案里 stderr 尾部回显长度（stdout 有专用 2000 常量，stderr 更短防刷屏）。 */
const STDERR_TAIL_IN_MSG_CHARS = 500;

/** vercel.ai SDK 的 API 调用错误类名——zcode CLI 内部 LLM 调用失败的稳定特征。 */
const LLM_API_FAILURE_SIGNATURE = "AI_APICallError";

/**
 * 折叠 stderr 里 console.log 浅序列化产生的 "[Object]" 噪音行
 * （真实堆栈里常出现连续十余行 `[Object], [Object], …`，折叠后保留计数）。
 */
function compactStderrObjectNoise(tail: string): string {
  const OBJECT_LINE = /^(\[Object\][,\s]*)+$/;
  const lines = tail.split("\n");
  const out: string[] = [];
  let run = 0;
  const flush = (): void => {
    if (run > 0) {
      out.push(`[Object]×${run}`);
      run = 0;
    }
  };
  for (const line of lines) {
    if (OBJECT_LINE.test(line.trim())) {
      run++;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

export function buildRunFailedMessage(opts: {
  /** 实际使用的 CLI 路径（用户可经 XYZ_ZCODE_CLI 覆盖——文案必须引用真路径，不硬编码缺省值）。 */
  cliPath: string;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail?: string;
  parseReason?: string;
  /** 本次任务解析出的模型全名（provider/model）——LLM 失败归因时点名排查对象。 */
  modelRef?: string;
  /** 池内 config.json 绝对路径——LLM 失败归因时给出 baseURL/apiKey 核对位置。 */
  configPath?: string;
}): string {
  const parts: string[] = [];
  if (opts.parseReason !== undefined) {
    parts.push(`解析失败：${opts.parseReason}。`);
  }
  parts.push(`exit code: ${opts.exitCode ?? "null（被信号杀死）"}。`);
  if (opts.stderrTail !== undefined && opts.stderrTail.trim() !== "") {
    const compacted = compactStderrObjectNoise(opts.stderrTail);
    parts.push(`stderr 尾部: ${compacted.slice(-STDERR_TAIL_IN_MSG_CHARS)}`);
  }
  // stdout 空段跳过（与 stderr 同判）——turn 0 即失败时 stdout 恒空，保留空 part
  // 只会制造「stdout 尾部: <指引段>」的视觉嵌套误读（2026-08-25 真机复盘）
  if (opts.stdoutTail.trim() !== "") {
    parts.push(`stdout 尾部: ${opts.stdoutTail.slice(-ZCODE_ERROR_TAIL_CHARS)}`);
  }

  const isLlmApiFailure =
    opts.stderrTail !== undefined && opts.stderrTail.includes(LLM_API_FAILURE_SIGNATURE);
  if (isLlmApiFailure) {
    const modelHint =
      opts.modelRef !== undefined ? `（本任务模型 '${opts.modelRef}'）` : "";
    const configHint =
      opts.configPath !== undefined
        ? `① 核对池内 provider 的 baseURL 可达性与 apiKey 有效性（\`${opts.configPath}\`）；`
        : "① 核对 zcode 池内 provider 的 baseURL 可达性与 apiKey 有效性；";
    parts.push(
      `恢复指引：LLM API 调用失败（${LLM_API_FAILURE_SIGNATURE}）——CLI 本体与输出解析正常，问题在模型端点或凭据${modelHint}。` +
        configHint +
        "② 修复后直接重跑本任务（probe 缓存不受影响——运行期失败不缓存）；" +
        "③ 或任务显式指定其他可用模型（provider/model 全名）；" +
        "④ 或改用 engine: pi 重跑本任务。",
    );
  } else {
    parts.push(
      `恢复指引：跑 \`node ${opts.cliPath} --version\` 确认版本后重跑探针（probe）——` +
        "若为格式漂移，把新 stdout 样本补录进 golden 库（\`__tests__/__fixtures__/zcode-golden-spawn.json\`）并更新 parser；" +
        "或改用 engine: pi 重跑本任务。详见 docs/research/agent-engine-zcode.md。",
    );
  }
  return `engine_run_failed: zcode CLI 运行失败。${parts.join(" ")}`;
}
