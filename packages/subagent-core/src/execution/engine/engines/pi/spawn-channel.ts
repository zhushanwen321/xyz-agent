// src/execution/engine/engines/pi/spawn-channel.ts
//
// pi 通道原语单一实现（D4 归一，设计 docs/design/subagent-agent-end-recovery.md §2.3/§3.3 D4，
// 实施计划 u4-spawn-channel）。本模块是 subagent-core 侧全部「与 pi 子进程通信」原语的
// 唯一消费入口；u5（Runtime 切换）后 runtime rpc-client 经受控子入口消费同一份机制，
// 消除「同类修复只落一边」的双轨分叉。
//
// 七件原语与归宿（机制一份，策略各持——差异清单三类见 §3.3 D4）：
//   1. invocation 组装      → re-export pi-invocation.ts getPiInvocation（本已是单一叶子原语）
//   2. LF 行读取            → createLineReader（本文件，吸收 session-runner 手写 buffer split）
//   3. stdin 命令写入+EPIPE → re-export stdin-writer.ts 全部（单一实现留驻原文件——
//                             subagent-service / pi-engine / ui-request-queue 等域内消费者
//                             与既有测试 vi.mock 锚定该路径，物理搬迁属无收益破坏面）
//   4. response id 路由     → createGetStateResponseRouter（本文件，吸收 stdout pump 内联 Map）
//   5. 迟到帧策略位         → SpawnChannelPolicies 维度 1/2（两个机制点：事件帧空窗 / 迟到 response）
//   6. kill 升级链          → re-export common/kill-chain.ts（D3-① 已是 subagent-core 内部单一实现）
//   7. get_state 客户端     → re-export get-state-handshake.ts（单一实现留驻原文件，理由同 3）
//
// CJS bundle 兼容：本模块不使用 import.meta.url / globalThis.__dirname（runtime 打包约束）。

import type { GetStateResult } from "./get-state-handshake.ts";

// ============================================================
// 原语 6：kill 升级链——pi 侧参数面（策略维度 4 的共享默认）
// ============================================================

// 毫秒→秒换算。文件内私有定义：MS_PER_SECOND 惯例是各使用文件私有常量
//（common/kill-chain.ts 同款注释先例），无共享导出源可 import。
const MS_PER_SECOND = 1_000;

/**
 * [D3-①/race-F4] pi 侧 kill 升级链的 SIGTERM 优雅窗口（ms）：30s 超窗未见 exit 视为
 * SIGTERM 被无视，升级 SIGKILL。原 session-runner 私有常量迁入（参数面显式化）：
 * kill 策略维度 4 共享默认（escalating-sigterm）的 pi 现值，u5 Runtime 注入
 * immediate-sigkill 时的 diff 对照基准。
 */
const PI_KILL_GRACE_SECS = 30;
export const PI_KILL_GRACE_MS = PI_KILL_GRACE_SECS * MS_PER_SECOND;

// ============================================================
// 语义分叉：四维策略注入接口（D4 差异清单第一类）
// ============================================================

/**
 * 维度 1：事件帧空窗策略——spawn → 事件分发就绪之间的非 response 帧处置。
 *
 * - subagent-core 绑定 `pass-through`（现状：stdout pump 在 spawn 后同步挂载，机制上
 *   不存在空窗，「直通」= 行读取到分派之间零中间缓冲层，无需代码位）。
 * - Runtime（u5 注入）`buffer-until-first-listener`：rpc-client 首个 listener 注册前
 *   非 response 帧入 FIFO（EARLY_FRAME_BUFFER_MAX 封顶）、注册时重放——接线位 =
 *   {@link createLineReader} 的 `onLine` 消费方（Runtime 在自己的 onLine 内实现缓冲重放）。
 */
export type EventFrameGapPolicy =
  | { kind: "pass-through" }
  | { kind: "buffer-until-first-listener"; maxFrames: number };

