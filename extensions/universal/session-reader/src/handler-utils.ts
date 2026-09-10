/**
 * tool-handler 共享小工具（max-lines 拆分轮机械提取，零行为变更）。
 *
 * 从 tool-handler.ts「小工具」与「turn/turns 索引解析」段搬出：pad/err/turn 索引解析
 * 被留守的 tool-handler 与拆出的 search-across.ts / extract.ts 共同消费——放独立低层
 * 模块保持单向依赖（handler-utils ← 各域模块 ← tool-handler），不引入循环 import
 *（result-action.ts 的 Deps 注入先例解决不了纯函数跨模块复用，低层模块更直接）。
 * stripHash/formatDate/shortCwd/requireStr 仅 tool-handler 留守部分使用，不在此列。
 */

/** turn 索引显示宽度（T013 三位补零）。 */
const TURN_INDEX_WIDTH = 3

export const pad = (n: number): string => String(n).padStart(TURN_INDEX_WIDTH, '0')

/** 构造带 👉 恢复指引的 Error（handler 抛出，由 execute 闭包 catch）。 */
export function err(message: string): Error {
  return new Error(message)
}

// ---------------------------------------------------------------------------
// turn / turns 索引解析
// ---------------------------------------------------------------------------

const TURN_RE = /^T?(\d+)$/i

export function parseTurnIndex(raw: string): number {
  const m = raw.trim().match(TURN_RE)
  if (!m) {
    throw err(
      `turn "${raw}" 格式无效（应为 T013 或 013）。👉 用合法 turn 索引重试，或 outline 重看有效范围。`,
    )
  }
  return parseInt(m[1], 10)
}

/** turns 范围 "T013-T015" 的段数。 */
const TURNS_RANGE_PARTS = 2

export function parseTurnsRange(raw: string): { start: number; end: number } {
  const parts = raw.split('-').map((s) => s.trim())
  if (parts.length === 1) {
    const i = parseTurnIndex(parts[0])
    return { start: i, end: i }
  }
  if (parts.length === TURNS_RANGE_PARTS) {
    const start = parseTurnIndex(parts[0])
    const end = parseTurnIndex(parts[1])
    if (end < start) {
      throw err(
        `turns 范围 "${raw}" 起始大于结束。👉 检查范围格式（如 T013-T015）重试。`,
      )
    }
    return { start, end }
  }
  throw err(`turns "${raw}" 格式无效（应为 T013 或 T013-T015）。👉 用合法范围重试。`)
}

export function rangeLabel(r: { start: number; end: number }): string {
  return r.start === r.end ? `T${pad(r.start)}` : `T${pad(r.start)}-T${pad(r.end)}`
}
