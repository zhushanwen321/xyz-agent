// src/execution/engine/engines/pi/get-state-handshake.ts
//
// FR-4: get_state RPC 握手逻辑。
//
// 从 session-runner.ts 提取（保持文件 < 1000 行）。职责单一：通过 get_state RPC
// 查询子进程 sessionFile/sessionId，带超时重试。session-runner spawn 后无条件调用。
//
// 设计要点：
//   - 重试节奏（D4 参数面 GetStateHandshakeTiming，缺省 DEFAULT_GET_STATE_HANDSHAKE_TIMING
//     = 现状值）：单次超时 timeoutMs（2s）后，等 retryIntervalMs（500ms）再发起下一次
//     get_state，最多 maxAttempts（3）次。修复点：旧实现超时后立即递归 tryOnce()，
//     重试间隔常量声明了却从未使用（eslint error 阻断），现在让常量名与行为一致——
//     重试前真的等间隔。
//   - 加速路径：sessionFile 一旦拿到立即 resolve（不等剩余重试）。
//   - 全部超时：resolve 空对象（调用方走兜底查找）。

import type { ChildProcess } from "node:child_process";

import { sendGetStateCommand } from "./stdin-writer.ts";

/** get_state 握手节奏（D4 参数面：超时预算与重试节奏显式参数化，两侧各持现值=行为不变）。 */
export interface GetStateHandshakeTiming {
  /** 单次请求超时（ms）。 */
  timeoutMs: number;
  /** 重试间隔（ms）——单次超时后等待此间隔再发起下一次重试。 */
  retryIntervalMs: number;
  /** 最大尝试次数。 */
  maxAttempts: number;
}

/**
 * 默认握手节奏 = subagent-core 现状值（FR-4）：3 次尝试 × 2s 超时 + 0.5s 间隔，
 * 总预算 ≈ 7s。u5 Runtime 注入自己的现值（sendCommand per-request timeout 语义），
 * 不做统一取值（统一取值是行为变更，超出设计范围）。
 */
export const DEFAULT_GET_STATE_HANDSHAKE_TIMING: GetStateHandshakeTiming = {
  timeoutMs: 2_000,
  retryIntervalMs: 500,
  maxAttempts: 3,
};

/** get_state 握手结果。 */
export interface GetStateResult {
  sessionFile?: string;
  sessionId?: string;
}

/**
 * get_state response 监听器注册函数形态（stdout pump / 测试注入）。
 *
 * 返回值：注销函数（从监听表移除该 resolver），可省略——performGetStateHandshake
 * 忽略返回值（resolver 条目由 close 统一清；[U1 D1] 后迟到 response 经 onLateResponse
 * 通知调用方，不再靠 resolved 标志自弃）；requestGetStateOnce 消费返回值做单次请求的
 * 自清理（不依赖 close 兜底）。
 */
export type AddGetStateResponseListener = (
  id: string,
  resolver: (data: unknown) => void,
) => void | (() => void);

/** 从 get_state response data 提取 sessionFile/sessionId（提取规则单一来源，握手与惰性重试共用）。 */
function extractGetStateFields(data: unknown, into: GetStateResult): void {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.sessionFile === "string" && d.sessionFile.length > 0) {
      into.sessionFile = d.sessionFile;
    }
    if (typeof d.sessionId === "string" && d.sessionId.length > 0) {
      into.sessionId = d.sessionId;
    }
  }
}

/**
 * FR-4: 通过 get_state RPC 查询子进程获取 sessionFile/sessionId。
 *
 * 当 stdout header 未获取到 sessionFile 时，尝试通过 get_state RPC 查询。
 * 按 timing 节奏重试（缺省 3 次尝试、单次超时 2s、重试间隔 500ms）。
 *
 * [U1 D1] 迟到接受（幂等 late-binding，设计 docs/design/subagent-agent-end-recovery.md
 * §3.3 D1）：握手 resolve 后到达的 response 不再被 `if (resolved) return` 静默丢弃——
 * pi 侧 stdin reader 在全部初始化完成后才挂载，窗口内的命令在管道缓冲排队**不丢失**，
 * pi 就绪后必答；三次超时只是 host 侧放弃等待，应答仍必然会到。迟到应答经
 * onLateResponse 通知调用方做幂等回填（record.sessionFile 缺失则补、sessionId 补入
 * handshakeResult），把「握手窗口被慢冷启动拖过 → sessionFile 永久缺失」从正常路径上
 * 消灭。close 时 clearGetStateListeners 统一清理的既有语义不变——close 后 response
 * 到不了 resolver，迟到回调自然不触发。
 *
 * @param child 子进程（stdin 写入 get_state 命令）
 * @param addResponseListener 注册 response 监听器的函数（stdout pump 中调用）
 * @param onLateResponse 迟到接受回调（可选）：resolve 后到达且含可提取字段的 response
 *   经此通知；字段缺失/畸形时提取不到就跳过、不回调（错误规格：不留痕噪音）。
 *   省略时保持旧两参形态（迟到 response 丢弃，行为与 D1 前一致——既有调用方兼容）。
 * @param timing 握手节奏（可选，D4 参数面）：缺省 = DEFAULT_GET_STATE_HANDSHAKE_TIMING
 *   （现状值，行为不变）。
 * @returns 握手结果（可能为空——所有重试均超时/失败）
 */