/**
 * 维度 2：迟到 response 处置策略（机制点：get_state 应答晚于 host 放弃等待）。
 *
 * 函数注入位 = performGetStateHandshake 的 `onLateResponse` 参数（下方 re-export）。
 * - subagent-core 绑定幂等回填（D1 迟到接受）：session-runner 的
 *   backfillSessionFileFromLateGetState（`!record.sessionFile` 守卫 + sessionId 补入）。
 * - Runtime（u5 注入）绑定丢弃（timedOutIds 语义，不当 event 广播）——不注册回调即丢弃。
 *
 * 注意：两侧**现状**对迟到 response 同为丢弃，D1 只翻转了 subagent-core 侧；Runtime 侧
 * 保持丢弃是 u5 行为不变替换的一部分（设计 §3.3 D4 维度 2）。
 */
export type LateResponsePolicy = (late: GetStateResult) => void;

/**
 * 维度 3：失败处理策略——通道级失败（EPIPE / 流断 / 行损坏 / 握手失败）的处置姿势。
 *
 * - subagent-core 绑定 `tolerant-degrade`（容错 + 决策点降级）：EPIPE 连续失败计数
 *   （下方 re-export 的 recordEpipeFailure 族——**本维度计数器的共享层归宿**，同步 write
 *   抛错与异步 stdin 'error' 两半面合并计数）、stdout invalid 行不中断流（计数 + 样本留痕）、
 *   握手失败交决策点降级路径（回补 / 扫描 / 翻转窗口）。
 * - Runtime（u5 注入）绑定 `hard-fail-safe-destroy`：超时/错误 → safeDestroy 硬失败 +
 *   会话重建（连接级语境：失败重来的代价低于带伤运行）。
 */
export type FailureHandlingPolicy =
  | { kind: "tolerant-degrade" }
  | { kind: "hard-fail-safe-destroy" };

/**
 * 维度 4：kill 语义策略。
 *
 * - 共享默认 `escalating-sigterm`：SIGTERM → graceMs → SIGKILL 升级链（killChain +
 *   {@link PI_KILL_GRACE_MS}）。subagent-core 现状 grace = 30s（race-F4 校准值）。
 * - Runtime（u5 注入）`immediate-sigkill`：stream error / timeout 加速死亡形态直接
 *   SIGKILL（rpc-client 现状）——合一时两侧 kill 语义均不回退。
 */
export type KillPolicy =
  | { mode: "escalating-sigterm"; graceMs: number }
  | { mode: "immediate-sigkill" };

/**
 * 四维策略注入接口（D4 语义分叉差异清单的契约面）。
 *
 * u5 Runtime 消费切换时按本接口逐维注入 Runtime 取值（行为不变替换，S8 逐项对照）；
 * subagent-core 侧默认实现不经本对象分派——各维默认绑定通过实际接线表达：
 * 维度 1 = attachStdoutPump 直通接线（无缓冲层即 pass-through 本体）；维度 2 =
 * performGetStateHandshake 的 onLateResponse 参数；维度 3 = EPIPE 计数函数族 + invalid 行
 * 容错；维度 4 = killChain + PI_KILL_GRACE_MS。本接口与 {@link SUBAGENT_CORE_SPAWN_POLICIES}
 * 是默认值的类型化登记（u5 对照基准），不是运行时分派点。
 */
export interface SpawnChannelPolicies {
  eventFrameGap: EventFrameGapPolicy;
  lateResponse: { kind: "idempotent-backfill" } | { kind: "discard" };
  failureHandling: FailureHandlingPolicy;
  kill: KillPolicy;
}

/**
 * subagent-core 侧四维默认取值登记（u5 Runtime 注入时的对照基准）。
 * 维度 2 的函数形态注入位见 {@link LateResponsePolicy}（onLateResponse 参数）。
 */
export const SUBAGENT_CORE_SPAWN_POLICIES: SpawnChannelPolicies = {
  eventFrameGap: { kind: "pass-through" },
  lateResponse: { kind: "idempotent-backfill" },
  failureHandling: { kind: "tolerant-degrade" },
  kill: { mode: "escalating-sigterm", graceMs: PI_KILL_GRACE_MS },
};

// ============================================================
// 原语 2：LF 行读取（单一实现）
// ============================================================

