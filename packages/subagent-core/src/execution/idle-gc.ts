/**
 * SP-4 idle record GC：30 天 TTL 定时归档，防 idle record 永久驻留内存。
 * 从 subagent-service.ts 抽出（文件超 max-lines；逻辑自包含：interval + TTL 扫描）。
 * 启动幂等由调用方（service.startGcTimer）守卫；返回 stop 函数供 dispose 清理。
 */
import { getLogger } from "../core/logger.ts";
import { getEngineDataDir } from "./engine/common/data-dir.ts";
import { releasePoolRef } from "./engine/common/pool-manager.ts";
import { bestEffort } from "./best-effort.ts";
import { isResumable } from "./lifecycle-predicates.ts";
import type { RecordStore } from "./record-store.ts";
import type { ExecutionRecord } from "./types.ts";

const logger = getLogger("subagents");

/** GC 扫描间隔：1 小时。 */
// eslint-disable-next-line no-magic-numbers -- 60*60*1000 = 1h 的毫秒换算常数
const GC_INTERVAL_MS = 60 * 60 * 1000;
/** idle record TTL：30 天（超龄归档）。 */
// eslint-disable-next-line no-magic-numbers -- 30*24*60*60*1000 = 30d 的毫秒换算常数
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 毫秒/天（GC 日志的 d 换算）。 */
// eslint-disable-next-line no-magic-numbers -- 24*60*60*1000 = 1d 的毫秒换算常数
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 启动 idle record GC 定时器，返回 stop 函数（清理 interval；幂等）。
 * 每个扫描周期：对 store 内全部 active record 中 resumable 且带 idleSince 的，
 * 超过 IDLE_TTL_MS 的归档（archive 单条失败不阻断其余，bestEffort 留痕）。
 *
 * [D8 池引用计数接线] 归档时同步释放该 record 的引擎池引用（releasePoolRef：
 * journal 跟随 record 删除 + refs 移除 + 归零删池内原生状态）。锚点选在 30 天 TTL
 * 而非 dispose/archive 类时机，依据：idle record 30 天后引擎侧不会再有活动（archive
 * 后 message 续聊走 fork-from/新 start，不触原引擎），且与 pi 域 session 文件 30 天
 * TTL（session-file-gc 同期删①级读源）形成两引擎对称衰减；disposeAllRecords/close
 * 类时机 record 数据仍保留（可 resurrect / GUI 历史重建可见），journal（②级数据源）
 * 不能删——那是 record 主数据死亡（主 session 文件被 pi 侧删除，core 无触发点）才有
 * 的处置，由 cleanupExpiredPoolRefs 的 TTL 兜底覆盖。
 */
export function startIdleGc(store: RecordStore): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const record of store.listAllActive()) {
      if (isResumable(record) && record.idleSince) {
        const age = now - record.idleSince;
        if (age > IDLE_TTL_MS) {
          logger.warn(`[subagents] GC: archiving idle record ${record.id} (idle for ${Math.round(age / MS_PER_DAY)}d)`);
          try {
            store.archive(record);
          } catch (err) {
            bestEffort(err, `GC archive record ${record.id}`);
          }
          releaseEnginePoolRef(record);
        }
      }
    }
  }, GC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 释放 record 的引擎池引用（best-effort）。无 engineHandle（存量 record / 非引擎
 * 路径）时 no-op；engine 缺省投影 'pi'（与读侧存量 entry 零迁移口径一致）。
 */
function releaseEnginePoolRef(record: ExecutionRecord): void {
  const poolKey = record.engineHandle?.poolKey;
  if (poolKey === undefined) return;
  const engineId = record.engine ?? "pi";
  try {
    releasePoolRef(getEngineDataDir(), engineId, poolKey, record.id);
  } catch (err) {
    bestEffort(err, `GC release pool ref for record ${record.id}`);
  }
}
