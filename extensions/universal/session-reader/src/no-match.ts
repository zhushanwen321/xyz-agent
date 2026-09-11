/**
 * F1 无匹配域（u9，design 2026-09-10 §5.2 / §6.7 子决策 3）。
 *
 * 从 tool-handler.ts 机械提取（max-lines 拆分轮，零行为变更）：F1 自检行 /
 * 编辑距离候选 / formatNoMatch 渲染，消费方 = tool-handler 的 resolveByFragment
 * 与 findNoMatch（find 零匹配）。自足模块——只依赖 discovery/core 的纯函数。
 */
import { extractSessionIdFromFilename } from './discovery/subagents.js'
import { basename } from './core/toolcall.js'
import type { SessionRoot } from './discovery/roots.js'

/**
 * Levenshtein 编辑距离（纯函数）。单行 DP 滚动数组，O(len(a)×len(b)) 时间。
 * F1 用它对 uuid query 找最接近的候选 id（§5.2「最接近的候选」），让 agent 一眼自纠
 *（如 01a08zzz → 01a08aac）。候选量级 ≤ 数千、uuid 36 字符，毫秒级。
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

/** 首个差异位（1-based，人类位次）；等串/一方为前缀时 undefined（无「X → Y」可标）。 */
function firstDiffPosition(a: string, b: string): number | undefined {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i + 1
  }
  return undefined
}

/** F1 编辑距离候选行上限（§5.2 top-3）。 */
const NO_MATCH_SUGGESTIONS = 3

/**
 * F1 自检行根标签列宽（2 空格缩进 + 最长 `[subagent]` 10 字符 + 3 对齐间距，
 * 同 doctor 表 DOCTOR_ROOT_LABEL_PAD 的对齐思路）。
 */
const F1_ROOT_LABEL_PAD = 15

/**
 * F1 无匹配（u9 重写，design §5.2 形态——逐段规格）：
 *
 * ① 事实型自检行：main 根 N 文件 / subagent 根 M 文件 /「候选集非空|为空」/「查询已做
 *    uuid 归一化匹配（小写+去连字符）后仍无命中」。计数取 roots——调用方在 F1 路径
 *    恒以无 options 的 resolveSessionRoots 实扫（find/doctor 缓存句柄不注入，§7B 要点 8：
 *    缓存计数会把 PS-14「首条 assistant 前 0 文件」误报成「主根为空」），即本次实扫结果。
 *    只陈述事实，**不得**出现「真的没有这个 session」类归因断言（§3.3 教训：大写/去连
 *    字符输入在归一化前会被错误归因为「不存在」）。
 * ② 编辑距离最近候选 top-3（标注 source 与差异位），候选 = roots 实扫文件名提取的
 *    sessionId（extractSessionIdFromFilename 与 buildManifestIndex 同源；非 id 形态
 *    文件名提不出 → 不进候选，文件名与 header id 同源由 pi 写入保证）。
 * ③「正确做法」四条：标题/keyword、绝对路径 outline、更短前缀、doctor。
 * ④ 最后一行封死 shell 绕行：find/ls/rg 搜 session 目录、cat/read 原始 .jsonl 均禁止。
 *
 * 无「👉 用 recent 看全量」误导指引（recent 候选对写错的 uuid 无自纠价值，§6.7 被否项）。
 */
export function formatNoMatch(query: string, roots: SessionRoot[]): string {
  const lines: string[] = []
  lines.push(`无匹配 session："${query}"`)

  // ① 自检行（只陈述事实）
  lines.push('')
  lines.push('自检（发现层，只陈述事实）：')
  let totalFiles = 0
  for (const r of roots) {
    if (r.dedupedInto !== undefined) {
      lines.push(`  [${r.kind}]`.padEnd(F1_ROOT_LABEL_PAD) + `与 [${r.dedupedInto}] 同路径，已去重`)
      continue
    }
    const count = r.fileCount ?? r.files.length
    totalFiles += count
    lines.push(`  [${r.kind}]`.padEnd(F1_ROOT_LABEL_PAD) + `${r.path}：${count} 文件`)
  }
  lines.push(
    totalFiles > 0
      ? `  → 候选集非空（共 ${totalFiles} 文件），根解析正常`
      : '  → 候选集为空（所有候选根均 0 文件）',
  )
  lines.push('  → 查询已做 uuid 归一化匹配（小写 + 去连字符）后仍无命中')

  // ② 编辑距离最近候选 top-3（source 标注 + 首个差异位）
  const candidates = new Map<string, { sessionId: string; source: string; mtime: number }>()
  for (const r of roots) {
    if (r.dedupedInto !== undefined) continue
    for (const f of r.files) {
      const sid = extractSessionIdFromFilename(basename(f.path))
      if (sid === '') continue
      const existing = candidates.get(sid)
      if (existing === undefined || f.mtime > existing.mtime) {
        candidates.set(sid, { sessionId: sid, source: r.source, mtime: f.mtime })
      }
    }
  }
  const suggestions = [...candidates.values()]
    .map((c) => ({ ...c, distance: levenshtein(query, c.sessionId) }))
    .sort((a, b) => a.distance - b.distance || b.mtime - a.mtime)
    .slice(0, NO_MATCH_SUGGESTIONS)
  lines.push('')
  lines.push('最接近的候选（编辑距离）：')
  if (suggestions.length === 0) {
    lines.push('  （候选集中无可比对的 session id）')
  }
  for (const s of suggestions) {
    const pos = firstDiffPosition(query, s.sessionId)
    const diff =
      pos !== undefined ? `差异在第 ${pos} 位：${query[pos - 1] ?? ''} → ${s.sessionId[pos - 1] ?? ''}` : ''
    lines.push(`  ${s.sessionId}  ${s.source}  ${diff}`.trimEnd())
  }

  // ③ 正确做法四条（每条都确定能成功，§2 目标 2）
  lines.push('')
  lines.push('正确做法：')
  lines.push(`  - 改用标题/keyword：session_read { action:"find", query:"<标题关键词>" }`)
  lines.push(`  - 已知文件路径时直接传绝对路径：session_read { action:"outline", session:"<绝对路径>.jsonl" }`)
  lines.push(`  - 截断/过期 id 用更短前缀：session_read { action:"find", query:"<更短前缀>" }`)
  lines.push(`  - 想先看环境与根目录状态：session_read { action:"doctor" }`)

  // ④ 就地封死 shell 绕行（§5.2 最后一行）
  lines.push('')
  lines.push('不要用 shell find/ls/rg 搜 session 目录，不要 cat/read 原始 .jsonl —— session_read 是唯一入口。')
  return lines.join('\n')
}
