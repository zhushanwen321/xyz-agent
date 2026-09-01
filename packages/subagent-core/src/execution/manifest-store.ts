import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getLogger } from "../core/logger.ts";

import { bestEffort } from "./best-effort.ts";
import { writeAtomicFile } from "../shared/atomic-write.ts";

const logger = getLogger("subagents");

export interface ManifestRecord {
  id: string;
  rootSessionId: string;
  /** 直接父 subagent record ID（层级树构建用）。顶层 record 缺失（undefined）。M3a 补字段。 */
  parentRecordId?: string;
  agentName: string;
  /**
   * 终态枚举：finalizeRecord 写 running/closed/cancelled 三态。
   * SP-1 重构：旧 completed/failed 合并为 closed（L1 统一终态）。
   * cancelled 保持独立（用户取消语义）。crashed 不进 manifest——
   * crashed 是重启重建时靠 sidecar 四分支推断的派生态（见 record-store.ts reconstructAll）。
   * 历史 "error"/"completed"/"failed" 值由读侧 mapManifestStatus 向后兼容映射。
   */
  status: "running" | "closed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  sessionFile?: string;
  /** FR-7 补字段：manifest 写入时从 ExecutionRecord 抓取，供 manifestToSubagent 投影真实值。 */
  task?: string;
  slug?: string;
  model?: string;
}

/** JSON.stringify 缩进空格数（no-magic-numbers 合规）。 */
const MANIFEST_INDENT_SPACES = 2;

/** [perf] 缓存校验戳（与 record-store.ts Stamp 同构；manifest 是小文件，mtime+size 足够）。 */
interface Stamp {
  mtimeMs: number;
  size: number;
}

function statStamp(p: string): Stamp | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** 合法 manifest status 集合（3 态；运行时守卫用，磁盘文件可能陈旧/损坏）。
 * SP-1：completed/failed 合并为 closed。读侧 mapManifestStatus 向后兼容旧值。
 * crashed 不在其中。 */
const VALID_MANIFEST_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "closed",
  "cancelled",
  "completed", // 向后兼容旧 manifest 数据
  "failed",     // 向后兼容旧 manifest 数据
]);

/**
 * 校验 JSON.parse 产物是否为合法 ManifestRecord。
 * 关键字段类型检查——不合法返回 false，调用方据此过滤（防损坏/陈旧文件污染投影）。
 */
function isValidManifest(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.rootSessionId === "string" &&
    typeof v.agentName === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.status === "string" &&
    VALID_MANIFEST_STATUSES.has(v.status)
  );
}

export class ManifestStore {
  private readonly dir: string;

  /** [perf] per-file 缓存：file → { stamp, record }。record=null 表示「已解析但非法」（缓存
   *  负结果避免反复 parse 损坏文件）。stat 戳变化（writeManifest tmp→rename 后 mtime/size 变）
   *  自动失效；删除的文件在下次扫描时修剪。 */
  private readonly cache = new Map<string, { stamp: Stamp; record: ManifestRecord | null }>();

  constructor(dir: string) {
    this.dir = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 原子写：tmp → fsync → rename → fsync dir（shared/atomic-write 统一原语，
   * U6b 迁移——原逐行实现与 writeAtomicFile 逐环等值）。真异步（fs.promises，
   * 不阻塞 event loop）。
   *
   * 失败时原语尽力清理残留 tmp（debug 记录，不掩盖原错误）并原样上抛——
   * 调用方（finalizeRecord）决定降级策略。
   */
  async writeManifest(record: ManifestRecord): Promise<void> {
    const filePath = path.join(this.dir, `${record.id}.json`);
    const content = JSON.stringify(record, null, MANIFEST_INDENT_SPACES);
    // ensureDir:false：目录由构造函数负责创建（缺目录 = 外部删除的异常态，
    // 维持旧实现的 fail-fast 上抛语义，不静默重建）
    await writeAtomicFile(filePath, content, { ensureDir: false });
  }

  /**
   * 按 id 读 manifest。文件不存在/JSON 损坏/schema 不合法均返回 null。
   * 调用方需处理 null。
   */
  async readManifest(id: string): Promise<ManifestRecord | null> {
    const filePath = path.join(this.dir, `${id}.json`);
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      return isValidManifest(parsed) ? parsed : null;
    } catch {
      // 文件缺失（ENOENT）或 JSON 损坏（SyntaxError）均降级为 null
      return null;
    }
  }

