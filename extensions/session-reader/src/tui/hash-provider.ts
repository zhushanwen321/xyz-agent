import type { AutocompleteProvider, AutocompleteItem } from '@earendil-works/pi-tui'
import { findSessions, type MatchedSession } from '../discovery/find.js'

/**
 * M4 TUI 层：# 引用补全（design §3.3 D-3/D-4 + §1 目标 4 + 附录 P-hash-trigger）。
 *
 * 分层：
 * - 纯逻辑（extractHashFragment / provideHashCandidates / toCandidate）：agentDir 注入，
 *   零 pi 依赖，可单测（同 discovery 层范式）
 * - createHashAutocompleteProvider：pi-tui AutocompleteProvider 接口适配，组装在 index.ts
 *
 * design D-3：# 选中插入 uuid 片段（#xxxxxxxx），不插入名称。
 * design D-4：插入纯文本 # 片段，不展开——工具侧（tool-handler）剥 # 前缀后 findSessions
 * 子串匹配（与 pi @ 引用同构，一致性 > 品味）。
 */

/** uuid 片段长度（design D-3：#uuid 片段。8 字符覆盖 uuid v7 碰撞，且可键盘手敲）。 */
export const FRAGMENT_LEN = 8
/** # 补全默认返回上限（TUI 弹窗可读上限）。 */
const DEFAULT_LIMIT = 10
/** label 里首消息预览最大长度（补全列表每行宽度有限）。 */
const LABEL_PREVIEW_MAX = 40

export interface AutocompleteCandidate {
  /** 显示文本，如 "019e6c96 修复登录 bug" */
  label: string
  /** 副信息，如 "2 小时前" */
  description?: string
  /** 插入编辑器，如 "#019e6c96"（design D-3：uuid 片段，非名称） */
  insertText: string
}

/**
 * 从光标前文本提取 # 片段。
 *
 * 匹配规则：行内 `#` 后跟 0+ 个十六进制/连字符字符（uuid 片段特征），且 `#` 位于 token
 * 边界（行首或非单词字符之后）——避免 `foo#bar`、`C#` 这类 hashtag/语言符号误触发。
 *
 * @param textBeforeCursor 光标前的当前行文本（provider wrapper 传 currentLine.slice(0, cursorCol)）
 * @returns 片段（不含 `#`，空串表示刚输入 `#`）；非 # 引用 → null（调用方据此委托下家 provider）
 */
export function extractHashFragment(textBeforeCursor: string): string | null {
  const m = textBeforeCursor.match(/#([0-9a-f-]*)$/i)
  if (!m || m.index === undefined) return null
  // # 前必须是 token 边界：行首，或前一个字符非单词字符（空格/标点）
  if (m.index > 0) {
    const prev = textBeforeCursor[m.index - 1]
    if (/\w/.test(prev)) return null
  }
  return m[1]
}

/**
 * mtime → 相对时间描述。now 参数可注入用于确定性单测。
 * 顺序：刚刚 → N 分钟前 → N 小时前 → N 天前 → 日期（≥30 天）。
 */
export function formatRelativeTime(mtime: number, now: number = Date.now()): string {
  const diff = now - mtime
  if (diff < 0) return '刚刚' // 时钟偏移兜底（mtime 在未来）
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(mtime).toLocaleDateString()
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/**
 * MatchedSession → AutocompleteCandidate（纯函数，可单测）。
 *
 * insertText = `#` + sessionId 前 8 字符（design D-3）。
 * label = 片段 + 首消息预览（无预览标「(无预览)」）。
 * description = 相对时间（findSessions 不返回 msg 数，用 mtime——design 兜底约定）。
 */
export function toCandidate(m: MatchedSession, now: number = Date.now()): AutocompleteCandidate {
  const frag = m.sessionId.slice(0, FRAGMENT_LEN)
  const preview = m.firstMessagePreview
    ? truncate(m.firstMessagePreview, LABEL_PREVIEW_MAX)
    : '(无预览)'
  return {
    label: `${frag} ${preview}`,
    description: formatRelativeTime(m.mtime, now),
    insertText: `#${frag}`,
  }
}

/**
 * 核心逻辑：光标前文本 → # 引用候选（design §3.3 D-3）。
 *
 * @param input 光标前的文本（provider wrapper 传 currentLine.slice(0, cursorCol)）
 * @param agentDir pi agent 目录（findSessions 注入，零 pi 依赖，可单测）
 * @param opts.limit 返回上限（默认 10）
 * @returns 非 # 前缀 → null（委托下家 provider）；# 前缀 → 候选数组（无匹配为空数组，不抛）
 */
export async function provideHashCandidates(
  input: string,
  agentDir: string,
  opts?: { limit?: number },
): Promise<AutocompleteCandidate[] | null> {
  const fragment = extractHashFragment(input)
  if (fragment === null) return null
  const limit = opts?.limit ?? DEFAULT_LIMIT
  // 空片段 → recent（最近 N 个）；非空 → 按片段子串匹配
  const query = fragment === '' ? 'recent' : fragment
  const { matches } = await findSessions(query, agentDir, { limit })
  return matches.map((m) => toCandidate(m))
}

/**
 * 创建 # autocomplete provider（实现 pi-tui AutocompleteProvider 接口）。
 *
 * 包装内置 current（CombinedAutocompleteProvider，处理 @ 文件 / / 命令 / 路径）：
 * - 非 # 前缀 → 显式委托 current.getSuggestions（addAutocompleteProvider 是 stack 模式，
 *   组合责任在 factory：return null 不会被 pi 自动 fallback，必须显式调 current）
 * - # 前缀有匹配 → 返回 session 候选
 * - # 前缀无匹配 → return null（不委托 current，避免它把 #xxx 当路径前缀返回文件建议）
 *
 * applyCompletion 把 `#fragment`（光标前已输入的片段）替换为完整 `#xxxxxxxx`（选中项的片段）。
 */
export function createHashAutocompleteProvider(
  agentDir: string,
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    triggerCharacters: ['#'],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      // 用户快速连续输入时，pi abort 上一次请求；早返回避免无谓 IO
      if (options.signal.aborted) return null
      const currentLine = lines[cursorLine] ?? ''
      const textBeforeCursor = currentLine.slice(0, cursorCol)
      const fragment = extractHashFragment(textBeforeCursor)
      // 非 # 前缀：委托内置 provider（@ 文件 / / 命令 / 路径补全）
      if (fragment === null) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options)
      }
      // # 前缀：查 session
      const candidates = await provideHashCandidates(textBeforeCursor, agentDir)
      if (options.signal.aborted) return null
      // provideHashCandidates 返回 null 仅在非 # 前缀（fragment===null），上面已拦截；
      // 此处 null 是 TS 收窄的防御性检查，逻辑上不触发
      if (candidates === null || candidates.length === 0) return null
      const items: AutocompleteItem[] = candidates.map((c) => ({
        value: c.insertText,
        label: c.label,
        description: c.description,
      }))
      // prefix = 光标前匹配到的整段（# 及片段），applyCompletion 据此定位替换区间
      return { items, prefix: `#${fragment}` }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // 非本 provider 的 item（不应发生，pi 按 suggestion source 路由 applyCompletion）→ 委托 current
      if (!item.value.startsWith('#')) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
      }
      const currentLine = lines[cursorLine] ?? ''
      const before = currentLine.slice(0, cursorCol - prefix.length)
      const after = currentLine.slice(cursorCol)
      const newLine = before + item.value + after
      const newLines = lines.slice()
      newLines[cursorLine] = newLine
      return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length }
    },
  }
}
