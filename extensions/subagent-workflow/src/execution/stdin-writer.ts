// src/execution/stdin-writer.ts
//
// 向 rpc 子进程 stdin 写入命令的 helper 集合。
//
// pi --mode rpc 通过 stdin 的 JSON RpcCommand / RpcExtensionUIResponse 驱动：
//   - extension_ui_response（主进程回答子进程的 UI 请求，如 ask_user）
//   - prompt（驱动子进程开始处理 task）
// 两者共用 child.stdin.write + 背压检查，提取到此模块统一维护。

import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { UiResponse } from "./dialog-queue.ts";

const logger = getLogger("subagents");

/**
 * 按 UiResponse 形状构造 Pi 原生 extension_ui_response 并写 stdin。
 *
 * SR-5：ack（fire-and-forget）不写 stdin——Pi 对 fire-and-forget method 不期待响应，
 * 写入会触发协议错配。其他三种 shape（value/confirmed/cancelled）按对应字段写。
 *
 * [R1] 背压检查：child.stdin.write 返回 false 时记 warn（不阻塞，内核缓冲会随后排空）。
 * [R2] 序列化在本函数内逐分支完成。JSON.stringify 可能抛错（out.value 含循环引用 /
 *     BigInt 等不可序列化结构），try/catch 降级为 cancelled——宁可取消单次 dialog 也不让
 *     父进程崩溃（UI 请求通道不应被脏数据拖垮）。
 *
 * @param child 子进程（stdin 写入响应）
 * @param id 请求 id（关联 response）
 * @param out UiResponse（{value}/{confirmed}/{cancelled}/{ack}）
 * @param signal abort signal（已 aborted 时跳过写入）
 */
export function respond(child: ChildProcess, id: string, out: UiResponse, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  let line: string | undefined;
  try {
    if ("value" in out) line = JSON.stringify({ type: "extension_ui_response", id, value: out.value });
    else if ("confirmed" in out) line = JSON.stringify({ type: "extension_ui_response", id, confirmed: out.confirmed });
    else if ("cancelled" in out) line = JSON.stringify({ type: "extension_ui_response", id, cancelled: true });
  } catch (err) {
    // [R2] out.value 含循环引用/BigInt 等不可序列化结构——降级 cancelled，避免父进程崩溃。
    logger.warn(`[subagents] JSON.stringify failed for ui response ${id}, degrading to cancelled`, {
      detail: err instanceof Error ? err.message : String(err),
    });
    line = JSON.stringify({ type: "extension_ui_response", id, cancelled: true });
  }
  // ack: fire-and-forget，不写 stdin（SR-5）
  if (line === undefined) return;
  writeStdinLine(child, line, `ui response for request ${id}`);
}

/**
 * spawn 后向 rpc 子进程 stdin 写 prompt 命令，驱动 agent 开始处理 task。
 *
 * pi 的 runRpcMode 只通过 stdin RpcCommand 驱动——positional task arg / -p flag
 * 在 rpc mode 下被 resolveAppMode 无视。必须在 spawn 后主动喂 prompt 命令，
 * 否则子进程阻塞等 stdin、永不进入推理（totalTokens 恒 0）。
 *
 * 时机：spawn 后立即写。stdin 是 pipe，内核缓冲保证数据不丢；
 * pi 在 await rebindSession() 后才挂 stdin reader（rpc-mode.ts:778-781），
 * reader 处理 prompt 时 session 已就绪。
 *
 * [V2 决策 3] chatMode 续聊热路径用 prompt + streamingBehavior 统一投递（替代 steer/followUp
 * 命令），pi 权威裁决 busy/idle（设计 F3/F4）：busy 时 followUp 入队/steer 抢占；idle 时
 * streamingBehavior 被忽略、直接开新 turn。不传 streamingBehavior（首帧 prompt / 旧调用方）
 * 行为完全不变——向后兼容。
 *
 * @param child 子进程（stdin 写入 prompt 命令）
 * @param task 完整 task 文本（含 schema 指令）
 * @param options.streamingBehavior V2 统一投递语义：`"followUp"`（排队，当前轮后处理）/ `"steer"`（抢占，立即中断 streaming）。
 *        省略时不写入该字段（首帧 prompt / 非 chatMode 调用方，行为不变）。
 */
export function sendPromptCommand(
  child: ChildProcess,
  task: string,
  options?: { streamingBehavior?: "followUp" | "steer" },
): void {
  if (!child.stdin || child.stdin.destroyed) return;
  const payload: Record<string, unknown> = {
    id: crypto.randomUUID(),
    type: "prompt",
    message: task,
  };
  if (options?.streamingBehavior) {
    payload.streamingBehavior = options.streamingBehavior;
  }
  writeStdinLine(child, JSON.stringify(payload), "prompt command");
}

