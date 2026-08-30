// src/execution/engine/common/nesting-guard.ts
//
// 嵌套防护（P2 公共降级层）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D8（嵌套防护双层）：
//   统一 XYZ_AGENT_SUBAGENT=1 标记（所有引擎 spawn 都注入，引擎 adapter 检测到即拒绝
//   递归派发）+ 剥离各引擎原生标记（CC 的 CLAUDECODE / zsub 的 ZSW_NESTED / pi 的
//   PI_SUBAGENT_*）防继承泄漏——子代理环境的旧标记会让孙代理误判自己已在嵌套层。
//
// 为什么 env 标记是唯一跨引擎可靠手段（被否方案见设计）：「隔离目录里不装扩展」
// 依赖配置洁癖，且 opencode/CC 会吃项目级配置；env 由宿主显式控制，随 spawn 必达。

import { nestedSpawnRejectedError } from "./errors.ts";

/** 统一嵌套标记 env 名（D8）。值恒 '1'。 */
export const NESTED_SPAWN_ENV = "XYZ_AGENT_SUBAGENT";

/** 需剥离的引擎原生嵌套标记（精确名）。 */
const NATIVE_NESTED_KEYS: readonly string[] = ["CLAUDECODE", "ZSW_NESTED"];

/** 需剥离的引擎原生嵌套标记前缀（pi 家族）。 */
const NATIVE_NESTED_PREFIXES: readonly string[] = ["PI_SUBAGENT_"];

/** env 对象形状（NodeJS.ProcessEnv 的结构子集，测试可传普通对象）。 */
export type SpawnEnv = Record<string, string | undefined>;

/**
 * 构造子代理 spawn env：注入 XYZ_AGENT_SUBAGENT=1 + 剥离引擎原生嵌套标记。
 * 返回新对象，不改入参（spawn env 组装链中的多层 spread 安全）。
 */
export function buildNestedSpawnEnv(baseEnv: SpawnEnv): SpawnEnv {
  const env: SpawnEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (NATIVE_NESTED_KEYS.includes(key)) continue;
    if (NATIVE_NESTED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  env[NESTED_SPAWN_ENV] = "1";
  return env;
}

/**
 * 嵌套 spawn 防护断言：检测到统一标记（本进程已是 subagent）抛
 * EngineError(nested_spawn_rejected)——文案说明防护规则、指向 task 内自行完成。
 * 调用点：subagent 工具入口（进程创建前拒绝，D11 处置三级）。
 */
export function assertNotNestedSpawn(env: SpawnEnv): void {
  if (env[NESTED_SPAWN_ENV] === "1") {
    throw nestedSpawnRejectedError();
  }
}
