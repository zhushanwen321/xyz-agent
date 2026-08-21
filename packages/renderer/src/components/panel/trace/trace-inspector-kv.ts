/**
 * inspector 聚合态 kind 特化标量 kv 构造（从 TraceInspector 提取的纯函数，
 * script setup 行数约束）。值取自 row.meta——core summarizeRow 提取的 SSOT，
 * 不二次解析 entry；句子级文案（context 标注）由调用方传 t()。
 */
import type { TraceRow } from '@xyz-agent/core/domain/session-trace'

export interface TraceDetailKv {
  k: string
  v: string
  tone?: 'ok' | 'bad'
  action?: 'jump-parent'
  /** 行尾右侧弱标注（usage 桶语义等解释；「不进 context」同款视觉档位）。 */
  hint?: string
}

export function buildTraceDetailKv(row: TraceRow, t: (key: string) => string): TraceDetailKv[] {
  const out: TraceDetailKv[] = []
  const m = row.meta
  const push = (k: string, v: unknown, tone?: 'ok' | 'bad', hint?: string) => {
    if (v !== undefined && v !== '') out.push({ k, v: String(v), tone, hint })
  }
  push('id', row.entry && 'id' in row.entry ? (row.entry as { id?: unknown }).id : undefined)
  push('parentId', row.entry && 'parentId' in row.entry ? (row.entry as { parentId?: unknown }).parentId : undefined)
  switch (row.kind) {
    case 'ASSISTANT':
      push('model', m.model)
      push('provider', m.provider)
      push('stopReason', m.stopReason)
      // usage 行尾弱标注解释互斥桶语义（cacheRead > input 是常态而非异常）：
      // pi-ai 跨协议归一化后 input = 未缓存，输入侧合计 = 未缓存 + 命中 + 写入
      push('inputTokens', m.inputTokens, undefined, t('panel.trace.usageUncached'))
      push('outputTokens', m.outputTokens)
      push('cacheRead', m.cacheReadTokens, undefined, t('panel.trace.usageCacheRead'))
      if (m.cacheWriteTokens) push('cacheWrite', m.cacheWriteTokens, undefined, t('panel.trace.usageCacheWrite'))
      push('inputTotal', m.inputTotal, undefined, t('panel.trace.usageInputTotal'))
      if (m.reasoningTokens) push('reasoning', m.reasoningTokens, undefined, t('panel.trace.usageReasoning'))
      push('cost', m.costTotal)
      break
    case 'TOOL':
      push('toolName', m.toolName)
      push('toolCallId', m.toolCallId)
      if (m.isError === true) push('result', 'error', 'bad')
      else if (m.isError === false) push('result', 'ok', 'ok')
      break
    case 'BASH':
      push('command', m.command)
      if (m.exitCode !== undefined) push('exitCode', m.exitCode, m.exitCode === 0 ? 'ok' : 'bad')
      push('cancelled', m.cancelled)
      push('truncated', m.truncated)
      push('fullOutputPath', m.fullOutputPath)
      push('excludeFromContext', m.excludeFromContext)
      break
    case 'COMPACTED':
      push('tokensBefore', m.tokensBefore)
      push('firstKeptEntryId', m.firstKeptEntryId)
      push('fromHook', m.fromHook)
      break
    case 'BRANCH':
      push('fromId', m.fromId)
      break
    case 'SYSTEM':
      push('version', m.version)
      push('reason', m.reason)
      push('hash', m.hash)
      push('charCount', m.charCount)
      break
    case 'SESSION':
      push('cwd', m.cwd)
      // 溯源链接（§3.1 样例 5）：两形态（文件路径 / sessionId）由 useTraceJump 解析
      if (m.parentSession !== undefined) {
        out.push({ k: 'parentSession', v: String(m.parentSession), action: 'jump-parent' })
      }
      push('forkEntryId', m.forkEntryId)
      break
    case 'BOUNDARY':
      push('outcome', m.outcome)
      push('reason', m.reason)
      push('handedOffTo', m.handedOffTo)
      break
    default:
      push('customType', m.customType)
      break
  }
  // context 语义标注（§3.4：全量态下不进 context 的 kind 弱标记；影子化给排查线索）
  if (row.shadowed) out.push({ k: 'context', v: t('panel.trace.shadowedHint') })
  else if (!row.inContext) out.push({ k: 'context', v: t('panel.trace.notInContext') })
  return out
}