  /**
   * 同步读取所有 manifest 记录（best-effort，损坏/非法文件跳过）。
   * 供 RecordStore.collectRecords 投影 orphan 记录使用——替代对私有 dir 的反射访问。
   * 仅返回通过 isValidManifest 校验的记录。
   *
   * [perf] per-file 缓存 + stat 戳校验：collectRecords 每次渲染都调本方法，旧实现每次
   * 全量 readFileSync + JSON.parse 千级 manifest（实测 ~300ms/次）。命中缓存的文件零读取。
   */
  listAllSync(): readonly ManifestRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const names = files.filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
    const disk = new Set(names);

    // 修剪已删除文件
    for (const f of this.cache.keys()) {
      if (!disk.has(f)) this.cache.delete(f);
    }

    const results: ManifestRecord[] = [];
    for (const file of names) {
      const filePath = path.join(this.dir, file);
      const stamp = statStamp(filePath);
      if (!stamp) {
        this.cache.delete(file);
        continue;
      }
      const cached = this.cache.get(file);
      if (cached && cached.stamp.mtimeMs === stamp.mtimeMs && cached.stamp.size === stamp.size) {
        if (cached.record) results.push(cached.record);
        continue;
      }
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        const record = isValidManifest(parsed) ? parsed : null;
        this.cache.set(file, { stamp, record });
        if (record) results.push(record);
      } catch (fileErr) {
        // best-effort：损坏/非法文件跳过（debug 记录便于排查）。缓存负结果防反复 parse。
        this.cache.set(file, { stamp, record: null });
        bestEffort(fileErr, `read manifest ${file} (listAllSync)`);
      }
    }
    return results;
  }

  /**
   * 启动时恢复 tmp 文件。
   * 3 分支逻辑：
   * 1. manifest 已存在 → 删 tmp（陈旧）
   * 2. tmp 合法 + manifest 缺失 → rename tmp 为 manifest
   * 3. tmp 非法 + manifest 缺失 → 删 tmp
   *
   * [T5④ / PS-13] per-file 容错：单个 tmp 文件操作失败（ENOENT——并发回收/外部清理
   * 抢先、EACCES 等）只 warn + 跳过该文件，不再中断整轮——旧实现单文件 ENOENT 即抛，
   * 剩余 tmp 本轮不再处理，自愈但不可见（残留顺延下次启动）。跳过数经 warn 汇总留痕，
   * 调用方返回值形态不变（跳过者不计数）。
   */
  async recoverTmpFiles(): Promise<{ deleted: number; recovered: number }> {
    let deleted = 0;
    let recovered = 0;
    let failed = 0;

    const files = fs.readdirSync(this.dir);
    const tmpFiles = files.filter((f) => f.includes(".json.tmp."));

    for (const tmpFile of tmpFiles) {
      const tmpPath = path.join(this.dir, tmpFile);
      const manifestId = tmpFile.split(".json.tmp.")[0];
      const manifestPath = path.join(this.dir, `${manifestId}.json`);

      try {
        if (fs.existsSync(manifestPath)) {
          // 分支 1: manifest 已存在，删 tmp
          fs.unlinkSync(tmpPath);
          deleted++;
        } else {
          // 试解析 tmp
          try {
            const content = fs.readFileSync(tmpPath, "utf-8");
            const parsed: unknown = JSON.parse(content);
            if (isValidManifest(parsed)) {
              // 分支 2: tmp 是合法 manifest，rename 为正式文件
              fs.renameSync(tmpPath, manifestPath);
              recovered++;
            } else {
              // 分支 3b: 合法 JSON 但非合法 manifest（缺必填字段），删
              fs.unlinkSync(tmpPath);
              deleted++;
            }
          } catch {
            // 分支 3a: JSON.parse 失败，删
            fs.unlinkSync(tmpPath);
            deleted++;
          }
        }
      } catch (fileErr) {
        // [T5④/PS-13] 单文件失败不中断整轮：warn 留痕（含文件名与原因）后继续处理
        // 剩余 tmp。常见于 tmp 已被并发回收/外部清理删除（ENOENT）——自愈场景不再放大。
        failed++;
        logger.warn(`[subagents] recoverTmpFiles: failed to recover ${tmpFile}, skipping (leftovers retry on next startup)`, {
          detail: fileErr instanceof Error ? fileErr.message : String(fileErr),
        });
      }
    }

    if (failed > 0) {
      logger.warn(
        `[subagents] recoverTmpFiles: ${failed} of ${tmpFiles.length} tmp file(s) could not be recovered`,
      );
    }

    return { deleted, recovered };
  }
}
