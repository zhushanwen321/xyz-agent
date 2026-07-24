/**
 * 工具块补充细节条 meta 计算（从 Block.vue 拆出，控 script 行数）。
 *
 * 职责：计算展开后细节条的 meta 项（错误摘要 + 行数/字符数 + 耗时）。
 *  - 耗时：startTime→endTime
 *  - 行数/字符数：pi 协议不返回文件元信息（exit code / fileSize 均无），前端从 output 自算。
 *    read 工具 output 是文件内容，行数/字符数有统计意义；bash output 是命令输出，行数有参考价值；
 *    edit/write 等 output 是简短确认（如 "done"），行数无意义不展示。
 *  - 失败态首项（错误性质）用 danger 色强调。
 *
 * formatDuration 由 Block.vue 传入（该函数同时服务 template，避免循环依赖）。
 */
import { computed, type ComputedRef } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'

export interface MetaItem {
  /** 高亮态：failed 首项用 danger，普通信息用 info（蓝），其余默认 muted */
  tone: 'danger' | 'info' | 'muted'
  text: string
}

/** 错误摘要截断长度（细节条单行不撑爆） */
const ERROR_SUMMARY_LIMIT = 40
/** 字符数格式化阈值（>= 此值显示为 XK chars） */
const CHAR_K_THRESHOLD = 1000
/** 有输出统计意义的工具（行数/字符数） */
const OUTPUT_META_TOOLS = new Set(['read', 'bash', 'cat', 'glob', 'grep', 'list'])

export function useToolMeta(params: {
  tool: ComputedRef<ToolCall | undefined>
  toolName: ComputedRef<string>
  isFailed: ComputedRef<boolean>
  formatDuration: (ms: unknown) => string
}): { metaItems: ComputedRef<MetaItem[]> } {
  const { formatDuration } = params

  /** 字符数格式化：>= CHAR_K_THRESHOLD 显示为 XK chars，否则原值 + chars */
  function formatCharCount(n: number): string {
    if (n >= CHAR_K_THRESHOLD) return `${(n / CHAR_K_THRESHOLD).toFixed(1)}K chars`
    return `${n} chars`
  }

  const metaItems = computed<MetaItem[]>(() => {
    const items: MetaItem[] = []
    const tool = params.tool.value
    // 失败态首项：错误定性（从 error/output 首行提取一句话）
    if (params.isFailed.value) {
      const errText = (tool?.error ?? tool?.output ?? '').trim()
      if (errText) {
        const firstLine = errText.split('\n')[0].trim()
        items.push({
          tone: 'danger',
          text: firstLine.length > ERROR_SUMMARY_LIMIT ? `${firstLine.slice(0, ERROR_SUMMARY_LIMIT)}…` : firstLine,
        })
      }
    }
    // 工具特化：行数/字符数（仅 read/bash 等输出有统计意义的工具）
    const name = params.toolName.value
    const output = tool?.output ?? ''
    if (OUTPUT_META_TOOLS.has(name) && output.trim()) {
      const lineCount = output.split('\n').length
      items.push({ tone: 'muted', text: `${lineCount} 行` })
      // read/cat 额外显示字符数（文件内容大小有参考价值）
      if (name === 'read' || name === 'cat') {
        items.push({ tone: 'muted', text: formatCharCount(output.length) })
      }
    }
    // 耗时（末位）
    const start = tool?.startTime
    const end = tool?.endTime
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      items.push({ tone: 'muted', text: formatDuration(end - start) })
    }
    return items
  })

  return { metaItems }
}
