// execution/engine/degradation/nested-guard.ts
//
// 公共降级层 ⑤：嵌套防护双层（D8）。
// 第一层（本模块）：统一 NESTED env 标记（XYZ_AGENT_SUBAGENT=1）——所有引擎 spawn
// 都注入；引擎 adapter/宿主检测到即拒绝递归派发（nested_spawn_rejected，同步无进程）。
// 第二层：各引擎原生标记（CC 的 CLAUDECODE、zsub 的 ZSW_NESTED、pi 的 PI_SUBAGENT_*）
// 由本模块同步清理/利用（不依赖「隔离目录里不装扩展」这类配置洁癖方案）。
//
// env 前缀 XYZ_ 已被 packages/shared/src/constants.ts 的 ENV_WHITELIST_PREFIXES SSOT
// 覆盖（'XYZ_' 在白名单，pre-commit 检查通过，无需改 constants）。

import { NESTED_ENV_VAR, type EngineErrorShape } from "../types.ts";

/** 各引擎原生嵌套/身份标记名（第二层：spawn 前清理，防子引擎误判自身为嵌套子体）。 */
export const ENGINE_NATIVE_NESTED_MARKS: readonly string[] = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_ROOT_CWD",
  "ZSW_NESTED",
  "CLAUDECODE",
];

/** 第一层：所有引擎 spawn 都注入统一 NESTED 标记（preparer env 组装时调用）。 */
export function markNestedEnv(env: Record<string, string>): void {
  env[NESTED_ENV_VAR] = "1";
}

/**
 * 嵌套检测：宿主/adapter 在 run 入口调用（spawn 前，同步拒绝）。
 * 检测到标记 → 返回 nested_spawn_rejected（说明防护规则，指向 task 内自行完成）。
 */
export function detectNestedSpawn(env: NodeJS.ProcessEnv | Record<string, string>): EngineErrorShape | undefined {
  if (env[NESTED_ENV_VAR] === "1") {
    return {
      code: "nested_spawn_rejected",
      message: "nested subagent spawn rejected",
      recovery: "subagent 内禁止再派 subagent——请在当前 task 内自行完成该工作",
    };
  }
  return undefined;
}

/** 第二层：清理各引擎原生标记（防「标记逃逸」——子引擎吃项目级配置复活嵌套机制）。 */
export function stripEngineNativeNestedMarks(env: Record<string, string>): void {
  for (const mark of ENGINE_NATIVE_NESTED_MARKS) {
    delete env[mark];
  }
}
