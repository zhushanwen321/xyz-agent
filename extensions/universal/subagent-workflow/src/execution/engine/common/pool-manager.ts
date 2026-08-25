// src/execution/engine/common/pool-manager.ts
//
// 隔离目录池管理（P2 公共降级层）。设计权威源：
// docs/architecture/subagent-engine-abstraction.md D5（隔离目录池化保留，随 record
// 生命周期回收，清理只做到池粒度）+ §3.3.9（目录布局 / refs 方案）。
//
// P2 口径（与 §3.3.9 完整设计的差异，签名所限）：引用计数是**进程内注册表**——
// acquire/release 的任务书签名无 taskId，refs.json 文件形态（登记 taskId + ts）留给
// 后续 wave 在 preparer/host 接线时落地（宿主是唯一写者，升级为文件形态不改变本模块
// 的 acquire/release 语义边界）。
//
// 删除边界（D5 三条硬规则）：
//   1. 只删引擎原生状态（隔离 HOME / config / db.sqlite，均可由 preparer 重建）；
//   2. journal-*.jsonl 不随池删——生命周期跟随 record，避免「池删导致仍存 record 的
//      历史从②级静默跌③级」；
//   3. 删除失败置 .pool-cleanup-failed 标记文件（可观测不静默），启动期扫描该标记告警。

import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import { resolvePoolDir } from "../paths.ts";

const logger = getLogger("subagents");

/** 清理失败标记文件名（置于池目录内；内容为 JSON 失败清单）。 */
export const POOL_CLEANUP_FAILED_MARKER = ".pool-cleanup-failed";

/** readdir withFileTypes 的条目结构子集。 */
interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
}

