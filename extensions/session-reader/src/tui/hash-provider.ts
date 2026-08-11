import type { AutocompleteProvider, AutocompleteItem } from '@earendil-works/pi-tui'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'
import { listGlobalSessionIds } from '../discovery/roots.js'

/**
 * M4 TUI 层：# 引用补全（design §3.3 D-3/D-4 + §1 目标 4 + 附录 P-hash-trigger）。
 *
 * 数据源（2026-08-10 重构）：显示候选复用 pi 的 `SessionManager.listAll(cwdSessionDir)`——
 * 由 pi 维护文件解析、cwd 目录定位、session_info.name 提取、并发读，extension 只做
 * SessionInfo → AutocompleteItem 的 UI 映射。零自写扫描逻辑（一致性 > 品味）。
 *
 * **唯一前缀作用域（O5 修复）**：insertText 的唯一区分前缀用 **全局同前缀 session id 集**
 *（`listGlobalSessionIds(agentDir)`，跨 cwd），而非显示候选的 per-cwd slice。原因：agent 拿
 * insertText 去 findSessions 是全局扫 agentDir，per-cwd 唯一在全局 find 时可能多匹配
 *（跨 cwd 碰撞）。agentDir 注入（纯逻辑层零 pi 依赖）。
 *
 * 分层：
 * - 纯逻辑（extractHashFragment / formatAge / toCandidate / provideHashCandidates）：
 *   cwdSessionDir + agentDir 注入，可单测（造真实 session 文件让 listAll 真跑，不 mock）
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
 * description（预览/name）最大字符数。SessionInfo.firstMessage 是首消息全文（可能含
 * `<skill>` 注入全文，上千字符），预截断避免传超大字符串给 pi-tui。100 覆盖到 ~140 列
 * 终端的 description 区（= width − 主列固定32 − prefix2 − safety2）。
 */
const PREVIEW_MAX = 100

// formatAge 时间换算常数（design G4：对齐 /resume formatSessionDate 的单单位语义）
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7
const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365
/** formatAge 数字部分补零宽度（design G4：固定等宽 XXu） */
const AGE_NUM_DIGITS = 2

