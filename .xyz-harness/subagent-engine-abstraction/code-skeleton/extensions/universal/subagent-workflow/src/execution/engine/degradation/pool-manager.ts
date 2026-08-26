// execution/engine/degradation/pool-manager.ts
//
// 公共降级层 ⑥：隔离目录池管理（§3.3.9 D5 落地细化）。
// 目录布局：<getDataDir()>/engines/<engineId>/<poolKey>/{引擎原生状态, refs.json, journal-*.jsonl}
// 生命周期：acquire（run 启动登记 taskId，幂等刷新 ts）→ release（record GC/删除时移除
// taskId + 删对应 journal 文件）→ 计数归零删池内引擎原生状态（journal 除外——不随池删）。
// refs.json 读写经进程内互斥（宿主唯一写者，无跨进程竞争）；写/删失败置 .cleanup-failed
// 可观测标记（启动期扫描告警）。
//
// poolKey = 净化后 agent 名（非 [a-zA-Z0-9-] 替换为 -；agent 未指定 default）；
// model 不进 key（模型差异由 prepare 期 config 重写消化）；pi 无池化恒 "shared"。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import type { PoolContext, PoolRefs } from "../types.ts";

/** poolKey 计算（§3.3.9；调用方：宿主编排层分配 RunContext.poolKey）。 */
export function computePoolKey(agent: string | undefined): string {
  // 透传级：agent 未指定 → "default"；净化 [^a-zA-Z0-9-] → "-"。
  const base = agent && agent.length > 0 ? agent : "default";
  return base.replace(/[^a-zA-Z0-9-]/g, "-");
}

/** pi 专用恒值（无隔离池语义——PI_CODING_AGENT_DIR 全局一份，仅为路径形状统一）。 */
export const PI_POOL_KEY = "shared";

/**
 * 池管理器（宿主唯一写者）。enginesRoot 从 getDataDir() 动态推导注入（AC-5 禁写死）。
 */
export class PoolManager {
  /** 进程内互斥（refs.json 读写串行化——同池并发 run 共享引擎原生状态，前置门②实证 WAL）。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly enginesRoot: string) {}

  /** run 启动时登记（幂等：已存在刷新 ts）；确保池目录存在。 */
  async acquire(engineId: string, poolKey: string, taskId: string): Promise<PoolContext> {
    const poolDir = this.poolDir(engineId, poolKey);
    await mkdir(poolDir, { recursive: true });
    await this.withLock(() => this.updateRefs(engineId, poolKey, (refs) => {
      refs.refs[taskId] = { taskId, ts: Date.now() };
      return refs;
    }));
    return { engineId, poolKey, poolDir, enginesRoot: this.enginesRoot };
  }

  /** record GC/删除时移除 taskId + 删对应 journal 文件（journal 生命周期跟随 record）。 */
  async release(engineId: string, poolKey: string, taskId: string): Promise<void> {
    await this.withLock(() => this.updateRefs(engineId, poolKey, (refs) => {
      delete refs.refs[taskId];
      return refs;
    }));
    await this.removeJournalFile(engineId, poolKey, taskId);
  }

  /** 引擎配置移除（注册表探测不到该引擎）→ 无视计数整池清理，journal 除外。 */
  async sweepEnginePools(engineId: string): Promise<void> {
    // 数据流：枚举 engines/<id>/* 池 → 跳过各池 journal-*.jsonl → 删引擎原生状态。
    // 清理失败 → 写 <poolDir>/.cleanup-failed 标记（可观测不静默）。
    throw new Error(`skeleton: engine pool sweep (engineId=${engineId}, journal preserved)`);
  }

  // ── 内部（真引 node:fs/promises——SDK 级接线；refs.json tmp+rename 原子写）──

  poolDir(engineId: string, poolKey: string): string {
    return `${this.enginesRoot}/${engineId}/${poolKey}`;
  }

  private refsPath(engineId: string, poolKey: string): string {
    return `${this.poolDir(engineId, poolKey)}/refs.json`;
  }

  private async withLock<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async updateRefs(
    engineId: string,
    poolKey: string,
    mutate: (refs: PoolRefs) => PoolRefs,
  ): Promise<void> {
    const path = this.refsPath(engineId, poolKey);
    let refs: PoolRefs = { v: 1, refs: {} };
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isPoolRefs(raw)) refs = raw;
    } catch {
      refs = { v: 1, refs: {} }; // 首次（文件不存在）→ 空表起步
    }
    const next = mutate(refs);
    // tmp+rename 原子写（zsub config 原子写同款纪律；失败置 .cleanup-failed 属实现域）。
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(next), "utf8");
    await rename(tmp, path);
  }

  private async removeJournalFile(engineId: string, poolKey: string, taskId: string): Promise<void> {
    // 删 <poolDir>/journal-<taskId>.jsonl（best-effort；ENOENT 静默）。
    throw new Error(`skeleton: journal file removal on release (taskId=${taskId})`);
  }
}

// ── 叶子级纯函数 ─────────────────────────────

/** plain object 判定（磁盘 JSON.parse 产物不可信——逐字段收窄的前置 guard）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** refs.json 形状守卫（taste/no-unsafe-cast 纪律：JSON.parse 产物不裸断言）。 */
function isPoolRefs(v: unknown): v is PoolRefs {
  if (!isPlainObject(v)) return false;
  if (v.v !== 1) return false;
  return isPlainObject(v.refs);
}