/** 池管理的文件系统依赖面（结构接口：测试注入 fake，免 vi.mock 整个 fs 模块）。 */
export interface PoolFsDeps {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  readdir(path: string): Promise<DirEntryLike[]>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

// ============================================================
// 进程内池注册表（引用计数）
// ============================================================

/** key = 池目录绝对路径 → 活跃引用计数。 */
const poolRefs = new Map<string, number>();

/** 测试隔离专用：清空进程内注册表（生产禁用——会丢失活跃引用计数）。 */
export function resetPoolRegistryForTests(): void {
  poolRefs.clear();
}

// ============================================================
// acquire / release
// ============================================================

/**
 * 获取池目录：mkdir -p（幂等）+ 进程内引用计数 +1，返回池目录绝对路径。
 * 路径一律经 paths.ts resolvePoolDir 派生（双端同源，禁自拼）。
 */
export async function acquirePool(
  dataDir: string,
  engineId: string,
  poolKey: string,
  fs: Pick<PoolFsDeps, "mkdir"> = nodeFs,
): Promise<string> {
  const poolDir = resolvePoolDir(dataDir, engineId, poolKey);
  await fs.mkdir(poolDir, { recursive: true });
  poolRefs.set(poolDir, (poolRefs.get(poolDir) ?? 0) + 1);
  return poolDir;
}

/**
 * 释放一次池引用（record GC / 删除时调用）：计数递减；归零删整池——只删引擎原生
 * 状态，journal-*.jsonl 保留（D5）；删除失败置标记文件并 warn，不静默不 throw
 * （清理失败不是 record GC 的失败）。
 */
export async function releasePoolRef(
  dataDir: string,
  engineId: string,
  poolKey: string,
  fs: PoolFsDeps = nodeFs,
): Promise<void> {
  const poolDir = resolvePoolDir(dataDir, engineId, poolKey);
  const current = poolRefs.get(poolDir);
  // 无计数（进程重启后释放 / 未 acquire 的释放）→ 保守不删池：删池决策必须有本进程
  // 内的归零证据，凭空删除可能误删其他进程正在使用的池
  if (current === undefined || current <= 0) {
    poolRefs.delete(poolDir);
    logger.debug(`[pool-manager] release without live ref, skip pool deletion: ${poolDir}`);
    return;
  }
  if (current > 1) {
    poolRefs.set(poolDir, current - 1);
    return;
  }
  // 归零：删引擎原生状态（journal 保留）
  poolRefs.delete(poolDir);
  await deletePoolNativeState(poolDir, fs);
}

/** journal 文件名判定（与 paths.ts 的 journal-<taskId>.jsonl 命名约定一致）。 */
function isJournalFile(name: string): boolean {
  return name.startsWith("journal-") && name.endsWith(".jsonl");
}

/** 删池内引擎原生状态：逐条目删除（跳过 journal），目录清空后移除目录本身。 */
async function deletePoolNativeState(poolDir: string, fs: PoolFsDeps): Promise<void> {
  const failures: string[] = [];
  let entries: DirEntryLike[];
  try {
    entries = await fs.readdir(poolDir);
  } catch {
    // 池目录不存在（从未创建 / 已删）= 无原生状态可清，视为成功
    return;
  }
  for (const entry of entries) {
    if (isJournalFile(entry.name)) continue;
    try {
      await fs.rm(join(poolDir, entry.name), { recursive: true, force: true });
    } catch (err) {
      failures.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    await markCleanupFailed(poolDir, failures, fs);
    return;
  }
  try {
    // 目录内只剩 journal（或已空）：只剩 journal 时保留目录（journal 生命周期跟 record）
    const remaining = await fs.readdir(poolDir);
    if (remaining.every((e) => isJournalFile(e.name))) return;
    await fs.rmdir(poolDir);
  } catch (err) {
    await markCleanupFailed(
      poolDir,
      [`(rmdir): ${err instanceof Error ? err.message : String(err)}`],
      fs,
    );
  }
}

/** 置 .pool-cleanup-failed 标记（失败清单 JSON）+ warn——可观测不静默（D5）。 */
async function markCleanupFailed(poolDir: string, failures: string[], fs: PoolFsDeps): Promise<void> {
  const marker = join(poolDir, POOL_CLEANUP_FAILED_MARKER);
  const payload = JSON.stringify({ ts: Date.now(), failures });
  logger.warn(
    `[pool-manager] pool cleanup failed for ${poolDir} (${failures.length} item(s)); ` +
      `marker written to ${marker} — re-run cleanup after fixing the underlying error`,
  );
  try {
    await fs.writeFile(marker, `${payload}\n`);
  } catch (err) {
    // 标记本身也写不进（目录只读/磁盘满）——error 级留痕是最后防线，不再上抛
    logger.warn(
      `[pool-manager] failed to write cleanup-failed marker ${marker}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================================================
// 单次性产物清理（spawnedFiles）
// ============================================================

/** cleanupSpawnedFiles 选项。 */
export interface SpawnedFilesCleanupOpts {
  /**
   * resume 场景保留：true = 全部保留（no-op）。resume 续接原 session，prompt 文件
   * 等单次性产物不再重写（§3.3.7 preparer resume 语义），清理留给 record 终局。
   */
  keepForResume: boolean;
}

/**
 * 清理单次性产物（preparer 的 spawnedFiles：临时 prompt / persona 文件）。
 * 任务结束即清理（D5）；单条失败收集 warn 不 throw（部分清理优于整体失败），ENOENT
 * 幂等忽略。
 */
export async function cleanupSpawnedFiles(
  paths: string[],
  opts: SpawnedFilesCleanupOpts,
  fs: Pick<PoolFsDeps, "rm"> = nodeFs,
): Promise<void> {
  if (opts.keepForResume) return;
  for (const p of paths) {
    try {
      await fs.rm(p, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        `[pool-manager] spawned file cleanup failed for ${p}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ── 默认 fs 实现 ────────────────────────────────────────────────

const nodeFs: PoolFsDeps = {
  mkdir: (p, o) => mkdir(p, o),
  readdir: (p) => readdir(p, { withFileTypes: true }) as Promise<DirEntryLike[]>,
  rm: (p, o) => rm(p, o),
  rmdir: (p) => rmdir(p),
  writeFile: (p, d) => writeFile(p, d, "utf8"),
};
