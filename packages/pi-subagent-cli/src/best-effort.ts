// src/best-effort.ts
//
// bestEffort 的引擎包自持副本（core src/execution/best-effort.ts 逐字等价——
// 引擎包禁止 import core；W7 迁移处置见 impl-plan §2.7，temp-prompt 清理消费）。
// 日志面改走 SDK logger facade（经 host/log 反向通道上报 + stderr 兜底）。

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("subagents");

/** 错误日志级别。debug = 次要清理（默认）；error = 关键步骤但需继续后续清理。 */
export type BestEffortLevel = "debug" | "error";

/** 吞咽 best-effort IO 的错误，按 level 经共享 logger 记录。 */
export function bestEffort(err: unknown, context: string, level: BestEffortLevel = "debug"): void {
  const detail = err instanceof Error ? err.message : err;
  const msg = `[subagents] best-effort ${context} failed`;
  if (level === "error") {
    logger.error(msg, { detail });
  } else {
    logger.debug(msg, { detail });
  }
}