export interface AutocompleteCandidate {
  /** 显示文本（满宽 label）。`${age} ${预览/name}`，如 "01m 看看 pi-session-reader..." */
  label: string
  /** 副信息（次列）。本 provider 不设（undefined）——触发 SelectList 满宽 label 分支 */
  description?: string
  /** 插入编辑器，如 "#019e6c96"（design D-3：uuid 片段，非名称；不显示给用户看） */
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
 * modified → 固定等宽的单单位时间（对齐用，design G4）。
 *
 * 格式：`now`（<1分钟）或 `XXu`（2位数字补零 + 1 位单位）。单位 m/h/d/w/M/y 全单字符，
 * 总宽 3 字符严格对齐（月用 `M` 区分分钟的 `m`）。对齐 pi `/resume` 的 formatSessionDate
 * 单单位语义，但补零到 2 位 + 压缩月单位以等宽（用户要求「保留2位数字+一位单位」）。
 */
export function formatAge(modified: Date | number, now: number = Date.now()): string {
  const ms = typeof modified === 'number' ? modified : modified.getTime()
  const diff = now - ms
  if (diff < MS_PER_MINUTE) return 'now'
  const mins = Math.floor(diff / MS_PER_MINUTE)
  if (mins < MINUTES_PER_HOUR) return `${String(mins).padStart(AGE_NUM_DIGITS, '0')}m`
  const hours = Math.floor(diff / MS_PER_HOUR)
  if (hours < HOURS_PER_DAY) return `${String(hours).padStart(AGE_NUM_DIGITS, '0')}h`
  const days = Math.floor(diff / MS_PER_DAY)
  if (days < DAYS_PER_WEEK) return `${String(days).padStart(AGE_NUM_DIGITS, '0')}d`
  if (days < DAYS_PER_MONTH) return `${String(Math.floor(days / DAYS_PER_WEEK)).padStart(AGE_NUM_DIGITS, '0')}w`
  if (days < DAYS_PER_YEAR) return `${String(Math.floor(days / DAYS_PER_MONTH)).padStart(AGE_NUM_DIGITS, '0')}M`
  return `${String(Math.floor(days / DAYS_PER_YEAR)).padStart(AGE_NUM_DIGITS, '0')}y`
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
 * 两个字符串的字符级最长公共前缀（LCP）长度。逐字符比较到首个差异或较短串末尾。
 */
function lcpLength(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length)
  let i = 0
  while (i < minLen && a[i] === b[i]) i++
  return i
}

/**
 * 计算唯一区分前缀（design §3.3 D5：取【最大】LCP + 1）。
 *
 * 在同组候选 siblings 中要唯一区分 sid，须比「与它最像的兄弟」（共享前缀最长者）多一位
 * 字符——取 sid 与所有其他 sibling 的字符级 LCP 的【最大值】+1 作为唯一前缀。
 *
 * **取 max 而非 min**（附录第二轮审查教训）：取 min 会被远房邻居把前缀拖短，大碰撞桶
 *（如 19 元的 019e9680）仍碰撞。须比「最像的兄弟」多一位才能区分。保留连字符——
 * findSessions 子串匹配按整段命中。
 *
 * @param sid 待区分的 sessionId
 * @param siblings 同组所有候选 sessionId（含 sid 自己；内部排除自己后算 LCP）
 * @returns sid 的唯一前缀。siblings 无其他成员时 maxLCP=0，返回 sid.slice(0,1)。
 */
export function computeUniquePrefix(sid: string, siblings: string[]): string {
  let maxLCP = 0
  for (const other of siblings) {
    if (other === sid) continue
    maxLCP = Math.max(maxLCP, lcpLength(sid, other))
  }
  return sid.slice(0, maxLCP + 1)
}

/**
 * SessionInfo → AutocompleteCandidate（纯函数，可单测）。
 *
 * **绕过 pi-tui 主列固定32死约束的关键**：不设 description。SelectList.renderItem 在
 * description 为 undefined 时走 else 分支，把 label 当整行截到 width-4 满宽，**不应用主列
 * 固定32的分列逻辑**（select-list.js renderItem：`if (descriptionSingleLine && width>40)`
 * 分支才进主列逻辑，否则 label 满宽）。
 *
 * 映射：
 * - label = `${age} ${预览/name}`（如 "01m 看看 pi-session-reader..."）——满宽渲染，
 *   时间最左 + 1 空格 + 预览吃满，无 padding，不显示 uuid 片段，不含 count（用户反馈）。
 * - description = undefined（不设）——触发上述满宽分支。
 * - insertText = `#片段`（design §3.3 D5）：碰撞桶（siblings.length > 1）→ max LCP+1 唯一前缀
 *   （保留连字符，如 #019fea0e-c）；唯一候选（siblings 空/缺省）→ 固定 8 字符（design D-3）。
 *
 * name 优先于 firstMessage（design G3）。不清洗 XML 标签（对齐 /resume）。只清洗控制字符/换行。
 *
 * @param siblings 同组候选 sessionId（含 s.id）；碰撞时算唯一前缀。缺省/空 → 8 字符片段
 * @param now 计算 age 的基准时间（默认当前）
 */
export function toCandidate(
  s: SessionInfo,
  siblings: string[] = [],
  now: number = Date.now(),
): AutocompleteCandidate {
  const age = formatAge(s.modified, now)
  const text = truncate(normalizeSingleLine(s.name ?? s.firstMessage), PREVIEW_MAX) || '(无预览)'
  // 碰撞桶 → 唯一前缀（max LCP+1，保留连字符）；唯一候选 → 固定 8 字符片段（design D-3）
  const frag = siblings.length > 1 ? computeUniquePrefix(s.id, siblings) : s.id.slice(0, FRAGMENT_LEN)
  return {
    label: `${age} ${text}`,
    insertText: `#${frag}`,
  }
}

/**
 * 核心逻辑：光标前文本 → # 引用候选（design §3.3 D-3 + O5 全局唯一前缀）。
 *
 * **显示候选**：`SessionManager.listAll(cwdSessionDir)`——pi 返回当前 cwd 目录的全部
 * session（含 name/messageCount/firstMessage，已按 modified 倒序），per-cwd，快（~19ms）。
 *
 * **insertText 唯一前缀作用域**（O5 must-fix）：
 * - fragment 非空（用户要拿片段去 find）：siblings = 全局同前缀 id 集
 *   （`listGlobalSessionIds(agentDir).filter(includes fragment)`）——findSessions 全局扫
 *   agentDir，唯一前缀也须对全局计算，否则跨 cwd 碰撞时 #→find 多匹配。
 * - fragment 空（刚输入 #，recent 浏览态）：退化为 8 字符（siblings 传空）——用户从列表
 *   选择，label 有预览可区分候选，不直接拿片段 find；浏览语义不需全局唯一（有意设计）。
 *
 * @param input 光标前的文本（provider wrapper 传 currentLine.slice(0, cursorCol)）
 * @param cwdSessionDir 当前 session 的目录（ctx.sessionManager.getSessionDir()，含 encoded cwd）
 * @param agentDir pi agent 目录（listGlobalSessionIds 全局扫描根，算全局唯一前缀用）
 * @param opts.limit 返回上限（默认 10）
 * @returns 非 # 前缀 → null（委托下家 provider）；# 前缀 → 候选数组（无匹配为空数组，不抛）
 */
export async function provideHashCandidates(
  input: string,
  cwdSessionDir: string,
  agentDir: string,
  opts?: { limit?: number },
): Promise<AutocompleteCandidate[] | null> {
  const fragment = extractHashFragment(input)
  if (fragment === null) return null
  // 目录未就绪（session_start 前的异常窗口）→ 返回空，绝不调 listAll('')——
  // pi 的 listAll 对空字符串 falsy 走默认全盘分支（3488 项 / ~8s），会让 # 弹窗卡死
  if (!cwdSessionDir) return []
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const all = await SessionManager.listAll(cwdSessionDir)
  // uuid 片段非空 → id 子串过滤；空片段（刚输入 #）→ recent（listAll 已按 modified 倒序）
  const filtered =
    fragment === '' ? all : all.filter((s) => s.id.includes(fragment))
  const visible = filtered.slice(0, limit)
  if (fragment === '') {
    // recent 浏览态（刚输入 #）：用户从列表选择，label 有预览区分候选，不直接拿片段 find。
    // 退化为固定 8 字符（toCandidate siblings 传空 → 8 字符），接受可能的跨 cwd 碰撞——
    // 浏览语义不需全局唯一（有意设计，非 bug）。
    return visible.map((s) => toCandidate(s, []))
  }
  // fragment 非空：用户要拿片段 find，insertText 必须全局唯一（design 目标 5：#→find 永不多匹配）
  const globalAll = await listGlobalSessionIds(agentDir)
  const globalIds = globalAll.filter((id) => id.includes(fragment))
  return visible.map((s) => toCandidate(s, globalIds))
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
  getCwdSessionDir: () => string,
  getAgentDir: () => string,
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
      // # 前缀：查 session（getter 动态读当前 session 目录/agentDir，resume 后自动跟随）
      const candidates = await provideHashCandidates(
        textBeforeCursor,
        getCwdSessionDir(),
        getAgentDir(),
      )
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
