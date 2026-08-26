// execution/engine/degradation/kill-chain.ts
//
// 公共降级层 ②：abort 两级中断与超时杀链（D1 abort 分级）。
// 两级：①引擎原生优雅中断（capabilities.interrupt === "native" 时先试）
//      ②公共杀链兜底（EngineProcess.abort：SIGTERM → grace → SIGKILL）。
// CLI-only 引擎（zcode，interrupt === "kill-only"）直接走②。
// 杀死进程后由宿主合成终态（exitCode=null + error 含杀链标记），record 不留僵尸。

import type { AgentOutcome, EngineProcess } from "../types.ts";

/** 杀链结果（宿主合成终态的输入）。 */
export interface KillChainResult {
  exitCode: number | null;
  signal?: string;
  /** true = 走完 SIGKILL（强杀）——终态 error 必须含杀链标记。 */
  forceKilled: boolean;
}

/**
 * abort 两级中断编排（D1）。
 * 接线：tryNative 存在（native interrupt 引擎注入）先调——成功即返回；
 * 否则（或原生失败）调 proc.abort(graceMs)（EngineProcess 杀链执行体）。
 */
export async function abortWithChain(opts: {
  proc: EngineProcess;
  graceMs: number;
  /** 引擎原生优雅中断（pi steer-abort / CC interrupt）；kill-only 引擎不传。 */
  tryNative?: () => Promise<boolean>;
}): Promise<KillChainResult> {
  if (opts.tryNative) {
    const graceful = await opts.tryNative();
    if (graceful) {
      const exited = await opts.proc.exited;
      return { exitCode: exited.code, signal: exited.signal, forceKilled: false };
    }
  }
  await opts.proc.abort(opts.graceMs);
  const exited = await opts.proc.exited;
  return { exitCode: exited.code, signal: exited.signal, forceKilled: true };
}

/**
 * 超时杀链走完 → engine_timeout 终态合成（错误含 stdout 尾部 2000 字 +
 * 「可用 engine: pi 重跑」建议，§3.3.3）。
 */
export function synthesizeTimeoutOutcome(args: {
  engineId: string;
  stdoutTail: string;
  durationMs: number;
}): AgentOutcome {
  void args;
  // 终态合成 = 错误文案组装（叶子逻辑；字段形状以 §3.3.3 engine_timeout 行为准）。
  throw new Error("skeleton: engine_timeout terminal synthesis");
}

/** 被信号杀死的终态判据：exitCode=null + error 含杀链标记（D1；可区分自然退出与被杀）。 */
export function isKilledOutcome(outcome: AgentOutcome): boolean {
  return outcome.exitCode === null;
}

/**
 * abort/杀链完成后的宿主合成终态（record 必须收尾，无僵尸进程；A10）。
 * exitCode=null + error 含杀链标记。
 */
export function synthesizeAbortedOutcome(args: {
  engineId: string;
  kill: KillChainResult;
  durationMs: number;
}): AgentOutcome {
  void args;
  throw new Error("skeleton: aborted terminal synthesis");
}
