/**
 * Usage 域 —— 用量统计数据 RPC 封装。
 *
 * 设计文档：docs/todo/usage-stats-design.md §3.4 W2
 */
import type { UsageStatsResult } from '@xyz-agent/shared'
import { command } from '../request'

/**
 * 拉取用量统计数据（session JSONL 扫描聚合）。
 * 返回 UsageStatsResult（rows / scannedAt / sessionCount / skippedLines）。
 */
export async function getUsageStats(): Promise<UsageStatsResult> {
  const reply = await command('usage.getStats', {})
  return reply
}
