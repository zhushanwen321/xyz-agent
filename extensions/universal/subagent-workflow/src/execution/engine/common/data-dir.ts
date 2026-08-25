// src/execution/engine/common/data-dir.ts
//
// 引擎数据目录解析（P2）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D5/D6——engines 根锚定 getDataDir()
// 顶层（journal / 隔离池的父目录），extension 写侧与 runtime 校验侧同源推导。
//
// 通道调查结论（2026-08-25，P2 实测证据链）：
//   - runtime spawn pi 主会话时 RpcClient.buildSafeEnv 从 runtime process.env 继承
//     XYZ_ 前缀白名单变量（rpc-client.ts:14-30），且显式设置 PI_CODING_AGENT_DIR；
//   - dev 模式 Electron main 设置 XYZ_AGENT_DATA_DIR（apps/electron/main/main.ts:122），
//     经 process-control.ts:262 透传给 runtime → 透传链成立；
//   - prod 默认路径（~/.xyz-agent 缺省）下 runtime 进程 env 中**没有**该变量
//     （shared getDataDir 缺省时不写 env）→ 透传链断——已在 runtime 侧
//     process-manager.ts spawn env 补注入 XYZ_AGENT_DATA_DIR 修复（跨包改动）。
//
// 回退语义：缺 env 时回退 piAgentDir（getAgentDir()——尊重 PI_CODING_AGENT_DIR，
// 独立 pi 用户直跑 extension 的场景）并 warn 一次——不留静默漂移（journal 落点变化
// 必须可观测）。

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** xyz-agent 数据目录 env 名（与 packages/shared/src/paths.ts 的 SSOT 变量同名）。 */
export const XYZ_DATA_DIR_ENV = "XYZ_AGENT_DATA_DIR";

/** 测试隔离专用：重置 warn-once 标记（生产禁用）。 */
let warned = false;
export function resetDataDirWarnForTests(): void {
  warned = false;
}

/**
 * 解析引擎数据目录（journal 落盘 / 隔离池的根）：
 *   1. process.env.XYZ_AGENT_DATA_DIR（xyz-agent 宿主注入，权威通道）；
 *   2. 缺失 → piAgentDir（getAgentDir()）+ warn 一次。
 * 每次调用重新解析（env 读取是零成本操作，不缓存路径防测试/宿主切换时读到旧值）。
 */
export function getEngineDataDir(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = console.warn,
): string {
  const fromEnv = env[XYZ_DATA_DIR_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const fallback = getAgentDir();
  if (!warned) {
    warned = true;
    warn(
      `[engine-data-dir] ${XYZ_DATA_DIR_ENV} is not set; engine journal/pool fall back to the pi agent dir ` +
        `(${fallback}). The xyz-agent host normally injects this env — if you are running inside xyz-agent, ` +
        `check the runtime spawn env; standalone pi installs intentionally use the pi agent dir.`,
    );
  }
  return fallback;
}
