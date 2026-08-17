/**
 * Quota provider 类型 — runtime 实现层。
 *
 * re-export shared 类型 + 添加 runtime 专用常量。
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md
 */

import type { QuotaWindow, QuotaWins, NormalizedQuotaRow, ProviderQuotaFetcher } from '@xyz-agent/shared'

/** 无限窗口（未订阅/不支持）。pct=null 前端整行隐藏。 */
export const INFINITE_WIN: QuotaWindow = { pct: null, resetSec: null }

export type { QuotaWindow, QuotaWins, NormalizedQuotaRow, ProviderQuotaFetcher }
