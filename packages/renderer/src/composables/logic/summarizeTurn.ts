/**
 * TurnRail 节点摘要纯函数（IF5，w3 wave）。
 *
 * 用途：rail 节点只显示一行短文本（用户输入的开头），
 * 因此需把 user message 的结构化 content 归一化 + 剥 markdown + 截断。
 *
 * 为何独立成纯函数：
 * - 可单测（TC-w3-9 / TC-w3-10），不依赖组件渲染
 * - rail 渲染热路径每次都调，纯函数易被 vue memoize
 *
 * 依赖：
 * - normalizeContent：把 string | Segment[] 归一成纯文本（shared 提供的稳定 API）
 * - MessageTurn：来自同目录 messageTurns（R2 logic 层模型）
 */
import { normalizeContent } from '@xyz-agent/shared'
import type { MessageTurn } from './messageTurns'
import { countThinking, countToolCalls } from './messageTurns'

/** rail 节点摘要最大字符数（中文算 1，超出加省略号）。draft spec 限定单行，20 字够识别回合。 */
const MAX_CHARS = 20
/** 截断后缀（单字符省略号，比 '...' 视觉更轻，符合 rail 节点紧凑排版）。 */
const ELLIPSIS = '…'

/**
 * 从 MessageTurn 提取 rail 节点摘要文本。
 *
 * 处理顺序（每步都有 why）：
 * 1. user 为 null（首条是 assistant 的边缘 turn）→ 没有用户输入可摘要，返回空串
 * 2. normalizeContent 把 string | Segment[] 归一为纯文本：
 *    - string → 原文
 *    - Segment[] → segmentsToText（text 段拼原文，skill/file/mention 段拼展示文本）
 * 3. stripMarkdown 剥离常见 markdown 标记：rail 是单行预览，标题/加粗/链接/代码块等
 *    标记是视觉噪声，剥后更易扫读（保留语义文本）
 * 4. 截断到 MAX_CHARS + 省略号
 */
export function summarizeTurnForRail(turn: MessageTurn): string {
  // 边缘 turn（无 user）无文本可摘要
  if (!turn.user) return ''

  const raw = normalizeContent(turn.user.content)
  const cleaned = stripMarkdown(raw)
  return truncate(cleaned, MAX_CHARS)
}

/**
 * 剥离常见 markdown 标记，保留纯文本语义。
 *
 * 覆盖：
 * - 代码块 ```...``` / 行内 `code` → 去标记留内容
 * - 标题 # / 加粗 ** / 斜体 * / 删除 ~~ → 去标记
 * - 链接 [text](url) / 图片 ![alt](url) → 留 text/alt，去 url
 * - 引用 > / 列表 - / 数字. / 任务 - [x] → 去前缀
 * - 水平线 --- / *** → 去掉
 *
 * 实现用顺序正则替换（非一次性大正则）——可读 + 单步易测，
 * 顺序也有依赖：图片/链接要先于通用中括号去标记，否则会把 alt/url拆散。
 */
export function stripMarkdown(text: string): string {
  let s = text
  // 代码块（``` 含语言标记）整块去标记，保留块内内容
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
  // 行内代码 `code` → code
  s = s.replace(/`([^`]+)`/g, '$1')
  // 图片 ![alt](url) → alt（先于链接，因 ![ 是 [ 的超集前缀）
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 链接 [text](url) → text
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 加粗+斜体 ***x*** / ___x___ → x
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
  s = s.replace(/___([^_]+)___/g, '$1')
  // 加粗 **x** / __x__ → x
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  // 斜体 *x* / _x_ → x（注意：单 * 贪婪会误伤列表项，故只匹配成对的单星号）
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
  // 删除线 ~~x~~ → x
  s = s.replace(/~~([^~]+)~~/g, '$1')
  // 标题前缀 # ## ### （行首）→ 去前缀 + 去首空格
  s = s.replace(/^#{1,6}\s+/gm, '')
  // 引用块前缀 > （行首）→ 去前缀
  s = s.replace(/^>\s?/gm, '')
  // 任务列表 - [x] / - [ ] → 去前缀（先于普通列表项）
  s = s.replace(/^[-*+]\s+\[[ xX]\]\s+/gm, '')
  // 无序列表项前缀 - / * / + （行首）→ 去前缀
  s = s.replace(/^[-*+]\s+/gm, '')
  // 有序列表项前缀 1. （行首）→ 去前缀
  s = s.replace(/^\d+\.\s+/gm, '')
  // 水平线 --- / *** / ___ 单独行 → 去
  s = s.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
  // 多余空白折叠为单空格（标题/列表剥后常留前后空白，rail 单行展示规整化）
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/**
 * 截断到 maxChars 字符（中文字符算 1），超长加省略号。
 *
 * 用 Array.from 按 Unicode 码点切片 ——
 * emoji / CJK 组合字符按单码点计（避免 substring 切到代理对中间产乱码）。
 * 注意省略号本身占 1 字符，所以总长度上限是 maxChars。
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).join('') + ELLIPSIS
}

/**
 * 分隔符（fallback 计数拼接用，与 Turn.vue badge「N thoughts · M tools」同构）。
 * 注意：thoughts/tools 词不走 i18n，与 Turn.vue L177/180 badge 保持一致
 *（badge 也是硬编码英文 + count）；未来统一本地化时再改。
 */
const COUNT_SEP = ' · '

/**
 * 从 turn.assistants 派生 agent 行的一行摘要（rail 节点第二行）。
 *
 * 优先级链（每步都有 why）：
 * 1. content 非空：取首个 normalizeContent 后 trim 非空的 assistant content，
 *    stripMarkdown + truncate。pi agent-loop 每 turn 通常仅末条 emit 文本回复，
 *    取首个非空即可（不 concat，避免半截话拼接）。
 * 2. fallback 计数：用 countThinking/countToolCalls 拼「N thoughts · M tools」。
 *    纯工具 turn / 纯 thinking turn 常无 content，计数是唯一可读摘要。
 * 3. 全空（无 content + 无 thinking + 无 toolCalls）：返回空串。
 *    由调用方决定显占位（如「进行中…」）还是省略行。
 *
 * 依赖：countThinking/countToolCalls 聚合 turn.assistants（messageTurns.ts 纯函数）。
 */
export function summarizeAssistantForRail(turn: MessageTurn): string {
  // 1. 找首个非空 content
  for (const m of turn.assistants) {
    const text = normalizeContent(m.content).trim()
    if (text) {
      return truncate(stripMarkdown(text), MAX_CHARS)
    }
  }
  // 2. fallback 计数
  const thoughts = countThinking(turn)
  const tools = countToolCalls(turn)
  const parts: string[] = []
  if (thoughts > 0) parts.push(`${thoughts} thoughts`)
  if (tools > 0) parts.push(`${tools} tools`)
  return parts.join(COUNT_SEP)
}
