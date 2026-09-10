/**
 * rebuildSegmentsWithEditedText —— 编辑 user message 后重建 segments（w6 从 renderer lib/utils.ts 迁入）。
 *
 * 编辑框（UserBubble 内联编辑）展示的是归位后的全文（`normalizeContent` 产物，命令在最前），
 * 提交时以「段」为单位重建：非 text 段的序列化文本**从编辑稿中剥离**（段本身保留），
 * 剥离不到则视为用户已删除/改写该段 → 丢弃该段，以文本形态随 prompt 进入。
 *
 * - slash 段：编辑文本里与 slash 段重复的**前缀命令**先剥离（token 边界：`/compact` 后须是
 *   空白或结尾，避免把 `/compactfoo` 误当命令），命令由 slash 段本身承担——否则序列化归位后
 *   prompt 变成 `/compact /compact 总结`（命令翻倍，MF-2）。
 *   编辑文本里已无该命令（用户删除，或改写为另一个命令）时**丢弃**对应 slash 段。
 * - skill / file / mention / session / handoff 段：其序列化文本（skill 为
 *   `<xyz-skill name=".." location=".."/>` 私有标记、file 为 `path[:L<s>-L<e>]`、mention 为
 *   `@name`、session 为 `#sessionId`、handoff 为 `[handoff from label]`）在编辑稿中找到
 *   （尾部须是空白或结尾，避免把 `@alice` 前缀误配 `@alicex`）即**剥离该处文本并保留段**；
 *   找不到则**丢弃段**（用户改写了名字/路径，或删掉了该段——与 slash 语义一致，
 *   不会出现「旧段序列化 + 新文本并列」的翻倍）。
 *   [轮 3 收口] 此前只处理 slash：其余类型整串随编辑文本回灌首个 text 段、段又原位保留，
 *   序列化后同一标记出现两次（skill ⇒ 注入器逐个展开 ⇒ 同一 SKILL.md 注入两遍）。
 * - image 段：**不参与剥离**，恒原位保留（现状）。序列化 `\n<path>\n` 是换行定界的裸路径，
 *   且 UserBubble 提交前对草稿 `.trim()` 会吃掉首尾换行，精确匹配在真实链路不可靠——
 *   硬剥会退化为「段被丢弃 + 首行变成 `/path` 被 pi 当行首命令」的风险，故按未修项登记，
 *   待专门设计（见报告 finding）。因此 image 段仍会随编辑文本翻倍。
 * - subagent 段：序列化为空串（路由标记不进 prompt），无文本足迹 ⇒ 恒原位保留。
 * - 未知新类型：序列化为空串 ⇒ 恒原位保留（失败方向安全）。
 * - text 段：首个 text 段替换为剥离后的编辑文本，其余 text 段丢弃（其内容已并入编辑稿）；
 *   无 text 段时在段首补一个。
 *
 * 支持的段类型：text / slash / skill / file / mention / session / subagent / image / handoff。
 *
 * 残余面（轮 3-4 登记）：剥离按段序单调游标定位（见函数体），依赖「编辑前草稿 =
 * segmentsToText(source)」。正文段被用户整段改写（原文在编辑稿中找不到）时游标不推进，
 * 此时若用户在改写后的正文里新插入与某 chip 序列化同形的字符串、且位于该 chip 之前，
 * 仍可能剥到正文那一处——该场景无文本级判据可区分（段序推断已失效），接受为残余。
 *
 * 纯函数，仅依赖 @xyz-agent/shared 的 Segment 类型与 segmentsToText（序列化 SSOT 复用，
 * 不在此复制第二份段→文本实现）。
 */
import type { Segment } from '@xyz-agent/shared'
import { normalizeSegmentOrder, segmentsToText } from '@xyz-agent/shared'

/**
 * 在 text 中查找 serialized 的首个「尾部边界合法」出现位置，返回下标；无合法出现返回 -1。
 * 边界合法 = 串尾 / 后继字符是空白 / serialized 自身以空白结尾（换行定界的序列化自成边界）。
 * 非合法出现继续向后找（`@alice` 不应命中 `@alicex` 的前缀）。
 */
