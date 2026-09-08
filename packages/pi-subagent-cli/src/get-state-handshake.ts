// src/get-state-handshake.ts
//
// FR-4: get_state RPC 握手逻辑（W7 迁 pi 包，core engines/pi/get-state-handshake.ts
// 逐字等价副本——仅依赖 stdin-writer）。
//
// 通过 get_state RPC 查询子进程 sessionFile/sessionId，带超时重试。
//   - 重试节奏：单次超时 GET_STATE_TIMEOUT_MS（2s）后，等 GET_STATE_RETRY_INTERVAL_MS
//     （500ms）再发起下一次 get_state，最多 GET_STATE_MAX_RETRIES（3）次。
//   - 加速路径：sessionFile 一旦拿到立即 resolve（不等剩余重试）。
//   - 全部超时：resolve 空对象（调用方走兜底查找）。

import type { ChildProcess } from "node:child_process";

import { sendGetStateCommand } from "./stdin-writer.ts";

/** FR-4: get_state RPC 握手最大重试次数。 */
const GET_STATE_MAX_RETRIES = 3;
/** FR-4: get_state RPC 握手重试间隔（ms）。 */
const GET_STATE_RETRY_INTERVAL_MS = 500;
/** FR-4: get_state RPC 握手单次超时（ms）。 */
const GET_STATE_TIMEOUT_MS = 2000;

/** get_state 握手结果。 */
export interface GetStateResult {
  sessionFile?: string;
  sessionId?: string;
}

/** get_state response 监听器注册函数形态（stdout pump / 测试注入）。 */
export type AddGetStateResponseListener = (
  id: string,
  resolver: (data: unknown) => void,
) => void | (() => void);

/** 从 get_state response data 提取 sessionFile/sessionId（提取规则单一来源）。 */
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
 * 最多重试 GET_STATE_MAX_RETRIES 次，单次超时 GET_STATE_TIMEOUT_MS 后等待
 * GET_STATE_RETRY_INTERVAL_MS 再发起下一次重试。
 */
export function performGetStateHandshake(
  child: ChildProcess,
  addResponseListener: AddGetStateResponseListener,
): Promise<GetStateResult> {
  return new Promise<GetStateResult>((resolve) => {
    const collected: GetStateResult = {};
    let attempts = 0;
    let resolved = false;

    function tryOnce(): void {
      if (resolved) return;
      attempts++;
      const reqId = sendGetStateCommand(child);

      // [#15] 本次 tryOnce 私有的 timer（2s 超时 + 超时后派生的 retry）。
      let pendingRetry: ReturnType<typeof setTimeout> | undefined;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        pendingRetry = undefined;
        if (attempts < GET_STATE_MAX_RETRIES && !resolved) {
          pendingRetry = setTimeout(() => tryOnce(), GET_STATE_RETRY_INTERVAL_MS);
          pendingRetry.unref();
        } else if (!resolved) {
          resolved = true;
          resolve(collected);
        }
      }, GET_STATE_TIMEOUT_MS);
      timer.unref();

      addResponseListener(reqId, (data: unknown) => {
        if (resolved) return;
        clearTimeout(timer);
        if (pendingRetry) clearTimeout(pendingRetry);
        extractGetStateFields(data, collected);
        if (collected.sessionFile) {
          resolved = true;
          resolve(collected);
        }
      });
    }

    tryOnce();
  });
}

/**
 * [T1/RC-1] 单次 get_state 请求（agent_end 决策点惰性回补专用）。
 *
 * 不做重试循环、不 share 握手语义：调用方在子进程 idle 时现场补一次查询，
 * 超时/失败即放弃，由调用方走既有保守分支。永不 reject——stdin 已断的同步写
 * 失败按「回补失败」处理 resolve 空对象。
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
      resolve({});
      return;
    }
    removeListener =
      addResponseListener(reqId, (data: unknown) => {
        const r: GetStateResult = {};
        extractGetStateFields(data, r);
        finish(r);
      }) ?? (() => {});
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish({}), timeoutMs);
    timer.unref();
  });
}
