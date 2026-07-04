/**
 * unified diff 解析纯函数（R2 logic 层）。
 *
 * 输入 git.getDiff 返回的 patch 字符串（标准 unified diff，`git diff` stdout），
 * 输出结构化的 hunks/lines，供 DiffView.vue 做行级着色渲染。
 *
 * 为何自写而非引入 diff2html：
 * - unified diff 文本规则极简（hunk 头 `@@ -a,b +c,d @@` + 行首 +/-/空 分类），纯函数约 80 行。
 * - diff2html 自带 HTML/CSS 与项目 design-tokens + 双主题体系冲突，引入后需大量样式覆盖，更重。
 * - 纯函数便于 vitest 单测，输出结构可走 design-tokens 变量（--success/--danger）着色。
 *
 * XSS：本函数只产出数据结构，不生成 HTML。代码内容的语法高亮由 CodeBlock 经 shiki codeToHtml
 * 处理（转义所有非 token 文本），渲染层 DiffView 用文本插值 + 受控 v-html（shiki span），沿用
 * MarkdownRenderer 的 XSS 论证。
 *
 * 规则参考：https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html
 */

/** diff 行类型 */
export type DiffLineType = 'context' | 'add' | 'del' | 'hunk' | 'meta'

export interface DiffLine {
  type: DiffLineType
  /** 旧文件行号（context/del 有，add 无，meta/hunk 无） */
  oldNo?: number
  /** 新文件行号（context/add 有，del 无，meta/hunk 无） */
  newNo?: number
  /** 行内容（不含行首 +/-/空 分类字符，meta 行保留原始文本） */
  content: string
}

export interface DiffHunk {
  /** hunk 头解析出的旧文件起始行号 */
  oldStart: number
  /** hunk 头解析出的新文件起始行号 */
  newStart: number
  /** 该 hunk 的所有行（含 hunk 头行本身 type='hunk' + 后续 context/add/del 行） */
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: DiffHunk[]
}

/** hunk 头正则：@@ -oldStart,oldCount +newStart,newCount @@ 后跟可选上下文 */
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

/**
 * 解析 unified diff patch 为结构化 hunks。
 *
 * 行分类（首字符）：
 * - '@@ ' → hunk 头：解析 oldStart/newStart，重置行号计数器
 * - ' '   → context：oldNo + newNo 双计数推进
 * - '+'   → add：仅 newNo 推进（oldNo 无）
 * - '-'   → del：仅 oldNo 推进（newNo 无）
 * - '--- '/'+++ '/'diff --git '/'index ' 等 → meta：文件头信息行，type='meta'
 * - 空行：unified diff 里空 context 行实际是「单空格被 trim」的特殊情况，
 *   视作 context（git 有时输出裸空行表示"空 context 行"，content 补空串）
 *
 * 鲁棒性：无法识别的行降级为 meta 原样保留，不中断解析。
 * 空/非 diff 输入（无任何 hunk）→ 返回 { hunks: [] }，DiffView 渲染空态。
 */
export function parseDiff(patch: string): ParsedDiff {
  if (!patch) return { hunks: [] }
  const lines = patch.split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of lines) {
    const hunkMatch = raw.match(HUNK_HEADER)
    if (hunkMatch) {
      // hunk 头：收尾上一个 hunk，开启新 hunk
      oldNo = Number(hunkMatch[1])
      newNo = Number(hunkMatch[3])
      current = { oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(current)
      current.lines.push({ type: 'hunk', content: raw })
      continue
    }

    // 还未进入任何 hunk（前面的 diff --git/index/---/+++ 文件头行）
    if (!current) {
      // 文件头行归为 meta（仅当非空，避免前置空行污染）
      if (raw.trim()) {
        // 累积 meta 到一个隐式 hunk？不——meta 行不属任何 hunk，直接跳过文件头。
        // DiffView 只渲染 hunk 内容，文件路径由 DetailPane header 已展示，无需重复。
      }
      continue
    }

    // hunk 内行分类
    const first = raw[0]
    if (first === '+') {
      current.lines.push({ type: 'add', newNo: newNo++, content: raw.slice(1) })
    } else if (first === '-') {
      current.lines.push({ type: 'del', oldNo: oldNo++, content: raw.slice(1) })
    } else if (first === ' ') {
      current.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, content: raw.slice(1) })
    } else if (raw === '') {
      // 空行：unified diff 中可能是被 trim 尾空格的 context 行，视作 context 推进双计数
      current.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, content: '' })
    } else {
      // 其它（如 '\ No newline at end of file'）：归为 meta 原样保留，不推进计数
      current.lines.push({ type: 'meta', content: raw })
    }
  }

  return { hunks }
}