/**
 * 向 busy 子进程 stdin 写 follow_up 命令——消息排队，当前轮完成后按序处理（设计决策 6）。
 *
 * pi rpc-mode：`{id, type:"follow_up", message}` → session.followUp（排队，不抢占）。
 * 语义：subagent 正在运行（busy）时投递「不打断」消息——当前 turn 跑完后，pi 自动 drain
 * 排队消息开新一轮（探针 P-4）。agent_end 后 follow_up 不触发新 run（探针 P-3），
 * 故 idle 态必须用 prompt（见 resumeRound），不能用 follow_up。
 *
 * 时机：busy 投递。child.stdin 必须存活（进程未退出）；已关闭/销毁时静默跳过（与 sendPromptCommand 同 guard）。
 *
 * @param child 子进程（busy，stdin 存活）
 * @param message 消息文本
 */
export function sendFollowUpCommand(child: ChildProcess, message: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  const command = JSON.stringify({
    id: crypto.randomUUID(),
    type: "follow_up",
    message,
  });
  writeStdinLine(child, command, "follow_up command");
}

/**
 * 向 busy 子进程 stdin 写 steer 命令——消息抢占，立即中断当前 streaming（设计决策 6）。
 *
 * pi rpc-mode：`{id, type:"steer", message}` → session.steer（抢占，streaming 中立即生效）。
 * 语义：subagent 正在运行（busy）时投递「立即打断」消息——pi 抢占当前 turn 的 streaming，
 * steer 消息作为新输入立即处理。与 follow_up 的区别：steer 不等当前轮完成，立即生效。
 *
 * 时机：busy 投递。child.stdin 必须存活（进程未退出）；已关闭/销毁时静默跳过（与 sendPromptCommand 同 guard）。
 *
 * @param child 子进程（busy，stdin 存活）
 * @param message 消息文本
 */
export function sendSteerCommand(child: ChildProcess, message: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  const command = JSON.stringify({
    id: crypto.randomUUID(),
    type: "steer",
    message,
  });
  writeStdinLine(child, command, "steer command");
}

/**
 * 向 rpc 子进程 stdin 写 get_state 命令，查询 sessionFile/sessionId。
 *
 * FR-4: RPC get_state 握手。当 stdout header 未携带 sessionFile 时，
 * 通过此命令向子进程查询当前 session 状态。子进程收到后返回
 * {type:"response", command:"get_state", success:true, data:{sessionFile, sessionId}}。
 *
 * @param child 子进程（stdin 写入 get_state 命令）
 * @returns 请求 id（用于匹配 response）
 */
export function sendGetStateCommand(child: ChildProcess): string {
  const id = crypto.randomUUID();
  const command = JSON.stringify({
    id,
    type: "get_state",
  });
  writeStdinLine(child, command, "get_state command");
  return id;
}

/**
 * 向子进程 stdin 写一行（自动补换行），带背压检查 + EPIPE 检测。
 *
 * [R1] write 返回 false 时记 warn（不阻塞，内核缓冲会随后排空）。
 * [R3] write 抛 EPIPE / ERR_STREAM_DESTROYED 时 throw 含 EPIPE 关键词的 Error，
 *      让上层（deliverMessage）能捕获并自动转冷路径 resume。
 * stdin 已关闭/销毁时跳过——respond 已检查 signal，sendPromptCommand 已检查 destroyed。
 *
 * @param child 子进程
 * @param line JSON 行（不含换行）
 * @param warnTag warn 日志的语义标记
 * @throws Error 含 "EPIPE" 关键词——stdin 管道已断（子进程已退出 / stdin 被销毁）
 */
function writeStdinLine(child: ChildProcess, line: string, warnTag: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  try {
    const ok = child.stdin.write(line + "\n");
    if (!ok) logger.warn(`[subagents] stdin backpressure on ${warnTag}`);
  } catch (err) {
    // [R3] EPIPE / ERR_STREAM_DESTROYED：stdin 管道已断，子进程已退出或 stdin 被销毁。
    // throw 让上层（deliverMessage）捕获并自动转冷路径 resume + 消息重放。
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      ((err as NodeJS.ErrnoException).code === "EPIPE" ||
        (err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED")
    ) {
      throw new Error(
        `[subagents] EPIPE on stdin write (${warnTag}): pipe broken, child process likely exited. ` +
          `Recovery: treat as dead process and resume via cold path.`,
      );
    }
    // 非 EPIPE 错误（不应发生，但兜底降级为 warn 不崩溃）
    logger.warn(`[subagents] unexpected stdin write error on ${warnTag}`, {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
