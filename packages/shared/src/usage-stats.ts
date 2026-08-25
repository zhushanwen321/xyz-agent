/**
 * 用量统计共享类型（W1 数据层）
 *
 * UsageStatsService（runtime）扫描 session JSONL 后产出 UsageRow[]，
 * 经 WS RPC `usage.getStats` 传给 renderer。
 */

/** 单条用量指标（Token 五分类 + 费用 + 消息计数）。 */
export interface UsageMetrics {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** pi cost.total 逐条累加（D2 透传不重算）。 */
  costUSD: number
  /** assistant 消息条数；compaction 桶 = 压缩/摘要事件数（D1）。 */
  messages: number
}

/** 用量行 = 指标 + 四维分组键（day × provider × model × project）。 */
export interface UsageRow extends UsageMetrics {
  /** 'YYYY-MM-DD' 本机时区（D6，禁止 UTC 切日）。 */
  date: string
  /** compaction/summaries 归 'compaction' 虚拟桶（D1）。 */
  provider: string
  /** responseModel ?? model（D10）；compaction 桶固定 'compaction'。 */
  model: string
  /** session entry cwd 的 basename；无 cwd → '(unknown)'。 */
  project: string
}

/** getStats 返回体。 */
export interface UsageStatsResult {
  rows: UsageRow[]
  /** epoch ms，页面「数据截至」标注。 */
  scannedAt: number
  /** 参与聚合的 session 文件数。 */
  sessionCount: number
  /** 解析失败行数（分片求和，D9）。 */
  skippedLines: number
}
