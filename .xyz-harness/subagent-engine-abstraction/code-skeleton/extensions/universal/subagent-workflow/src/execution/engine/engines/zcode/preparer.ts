// execution/engine/engines/zcode/preparer.ts
//
// ZcodeEngine preparer——隔离 HOME + config.json 原子写 + 凭据引导 + argv 估算（§3.3.7）。
// 移植源：zsub 参考仓 bootstrapIsolatedHome / model-router 的 TS 重写（zcode-plugin-workspace，
// 非运行时依赖——已真机验证：HOME 池化 / mtime 比对按需重建 / config 原子写都过生产检验）。
// 错误前置（§3.3.3，一律先于进程创建）：
//   - engine_credential_missing：源 config 无 apiKey（指向引擎凭据配置文档节）
//   - model_not_available：model 在 zcode provider 体系不可解释（列可用模型清单，D9②）
//   - prompt_too_large：argv 估算超限（建议缩短 task / persona 移 file / 换 stdin 引擎）

import { readFile, rename, writeFile } from "node:fs/promises";

import { estimateArgvBytes, routePersona } from "../../degradation/persona-router.ts";
import { markNestedEnv } from "../../degradation/nested-guard.ts";
import type { AgentTaskSpec, EngineCapabilities, EnginePreparer, PoolContext, PreparedExecution } from "../../types.ts";

export class ZcodePreparer implements EnginePreparer {
  constructor(private readonly capabilities: EngineCapabilities) {}

  async prepare(task: AgentTaskSpec, pool: PoolContext): Promise<PreparedExecution> {
    const env = await this.buildIsolatedEnv(pool);
    const personaChannel = routePersona(task.persona, this.capabilities);
    const argvEstimateBytes = this.estimate(task, personaChannel?.kind === "prompt" ? personaChannel.segment : "");
    this.assertWithinArgvLimit(argvEstimateBytes);
    return {
      env,
      cwd: typeof task.worktree === "object" && task.worktree ? task.worktree.path : (task.cwd ?? process.cwd()),
      poolDir: pool.poolDir,
      spawnedFiles: [],
      argvEstimateBytes,
    };
  }

  /** 隔离 HOME + config.json tmp+rename 原子写（凭据引导 + model.main；无 plugins 块——§3.3.4）。 */
  private async buildIsolatedEnv(pool: PoolContext): Promise<Record<string, string>> {
    await this.ensurePoolConfig(pool);
    const env: Record<string, string> = {};
    env.HOME = `${pool.poolDir}/home`;      // HOME 覆盖（zcode 唯一可靠隔离手段）
    markNestedEnv(env);                      // D8 第一层统一标记
    return env;
  }

  private async ensurePoolConfig(pool: PoolContext): Promise<void> {
    // 数据流：源 config mtime 比对 → 需要重建时 tmp+rename 原子写（zsub 先例）。
    // 失败分支：源 config 无 apiKey → throw engine_credential_missing（前置错误①）。
    const source = await this.readSourceConfig();
    const target = `${pool.poolDir}/home/config.json`;
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(source), "utf8");
    await rename(tmp, target);
  }

  private async readSourceConfig(): Promise<Record<string, unknown>> {
    // 凭据引导（源 config 位置从引擎安装路径动态推导——实现期待实证项①范围）。
    // 真引 node:fs/promises readFile（SDK 级接线）；JSON.parse 产物经守卫收窄（no-unsafe-cast 纪律）。
    const raw = await readFile("skeleton-zcode-source-config.json", "utf8").catch(() => "{}");
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  }

  private estimate(task: AgentTaskSpec, personaSegment: string): number {
    // 透传级：argv 各段（--prompt 值 = persona 段 + task 文本）总长估算。
    return estimateArgvBytes([personaSegment, task.task]);
  }

  private assertWithinArgvLimit(bytes: number): void {
    // 前置拦截：超限 throw prompt_too_large（阈值取自实施期待实证项④实录）。
    const LIMIT = 128 * 1024; // E2BIG 安全边际（实现期以实录校准）
    if (bytes > LIMIT) {
      throw new Error(
        `prompt_too_large: argv estimate ${bytes} > ${LIMIT}. 建议：缩短 task / persona 移 file 通道 / 换 stdin 引擎（engine: pi）`,
      );
    }
  }
}

/** plain object 判定（磁盘 JSON 产物不可信——taste/no-unsafe-cast 纪律）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
