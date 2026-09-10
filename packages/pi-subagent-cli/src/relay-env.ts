// src/relay-env.ts
//
// subagent relay 通道 env 名与协议常量的 re-export shim——单源在
// @zhushanwen/subagent-engine-sdk（round1-reuse R9 跨进程契约副本收编；引擎 CLI
// → SDK 边界正向合法）。原自持副本（core src/execution/relay-env.ts 逐字等价，
// W7 迁移处置）已删除；relay 转发语义照 W8/H12：SOCKET/NODE/SCRIPT 三键原样转发，
// SESSION_ID/RECORD_ID 由引擎按 run.params.ctx 重写（spawn-runner 落点），不靠 env 继承。

export {
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
  RELAY_PROTOCOL_VERSION,
  RELAY_EXIT_CODES,
  isRelayActive,
} from "@zhushanwen/subagent-engine-sdk";