/**
 * stdout tee hook（D4 单侧附加面①的归宿）。
 *
 * Runtime 侧的 piSessionLog JSONL 落盘（「pi 卡死时唯一证据」通道）挂在本 hook 上：
 * 每一行完整行在解析/分发**之前**回调（行尾 '\r' 剥离后；含空行；含 flushTrailing 的
 * 尾残行），解析失败不影响 tee。subagent-core 现状无 tee——缺省（不传）即 no-op；
 * u5 Runtime 接回 piSessionLog 时注入本 hook。
 */
export type StdoutTeeHook = (line: string) => void;

/** createLineReader 可选项。 */
export interface LineReaderOptions {
  /** 完整行分派回调（每行含空行都会到达；行内容不含结尾 LF，行尾 '\r' 已剥离）。 */
  onLine: (line: string) => void;
  /**
   * 流结束（close）时的尾残行回调（无换行结尾的最后一段）。缺省 = 复用 onLine。
   * 消费方分派语义与常规行不同时传入（session-runner 的尾残行只分发 event/invalid）。
   * 仅当残行含非空白字符时触发（与既有 `stdoutBuffer.trim()` 门一致）；触发后缓冲清空。
   */
  onTrailingLine?: (line: string) => void;
  /** stdout tee hook（见 {@link StdoutTeeHook}）。缺省不传 = no-op（subagent-core 现状）。 */
  onStdoutLine?: StdoutTeeHook;
  /**
   * 未完整行缓冲的字符上限（D4 参数面）。缺省 undefined = 无上限（subagent-core 现状：
   * pi 单行事件远小于内存约束，不做截断）。超限时丢弃缓冲最旧前缀、保留尾部
   * （保最新语义）；Runtime（u5）可注入自己的上限现值。
   */
  maxBufferChars?: number;
}

/** LF/CRLF 行读取器：跨 chunk 缓冲 + 按 \n 切分 + 行尾 \r 剥离 + 尾残行冲刷。 */
export interface LineReader {
  /** 喂入 stdout chunk（编码已由调用方 setEncoding("utf8")）。 */
  push(chunk: string): void;
  /** 流结束时冲刷尾残行（语义见 LineReaderOptions.onTrailingLine）。幂等：缓冲空后 no-op。 */
  flushTrailing(): void;
}

/**
 * LF 行读取单一实现（原语 2）。
 *
 * 吸收 session-runner attachStdoutPump 的手写 `stdoutBuffer += data; split("\n"); pop()`
 * 循环——机制一份，两侧（subagent-core / u5 Runtime）共享。LF 形态下缺省参数与原手写
 * 实现逐字节等价；行尾 '\r' 剥离是有意的防御增强（一致性审查修复批补齐）：对齐 pi 实装
 * attachJsonlLineReader 与 runtime 旧 attachLfOnlyLineReader 的同款防御——pi stdout 消费
 * 原语两侧统一承载，消除「runtime 剥 / subagent-core 不剥」的残留分叉。
 */
export function createLineReader(options: LineReaderOptions): LineReader {
  const { onLine, onStdoutLine } = options;
  const trailing = options.onTrailingLine ?? onLine;
  const maxBufferChars = options.maxBufferChars;
  let buffer = "";

  const emit = (line: string, handler: (line: string) => void): void => {
    // 行尾 '\r' 剥离（CRLF 防御）：只在行完整确定后（emit 时）做——跨 chunk 的 "\r\n"
    //（\r 随上一 chunk 尾留缓冲、\n 在下一 chunk 头到达）拼接后完整行仍以 '\r' 结尾，
    // 此处统一剥离，无需缓冲级特判；行中间 '\r' 是合法 JSON 字符串内容，不剥。
    // 剥离先于 tee：Runtime piSessionLog 落盘字节与切换前（旧实现在 onLine 前剥离）一致。
    const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
    // tee 在解析/分发之前：诊断通道看到的行序与子进程写出顺序一致
    onStdoutLine?.(stripped);
    handler(stripped);
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      if (maxBufferChars !== undefined && buffer.length > maxBufferChars) {
        buffer = buffer.slice(buffer.length - maxBufferChars);
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 保留最后未完整行
      for (const line of lines) emit(line, onLine);
    },
    flushTrailing(): void {
      // 既有门语义：空白残行（含空串）不分发、直接丢弃
      if (buffer.trim().length === 0) {
        buffer = "";
        return;
      }
      const tail = buffer;
      buffer = "";
      emit(tail, trailing);
    },
  };
}

