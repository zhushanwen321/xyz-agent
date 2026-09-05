/**
 * Quota 域 —— coding-plan 额度查询 RPC 封装。
 *
 * 形态分类（契约见 .xyz-harness/2026-06-23-render-runtime-integration/contract.md §2.3）：
 * - 请求-响应：getCached（读缓存不请求）/ fetch（hover 触发主动查询）
 * - 动作-ack：configure（启用/禁用/写 cookie）
 *
 * 设计文档：docs/page-design/archive/v3/coding-plan-quota/design.md
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md
 */
import type { NormalizedQuotaRow, QuotaFetchFailureReason } from '@xyz-agent/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** getCached / fetch 的统一返回结构。 */
export interface QuotaResult {
  data: NormalizedQuotaRow | null
  lastFetchAt: number | null
  /**
   * 最近一次查询失败原因（A2-4，runtime reason 透传）：data=null 失败态出现；
   * getCached 在上次查询失败时携带（失败态渲染 + 「查看上次成功数据」归 Phase B）。
   */
  reason?: QuotaFetchFailureReason
}

/**
 * 读缓存不发起请求。浮层首屏即时填充（避免空白）。
 * 无缓存返回 `{ data: null, lastFetchAt: null }`。
 */
export async function getCached(providerId: string): Promise<QuotaResult> {
  const reply = await command('quota.getCached', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return { data: reply.data, lastFetchAt: reply.lastFetchAt, reason: reply.reason }
}

/**
 * hover 触发主动查询。成功更新缓存 + 返回最新值。
 * 失败时 runtime 返回失败态（ok=true + data=null + reason），不抛错。
 * 并发保护：同 provider pending 期间复用 Promise（runtime 侧）。
 * 注意：带 10s throttle，10s 内重复 fetch 直接返回缓存。测试查询请用 refreshQuota。
 */
export async function fetchQuota(providerId: string): Promise<QuotaResult> {
  const reply = await command('quota.fetch', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return { data: reply.data, lastFetchAt: reply.lastFetchAt, reason: reply.reason }
}

/**
 * 强制刷新额度（绕过 throttle）。Settings 测试查询按钮专用。
 * 仍走 pending 并发保护（同 provider pending 期间复用 Promise）。
 * 失败时 runtime 返回失败态（ok=true + data=null + reason），不抛错。
 */
export async function refreshQuota(providerId: string): Promise<QuotaResult> {
  const reply = await command('quota.refresh', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return { data: reply.data, lastFetchAt: reply.lastFetchAt, reason: reply.reason }
}

/**
 * Settings 配置。启用/禁用 + 写 cookie（cookie 类）+ 持久化 fetcher + 专属 apiKey（api-key 类）
 * + workspace 地址（资源维度 fetcher 如 opencode，完整 URL 或裸 wrk_ id，runtime 归一化）。
 * enabled=false 不删缓存。apiKey/workspace 空字符串 = 清除，undefined = 不变。
 */
export async function configure(
  providerId: string,
  enabled: boolean,
  cookie?: string,
  fetcher?: string,
  apiKey?: string,
  workspace?: string,
): Promise<{ ok: boolean; error?: string }> {
  const reply = await command('quota.configure', { providerId, enabled, cookie, fetcher, apiKey, workspace }, RPC_BACKSTOP_TIMEOUT_MS)
  return { ok: reply.ok, error: reply.error }
}
