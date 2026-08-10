import type { AutocompleteProvider, AutocompleteItem } from '@earendil-works/pi-tui'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'

/**
 * M4 TUI 层：# 引用补全（design §3.3 D-3/D-4 + §1 目标 4 + 附录 P-hash-trigger）。
 *
 * 数据源（2026-08-10 重构）：复用 pi 的 `SessionManager.listAll(cwdSessionDir)`——
 * 由 pi 维护文件解析、cwd 目录定位、session_info.name 提取、并发读，extension 只做
 * SessionInfo → AutocompleteItem 的 UI 映射。零自写扫描逻辑（一致性 > 品味）。
 *
 * 分层：
 * - 纯逻辑（extractHashFragment / formatAge / toCandidate / provideHashCandidates）：
 *   cwdSessionDir 注入，可单测（造真实 session 文件让 listAll 真跑，不 mock）
 * - createHashAutocompleteProvider：pi-tui AutocompleteProvider 接口适配，组装在 index.ts
 *
 * design D-3：# 选中插入 uuid 片段（#xxxxxxxx），不插入名称。
 * design D-4：插入纯文本 # 片段，不展开——工具侧（tool-handler）剥 # 前缀后按片段子串匹配。
 */

/** uuid 片段长度（design D-3：#uuid 片段。8 字符覆盖 uuid v7 碰撞，且可键盘手敲）。 */
export const FRAGMENT_LEN = 8
/** # 补全默认返回上限（TUI 弹窗可读上限，design G6）。 */
const DEFAULT_LIMIT = 10
/**
 * description 里预览文本最大字符数。SessionInfo.firstMessage 是首消息全文（可能含
 * `<skill>` 注入全文，上千字符），必须预截断——否则拼 `${text}  count age` 后，
 * pi-tui SelectList 从左截断会把末尾的 count/age 截掉。50 字符在 ≥80 列终端
 *（description 区约 64 列）下留足余量给 `count age`（≤9 字符）。（design G2：远超现状 23 字符）
 */
const PREVIEW_MAX = 50

// formatAge 时间换算常数（design G4：对齐 /resume formatSessionDate 的单单位语义）
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7
const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365

export interface AutocompleteCandidate {
  /** 显示文本（主列），如 "019e6c96"。label 走 pi-tui SelectList 主列（≤32 字符），只放短片段 */
  label: string
  /** 副信息（次列，占剩余宽度），如 "修复登录 bug  130 12m"。预览/name + count + 单位时间 */
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
 * modified → 单单位相对时间描述（对齐 pi 内置 `/resume` 的 `formatSessionDate`）。
 *
 * 顺序：now → Nm → Nh → Nd → Nw → Nmo → Ny。**只用一个单位**（design G4），
 * 不出现「刚刚/分钟前」混排。now 参数可注入用于确定性单测。
 *
 * 照搬 session-selector.js:21 的 formatSessionDate 逻辑（不 import pi 内部未导出函数，
 * 避免耦合；逻辑简单且稳定）。
 */
export function formatAge(modified: Date | number, now: number = Date.now()): string {
  const ms = typeof modified === 'number' ? modified : modified.getTime()
  const diff = now - ms
  if (diff < MS_PER_MINUTE) return 'now'
  const mins = Math.floor(diff / MS_PER_MINUTE)
  if (mins < MINUTES_PER_HOUR) return `${mins}m`
  const hours = Math.floor(diff / MS_PER_HOUR)
  if (hours < HOURS_PER_DAY) return `${hours}h`
  const days = Math.floor(diff / MS_PER_DAY)
  if (days < DAYS_PER_WEEK) return `${days}d`
  if (days < DAYS_PER_MONTH) return `${Math.floor(days / DAYS_PER_WEEK)}w`
  if (days < DAYS_PER_YEAR) return `${Math.floor(days / DAYS_PER_MONTH)}mo`
  return `${Math.floor(days / DAYS_PER_YEAR)}y`
}

/** 控制字符/换行 → 单空格（避免 description 带换行破坏 SelectList 单行渲染）。 */
function normalizeSingleLine(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
}

/** 按字符数截断（预览用，CJK 宽度边缘情况接受 pi-tui 最终裁剪更保守）。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/**
 * SessionInfo → AutocompleteCandidate（纯函数，可单测）。
 *
 - insertText = `#` + sessionId 前 8 字符（design D-3）。
 - label = 片段（8 字符，走主列，远小于 32 上限）。
 - description = `预览或name  count age`（走次列吃满剩余宽度，design 决策 2 方案 C）：
   name 优先于 firstMessage（design G3）；count = messageCount；age = formatAge。
 *
 * 不清洗 XML 标签（如 `<skill>`）——对齐 `/resume` 行为（resume 也不清洗，原样显示
 * firstMessage）。只清洗控制字符/换行避免渲染异常。
 */
export function toCandidate(s: SessionInfo, now: number = Date.now()): AutocompleteCandidate {
  const frag = s.id.slice(0, FRAGMENT_LEN)
  // SessionInfo.firstMessage 是首消息全文（可能上千字符），必须截断——否则拼后的 description
  // 被 pi-tui 从左截断会吃掉末尾的 count/age。name 同理可能长，一并截断。
  const text = truncate(normalizeSingleLine(s.name ?? s.firstMessage), PREVIEW_MAX) || '(无预览)'
  const count = String(s.messageCount)
  const age = formatAge(s.modified, now)
  return {
    label: frag,
    description: `${text}  ${count} ${age}`,
    insertText: `#${frag}`,
  }
}

/**
 * 核心逻辑：光标前文本 → # 引用候选（design §3.3 D-3）。
 *
 * 数据源：`SessionManager.listAll(cwdSessionDir)`——pi 返回当前 cwd 目录的全部 session
 *（含 name/messageCount/firstMessage，已按 modified 倒序），extension 不自写扫描。
 *
 * @param input 光标前的文本（provider wrapper 传 currentLine.slice(0, cursorCol)）
 * @param cwdSessionDir 当前 session 的目录（ctx.sessionManager.getSessionDir()，含 encoded cwd）
 * @param opts.limit 返回上限（默认 10）
 * @returns 非 # 前缀 → null（委托下家 provider）；# 前缀 → 候选数组（无匹配为空数组，不抛）
 */
export async function provideHashCandidates(
  input: string,
  cwdSessionDir: string,
  opts?: { limit?: number },
): Promise<AutocompleteCandidate[] | null> {
  const fragment = extractHashFragment(input)
  if (fragment === null) return null
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const all = await SessionManager.listAll(cwdSessionDir)
  // uuid 片段非空 → id 子串过滤；空片段（刚输入 #）→ recent（listAll 已按 modified 倒序）
  const filtered =
    fragment === '' ? all : all.filter((s) => s.id.includes(fragment))
  return filtered.slice(0, limit).map((s) => toCandidate(s))
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
  cwdSessionDir: string,
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
      const candidates = await provideHashCandidates(textBeforeCursor, cwdSessionDir)
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