function findDelimitedOccurrence(text: string, serialized: string, from: number): number {
  const selfDelimited = /\s$/.test(serialized)
  for (let at = from; at <= text.length; ) {
    const idx = text.indexOf(serialized, at)
    if (idx === -1) return -1
    const next = text[idx + serialized.length]
    if (selfDelimited || next === undefined || /\s/.test(next)) return idx
    at = idx + 1
  }
  return -1
}

export function rebuildSegmentsWithEditedText(
  originalSegments: Segment[] | string,
  editedText: string,
): Segment[] {
  const source = Array.isArray(originalSegments) ? originalSegments : []
  let text = editedText
  const retained = new Set<Segment>()
  // 单调游标：text 中已消费到的下标，按段序（归位序 = 草稿文本序）推进。剥离必须按段序
  // 定位，不能恒从 0 找首个合法出现——否则「用户正文里的同形字符串」会被当成 chip 的
  // 序列化文本删掉（RC-A-2，实测 `看看 src/a.ts 吧` + file 段 ⇒ 正文的 src/a.ts 被删、
  // 路径仍出现两次）。依据：编辑前草稿文本就是 segmentsToText(source)，各段序列化形态的
  // 出现顺序与段序一致，故游标单调推进是严格改进。
  let cursor = 0
  // slash 段在归位序下连续居首；首个不匹配即其后 slash 段一并丢弃（文本已自携用户改写的
  // 命令）——等价于逐段 break 的旧语义。
  let slashChainOpen = true

  for (const seg of normalizeSegmentOrder(source)) {
    // 1) 正文段：游标推进到该段原文之后，使其区间内的同形字符串不再被后续 chip 命中。
    //    用户已改写该段（原文在编辑稿中找不到）时不推进——正文与 chip 的相对位置无法再靠
    //    段序推断，退回「找首个合法出现」（与游标引入前同行为，残余面见文件头登记）。
    if (seg.type === 'text') {
      if (seg.text) {
        const at = text.indexOf(seg.text, cursor)
        if (at !== -1) cursor = at + seg.text.length
      }
      continue
    }
    // 2) slash 段：剥离与段重复的前缀命令。命令名匹配要求 token 边界（`/compact` 后是
    //    空白或结尾），避免把 `/compactfoo` 误当命令。
    if (seg.type === 'slash') {
      if (!slashChainOpen) continue
      const prefix = `/${seg.name}`
      const rest = text.slice(cursor + prefix.length)
      if (!text.startsWith(prefix, cursor) || !(rest === '' || /^\s/.test(rest))) {
        slashChainOpen = false
        continue
      }
      text = text.slice(0, cursor) + rest.replace(/^\s+/, '')
      retained.add(seg)
      continue
    }
    // image 段恒保留（未参与剥离，见文件头 finding 说明）
    if (seg.type === 'image') {
      retained.add(seg)
      continue
    }
    // 3) 其余非 text 段：序列化文本仍在编辑稿中 → 剥离该处文本并保留段（防翻倍）；
    //    已不在（用户改写/删除）→ 丢弃段。序列化经 segmentsToText 单元素调用取得（SSOT）。
    const serialized = segmentsToText([seg])
    // 空串序列化（subagent 路由标记 / 未知新类型）无文本足迹，恒保留
    if (serialized === '') {
      retained.add(seg)
      continue
    }
    const at = findDelimitedOccurrence(text, serialized, cursor)
    if (at === -1) continue
    text = text.slice(0, at) + text.slice(at + serialized.length)
    cursor = at
    retained.add(seg)
  }

  // 剥离后只剩空白（典型：两段 chip 之间的分隔空格）→ 收敛为空，否则会在重建时被物化成
  // text 段并 unshift 到段首，使 prompt 以空格开头（RC-A-6，实测 `a.ts b.ts` → ` a.ts b.ts`）。
  if (!text.trim()) text = ''

  // 4) 按原段序重建：保留集内的非 text 段原位保留；首个 text 段替换为剥离后的编辑文本。
  const segments: Segment[] = []
  let textPlaced = false
  for (const seg of source) {
    if (seg.type === 'text') {
      if (text && !textPlaced) {
        segments.push({ type: 'text', text })
        textPlaced = true
      }
    } else if (retained.has(seg)) {
      segments.push(seg)
    }
  }
  if (!textPlaced && text) {
    segments.unshift({ type: 'text', text })
  }
  return segments
}
