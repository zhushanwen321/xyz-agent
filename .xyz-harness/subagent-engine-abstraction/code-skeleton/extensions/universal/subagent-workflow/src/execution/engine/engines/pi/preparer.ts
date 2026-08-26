// execution/engine/engines/pi/preparer.ts
//
// PiEngine preparer——env 组装（spawn 前唯一副作用模块，§3.3.7）。
// 回填锚点（P1 行为零变化）：
//   - env 组装复用现有 buildChildEnv 语义（PI_CODING_AGENT_DIR / PI_SUBAGENT_* 身份贯穿）
//   - schemaEnv 派生：launcher 从 task.schema 派生 env 值（applySchemaEnvToChildEnv
//     byte 级等值——BC-3 / A1③ 锚点，session-runner-schema-env.test 守护）
//   - NESTED 标记经公共 nested-guard 注入（D8 第一层）
// pi 无隔离池：poolKey 恒 "shared"（pool-manager PI_POOL_KEY），prepare 不建池目录。

import { applySchemaEnvToChildEnv } from "@real/execution/session-runner.ts";

import { markNestedEnv, stripEngineNativeNestedMarks } from "../../degradation/nested-guard.ts";
import type { EnginePreparer, PoolContext, PreparedExecution } from "../../types.ts";
import type { AgentTaskSpec } from "../../types.ts";

export class PiPreparer implements EnginePreparer {
  /**
   * pi env 组装：身份标记 + NESTED + schema env 派生。
   * 错误前置（§3.3.3）：pi 的凭据/model 缺失在 launcher 的 model 解析报出
   * （pi 复用主进程 provider 体系，prepare 期通常无凭据错误——zcode 才有 config.json 需求）。
   */
  async prepare(task: AgentTaskSpec, pool: PoolContext): Promise<PreparedExecution> {
    const env = this.buildEnv(task, pool);
    const spawnedFiles: string[] = [];
    return {
      env,
      cwd: this.resolveCwd(task),
      poolDir: pool.poolDir,
      spawnedFiles,
      argvEstimateBytes: 0, // pi 走 stdin（prompt 不进 argv），无 E2BIG 风险，估算恒 0
    };
  }

  private buildEnv(task: AgentTaskSpec, pool: PoolContext): Record<string, string> {
    // 数据流：PI_SUBAGENT 身份标记 + PI_CODING_AGENT_DIR + schema 派生（真接线
    // applySchemaEnvToChildEnv——BC-3 byte 级等值锚点）+ NESTED 标记 + 原生标记清理。
    // env 全 string（undefined 值在 pi 侧无意义——Node spawn env 的 undefined 语义等价未设）。
    const env: Record<string, string> = {};
    stripEngineNativeNestedMarks(env);
    markNestedEnv(env);
    applySchemaEnvToChildEnv(env, task.schema ? JSON.stringify(task.schema) : undefined);
    void pool;
    return env;
  }

  private resolveCwd(task: AgentTaskSpec): string {
    // worktree checkout 路径或 task.cwd / 主 cwd（与现有 runSpawn spawnCwd 语义一致）。
    return typeof task.worktree === "object" && task.worktree ? task.worktree.path : (task.cwd ?? process.cwd());
  }
}