// ============================================================
// 原语 4：response id 路由（单一实现）
// ============================================================

/** get_state response resolver 形状（应答 data 原样交给注册方）。 */
export type GetStateResponseResolver = (data: unknown) => void;

/** response id → resolver 路由表（stdout pump 的分发表，原语 4 单一实现）。 */
export interface GetStateResponseRouter {
  /**
   * 注册 resolver，返回注销函数。注销按句守卫：同 id 已被新 resolver 覆盖时不误删
   * （理论不发生——reqId 是 UUID，守卫为防御性语义，与原内联实现逐字一致）。
   */
  register(id: string, resolver: GetStateResponseResolver): () => void;
  /**
   * 按 id 分发：命中则先移除再调用（单次消费语义——同 id 二次分发 no-op）并返回 true；
   * 未命中（含已被 clear / 从未注册）返回 false，由调用方决定迟到帧去向
   * （迟到帧策略位见 SpawnChannelPolicies.lateResponse 注释）。
   */
  dispatch(id: string, data: unknown): boolean;
  /** 清空全部 resolver（close 收尾统一清理）。 */
  clear(): void;
}

/**
 * response id → resolver 路由表单一实现（原语 4）。
 *
 * 吸收 session-runner attachStdoutPump 的内联 Map（register/dispatch-delete/clear），
 * 机制与 subagent-core 现状逐字等价；u5 Runtime 的 response 路由（timedOutIds 之外
 * 的正常分发表）消费同一份。
 */
export function createGetStateResponseRouter(): GetStateResponseRouter {
  const resolvers = new Map<string, GetStateResponseResolver>();
  return {
    register(id, resolver) {
      resolvers.set(id, resolver);
      return () => {
        if (resolvers.get(id) === resolver) resolvers.delete(id);
      };
    },
    dispatch(id, data) {
      const resolver = resolvers.get(id);
      if (resolver === undefined) return false;
      resolvers.delete(id);
      resolver(data);
      return true;
    },
    clear() {
      resolvers.clear();
    },
  };
}

// ============================================================
// 门面 re-export：七件原语的单一消费入口
// ============================================================

// 原语 1：invocation 组装（pi 二进制定位 + spawn 描述符）。session-runner 的
// buildSpawnArgs / buildChildEnv 是 subagent 身份域组装（identity env / tools / resume
// 等子进程专属语义，Runtime 主会话连接无此面），不经本门面——见单元 deviations。
export { getPiInvocation } from "./pi-invocation.ts";
export type { PiInvocation } from "./pi-invocation.ts";

// 原语 3：stdin 命令写入 + EPIPE 计数（失败处理策略维度 3 的计数器归宿——
// 同步 write 抛错与异步 stdin 'error' 两半面共用同一 Map 合并计数，防 spawn→EPIPE→resume 死循环）。
export {
  clearEpipeFailure,
  EPIPE_FAILURE_THRESHOLD,
  recordEpipeFailure,
  resetAllEpipeFailures,
  respond,
  sendGetStateCommand,
  sendPromptCommand,
} from "./stdin-writer.ts";

// 原语 5（机制点 2）/7：get_state 客户端（握手 + 单查 + 迟到接受回调位）与监听器注册形态。
// 迟到 response 处置的函数注入位 = performGetStateHandshake 的 onLateResponse。
export {
  DEFAULT_GET_STATE_HANDSHAKE_TIMING,
  performGetStateHandshake,
  requestGetStateOnce,
} from "./get-state-handshake.ts";
export type {
  AddGetStateResponseListener,
  GetStateHandshakeTiming,
  GetStateResult,
} from "./get-state-handshake.ts";

// 原语 6：kill 升级链（SIGTERM → graceMs → SIGKILL，D3-① 已合一的公共杀链）。
export { killChain } from "../../common/kill-chain.ts";
export type { KillableChild } from "../../common/kill-chain.ts";
