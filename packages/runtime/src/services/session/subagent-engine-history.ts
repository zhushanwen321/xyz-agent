/**
 * subagent-engine-history —— 非 pi 引擎 record 的历史详情读取薄层（dual-track-
 * convergence D1：journal 读取链收敛）。
 *
 * 读取链本体（三级降级编排 + journal 重放 + SessionView 投影 + reader registry
 * 分发）已收敛到 core 单一实现：
 * @zhushanwen/subagent-core/execution/engine/common/session-view-service（conformance
 * C5 守护的 updateFromEvent reducer；engineHandle 单一 guard 在同目录
 * session-view-types 的 parseEngineHandle）。本文件只保留 runtime 侧路由段：
 * extractRecordEngine（record.engine 路由判定，session-service.getSubagentHistory
 * 消费）+ readEngineSubagentHistory 薄调用。
 *
 * 历史：收敛前本文件持有手写 journal reducer（applyJournalEvent 等 7 case ~150 行，
 * 零测试守护）与 zcode 引擎 id 硬编码分支（if (engine === ZCODE_ENGINE_ID)）——
 * 双轨清单 #1（设计 §2.2），删除理由与 parity 论证见设计 D1。
 *
 * pi 的历史读取不经过本文件：session-service.getSubagentHistory 的 pi 分支保持现有
 * JSONL 直读链（getHistoryFromFilePath），A1 守护（pi 现有直读行为零变化）。
 *
 * record.engine / record.engineHandle 消费契约（并行任务写侧）：`engine?: string`
 * （缺省 = pi，存量 record 零迁移）；`engineHandle?: { sessionRef, journalPath?,
 * poolKey }`（journalPath 绝对路径；sessionRef.dbPath 相对池目录 / 绝对路径）。
 * 写侧落地前字段缺失 → core 编排层防御式降级（空值防御，不依赖其完成时序）。
 */
import type { SubagentRecord, Message } from '@xyz-agent/shared'
import { readSubagentHistoryMessages } from '@zhushanwen/subagent-core'

/** record 引擎路由段的缺省引擎：存量 record 无 engine 字段 → 按 pi 投影（零迁移）。 */
export const DEFAULT_SUBAGENT_ENGINE = 'pi'

/**
 * record 路由段：从 record 的 engine 字段选引擎。
 *
 * 消费契约（并行任务写侧）：`record.engine?: string`（'pi' | 'zcode' | ...），缺省 =
 * pi。字段由 engine 抽象任务在 shared SubagentRecord / extractor 投影写入——落地前
 * 本函数恒返回 pi（防御式，不依赖其完成时序）。非 trim 透传（空白 id 在 core 编排
 * 层 registry miss 落③级，与收敛前行为等价）。
 */
export function extractRecordEngine(record: SubagentRecord): string {
  const engine = (record as { engine?: unknown }).engine
  return typeof engine === 'string' && engine.length > 0 ? engine : DEFAULT_SUBAGENT_ENGINE
}

/**
 * 非 pi record 的历史详情读取（薄调用 core 单一实现，D1）。
 *
 * 三级降级（①引擎原生 reader ②宿主 journal 重放 ③outcome-only）每级失败留 debug/
 * warn 日志不抛崩溃（GUI 详情页永不白屏报错，设计 A8）。pi record 返回 []：pi 的
 * ①级 = 调用方现有 JSONL 直读链（session-service.getSubagentHistory），A1 守护。
 *
 * 类型说明：core 返回 HistoryMessage[]（shared Message 的结构子集，core 不 import
 * workspace private 的 shared 包——见 session-view-types 文件头）——TS 结构类型直接
 * 可赋值，兼容性由本函数签名的类型检查守护。
 *
 * @param dataDir xyz-agent 数据根（getDataDir() 产物；journal/dbPath 白名单在 core
 *                编排层经同一份 paths.ts 布局 SSOT 推导，禁自拼）
 */
export async function readEngineSubagentHistory(record: SubagentRecord, dataDir: string): Promise<Message[]> {
  return readSubagentHistoryMessages(record, dataDir)
}