export function performGetStateHandshake(
  child: ChildProcess,
  addResponseListener: AddGetStateResponseListener,
  onLateResponse?: (r: GetStateResult) => void,
  timing: GetStateHandshakeTiming = DEFAULT_GET_STATE_HANDSHAKE_TIMING,
): Promise<GetStateResult> {
  const { timeoutMs, retryIntervalMs, maxAttempts } = timing;
  return new Promise<GetStateResult>((resolve) => {
    const collected: GetStateResult = {};
    let attempts = 0;
    let resolved = false;

    function tryOnce(): void {
      if (resolved) return;
      attempts++;
      const reqId = sendGetStateCommand(child);

      // [#15] 本次 tryOnce 私有的 timer（2s 超时 + 超时后派生的 retry）。
      // 关键：response 回调通过闭包引用的是"本次 tryOnce 对应的 timer"，而非某个
      // 外层共享变量——即便后续 tryOnce(#2) 重新发起请求，旧 reqId 的迟到 response 回调
      // 闭包仍指向它自己那次 tryOnce 的 timer，不会误清新 reqId 的 timer。retry 句柄也
      // 一并捕获，response 到达时同步取消"已在排队但尚未触发的下一次重试"。
      let pendingRetry: ReturnType<typeof setTimeout> | undefined;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        pendingRetry = undefined;
        // 单次超时：等待间隔后重试，或放弃
        if (attempts < maxAttempts && !resolved) {
          // [Bug fix] 旧实现直接 tryOnce() 立即重试，GET_STATE_RETRY_INTERVAL_MS 声明却
          // 从未使用（eslint error 阻断 commit）。现在重试前等待间隔，让常量名与行为一致。
          pendingRetry = setTimeout(() => tryOnce(), retryIntervalMs);
          pendingRetry.unref();
        } else if (!resolved) {
          resolved = true;
          resolve(collected);
        }
      }, timeoutMs);
      timer.unref();

      addResponseListener(reqId, (data: unknown) => {
        if (resolved) {
          // [U1 D1] 迟到接受：握手已 resolve（提前拿到 sessionFile 或全部重试超时）后
          // 到达的 response 不再丢弃——提取字段经 onLateResponse 通知调用方幂等回填。
          // 提取不到字段（畸形/缺字段）就跳过，不回调（错误规格 §3.5 D1 行：不留痕噪音）。
          // resolved 后 resolver 条目仍留在监听表（由 close 统一清），close 后 response
          // 匹配不到 resolver，本路径自然不再触发。
          const late: GetStateResult = {};
          extractGetStateFields(data, late);
          if (late.sessionFile !== undefined || late.sessionId !== undefined) {
            onLateResponse?.(late);
          }
          return;
        }
        // [#15] 闭包清理本次 tryOnce 的 timer（2s 超时 + 排队中的 retry），不碰其他 reqId 的 timer。
        clearTimeout(timer);
        if (pendingRetry) clearTimeout(pendingRetry);
        extractGetStateFields(data, collected);
        // sessionFile 已获取——立即 resolve（无需更多重试）
        if (collected.sessionFile) {
          resolved = true;
          resolve(collected);
        }
        // 否则等待超时重试
      });
    }

    tryOnce();
  });
}

/**
 * [T1/RC-1] 单次 get_state 请求（agent_end 决策点惰性回补专用）。
 *
 * 与 performGetStateHandshake 的关系：复用同一消息构造（sendGetStateCommand）与同一
 * 字段提取（extractGetStateFields），但**不做重试循环、不 share 握手语义**——调用方
 * （session-runner agent_end 处置）在子进程 idle 时现场补一次查询（探针 P-T1 实证
 * 应答 0.3-0.4ms），超时/失败即放弃，由调用方走既有保守分支（行为不劣化）。
 *
 * 结果契约与 performGetStateHandshake 一致：resolve GetStateResult（可能为空对象），
 * 永不 reject——stdin 已断（EPIPE/ERR_STREAM_DESTROYED）的同步写失败按「回补失败」
 * 处理 resolve 空对象，调用方无需 try/catch。
 *
 * 自清理：超时或 response 到达后从监听表移除本请求的 resolver（消费注册器的返回值），
 * 不留迟到条目；注册器不返回注销函数时退化为 no-op（与握手同形态，靠 close 统一清）。
 *
 * @param child 子进程（stdin 写入 get_state 命令）
 * @param addResponseListener 注册 response 监听器的函数（stdout pump 中调用）
 * @param timeoutMs 单次超时（决策点预算 1s 量级；P-T1 实测 idle 应答亚毫秒）
 */
export function requestGetStateOnce(
  child: ChildProcess,
  addResponseListener: AddGetStateResponseListener,
  timeoutMs: number,
): Promise<GetStateResult> {
  return new Promise<GetStateResult>((resolve) => {
    let settled = false;
    let removeListener: () => void = () => {};

    const finish = (r: GetStateResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListener();
      resolve(r);
    };

    let reqId: string;
    try {
      reqId = sendGetStateCommand(child);
    } catch {
      // stdin 已断等同步写失败 = 回补失败，空结果走调用方保守分支（同超时语义）
      resolve({});
      return;
    }
    removeListener =
      addResponseListener(reqId, (data: unknown) => {
        const r: GetStateResult = {};
        extractGetStateFields(data, r);
        // response 已到达：无论是否含目标字段都不再等（单次语义，无重试）
        finish(r);
      }) ?? (() => {});
    // [#15] 同款时序模式：timer 在 resolver 注册后创建，resolver/finish 闭包引用它——
    // 两者都只在 timer 初始化之后才可能被调用（response 到达是异步事件）。
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish({}), timeoutMs);
    timer.unref();
  });
}
