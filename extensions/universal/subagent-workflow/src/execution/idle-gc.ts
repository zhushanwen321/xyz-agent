/**
 * SP-4 idle record GC：30 天 TTL 定时归档，防 idle record 永久驻留内存。
 * 从 subagent-service.ts 抽出（文件超 max-lines；逻辑自包含：interval + TTL 扫描）。
 * 启动幂等由调用方（service.startGcTimer）守卫；返回 stop 函数供 dispose 清理。
 */
import { getLogger } from "../core/logger.ts";
import { bestEffort } from "./best-effort.ts";
import { isResumable } from "./lifecycle-predicates.ts";
import type { RecordStore } from "./record-store.ts";

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
        }
      }
    }
  }, GC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
