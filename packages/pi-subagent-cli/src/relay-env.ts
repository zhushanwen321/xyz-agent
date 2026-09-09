// src/relay-env.ts
//
// subagent relay 通道 env 名与协议常量的引擎包自持副本（core
// src/execution/relay-env.ts 逐字等价——引擎包禁止 import core；W7 迁移处置，
// relay 转发语义照 W8/H12：SOCKET/NODE/SCRIPT 三键原样转发，SESSION_ID/RECORD_ID
// 由引擎按 run.params.ctx 重写（spawn-runner 落点），不靠 env 继承）。

export const RELAY_ENV_SOCKET = "XYZ_SUBAGENT_RELAY_SOCKET";
export const RELAY_ENV_NODE = "XYZ_SUBAGENT_RELAY_NODE";
export const RELAY_ENV_SCRIPT = "XYZ_SUBAGENT_RELAY_SCRIPT";
export const RELAY_ENV_SESSION_ID = "XYZ_SUBAGENT_RELAY_SESSION_ID";
export const RELAY_ENV_RECORD_ID = "XYZ_SUBAGENT_RELAY_RECORD_ID";

/** relay 协议版本（握手帧 v 字段；runtime 与代理同包分发，不匹配=安装损坏）。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 代理专用退出码（引擎侧表现为「子进程非零退出」→ engine_run_failed 语义）。 */
export const RELAY_EXIT_CODES = {
  /** 握手被拒：协议版本不匹配（安装损坏，重装应用）。 */
  VERSION_MISMATCH: 10,
  /** relay socket 不可达（runtime 未运行或已重启）。 */
  SOCKET_UNREACHABLE: 11,
  /** socket 中途断开（runtime 崩溃等）——代理生命线断即退。 */
  SOCKET_CLOSED: 12,
  /** 归属 env（SESSION_ID/RECORD_ID）缺失——防无归属帧污染广播。 */
  MISSING_IDENTITY: 13,
} as const;

/** 激活判定：三 env 同时非空才走 relay，任一缺失回落直连 spawn 真实 pi。 */
export function isRelayActive(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return Boolean(env[RELAY_ENV_SOCKET] && env[RELAY_ENV_NODE] && env[RELAY_ENV_SCRIPT]);
}
