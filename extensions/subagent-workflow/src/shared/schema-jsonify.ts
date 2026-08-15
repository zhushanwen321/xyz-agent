/**
 * Schema JSON 序列化缓存（IF7/#13，TC6/DM4）。
 *
 * 同一 schema 对象引用的重复 JSON.stringify 消除：resolver（compact，instruction
 * 与 schemaEnv 复用同串）与 session-runner formatSchemaInstruction（pretty）在
 * 单次 agent call 内对同一 schema 对象各 stringify 一次；error-recovery 重试路径
 * 再加一次。本 helper 用 WeakMap 按对象引用缓存两种格式，命中返回缓存串。
 *
 * 返回值与直接 JSON.stringify 逐字节一致（compact = JSON.stringify(x)、
 * pretty = JSON.stringify(x, null, 2)）。
 *
 * 失效语义：无。WeakMap 键随 schema/opts 对象 GC 自动回收；单 call 生命周期内
 * schema 对象引用稳定（resolver/runner 均只读），引用稳定即值稳定；postMessage
 * 克隆使跨 call 恒为新对象，天然隔离（DM4）。
 *
 * 层归属：Shared（resolver 与 session-runner 共用，无 Pi 依赖）。
 */

const cache = new WeakMap<object, { compact?: string; pretty?: string }>();

/**
 * JSON.stringify(schema) 的引用级缓存版。
 *
 * @param schema schema 对象（调用方 if 守卫保证非 undefined，helper 不判空）
 * @param mode "compact" = JSON.stringify(x)；"pretty" = JSON.stringify(x, null, 2)
 */
export function stringifySchemaCached(schema: object, mode: "compact" | "pretty"): string {
  let entry = cache.get(schema);
  if (!entry) {
    entry = {};
    cache.set(schema, entry);
  }
  const hit = entry[mode];
  if (hit !== undefined) return hit;
  const serialized = mode === "compact" ? JSON.stringify(schema) : JSON.stringify(schema, null, 2);
  entry[mode] = serialized;
  return serialized;
}
