/**
 * Segment —— user message content 的结构化模型（ADR-0037）。
 *
 * Message.content 从纯 string 重构为 `string | Segment[]`：
 * - user message → Segment[]（badge 载体，含 skill/file/mention 等结构化片段）
 * - assistant message → string（流式 text_delta 热路径，无 badge 需求）
 * - system/custom message → string（提示文本）
 *
 * 全链路（composer DOM → store → 渲染）保持 Segment[] 结构化，
 * 只在 pi 边界序列化/反序列化（segmentsToPrompt / convertPiHistory）。
 *
 * 新增 badge 类型只需在此判别联合加一个 case + 渲染层加一个分支，
 * 不需要改正则、加 Message 字段、改 send 链路签名。
 */

/**
 * Segment 判别联合。type 字段是判别器（discriminant），switch(type) 可穷尽检查。
 *
 * - text: 纯文本段（用户输入的文字）
 * - skill: skill 命令段（/skill:xxx），含 name 和可选的 SKILL.md 文件路径
 * - file: 文件引用段（未来从 drawer/diff 选取追加到 composer），含路径和可选行范围
 * - mention: @mention 段（未来 @user 等），含 name
 */
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; location?: string }
  | { type: 'file'; path: string; lineRange?: [number, number] }
  | { type: 'mention'; name: string }

/**
 * Segment[] → 纯文本（归一化展示用）。
 *
 * skill → `/skill:name`，file → `path`，mention → `@name`，text → 原文。
 * skill 段后若紧跟 text 段，中间补一个空格分隔（修复零宽空格被过滤导致的粘连 bug）。
 *
 * 注意：与 segmentsToPrompt 当前实现相同，但语义分离——
 * 未来若 pi prompt 格式与展示格式需要不同处理（如 file 段发 pi 需包 <file> 标签），
 * 只改 segmentsToPrompt 不影响显示。
 */
export function segmentsToText(segments: Segment[]): string {
  if (segments.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const prev = i > 0 ? segments[i - 1] : null
    switch (seg.type) {
      case 'text':
        // 前一个 segment 是 chip 类（skill/file/mention）且当前 text 不以空格开头时，补空格
        if (prev && prev.type !== 'text' && seg.text && !seg.text.startsWith(' ')) {
          parts.push(' ')
        }
        parts.push(seg.text)
        break
      case 'skill':
        parts.push(`/skill:${seg.name}`)
        break
      case 'file': {
        // D2 格式：行范围序列化（path:L<n> 单行 / path:L<s>-L<e> 多行）。
        // lineRange 必须进 prompt 文本，否则 LLM 看不到行号（review M1）。
        let fileText = seg.path
        if (seg.lineRange) {
          // 归一化 lineRange：防负数 / s>e 产出非法 prompt 文本（L0、L5-L3 等）。
          // 输入边界防御——上游 composer/DiffView 正常不会传非法值，此处兜底保证序列化恒合法。
          const [s0, e0] = seg.lineRange
          const s = Math.max(1, s0)
          const e = Math.max(s, e0)
          fileText += s === e ? `:L${s}` : `:L${s}-L${e}`
        }
        parts.push(fileText)
        break
      }
      case 'mention':
        parts.push(`@${seg.name}`)
        break
    }
  }
  return parts.join('')
}

/**
 * 纯文本 → Segment[]（无 badge 时产出单个 text segment）。
 *
 * 用于构造不含 badge 的 user message（如 mock 数据、从纯文本恢复的消息）。
 * 不做反向解析（不从字符串提取 /skill: 前缀）——结构化 segments 应从 composer DOM 直接产出。
 *
 * 已知限制：此函数用于从纯文本恢复 Segment[]（如读取 pi JSONL 历史），不做反向解析——
 * 历史 user message 中的 /skill: 等前缀不会还原为 badge segment。新消息的 badge 由
 * composer DOM 直接产出结构化 segments，不经此函数。历史回读时 badge 信息会丢失，
 * 表现为纯文本展示（不影响功能正确性，仅丢失可视化标记）。
 */
export function textToSegments(text: string): Segment[] {
  if (!text) return []
  return [{ type: 'text', text }]
}

/**
 * Segment[] → pi prompt 字符串（pi 边界序列化）。
 *
 * 基于 segmentsToText 但 trim 首尾空白（pi prompt 不需要尾随换行/空格）。
 * 语义分离：segmentsToText 保留原始格式（含末尾换行），segmentsToPrompt 做发送归一化。
 */
export function segmentsToPrompt(segments: Segment[]): string {
  return segmentsToText(segments).trim()
}

/**
 * 归一化 Message.content（string | Segment[] 联合类型）为纯文本。
 *
 * 所有只需纯文本的消费点统一走此函数，避免每处各自处理联合类型：
 * - string → 直传（assistant/system message）
 * - Segment[] → segmentsToText（user message）
 */
export function normalizeContent(content: string | Segment[]): string {
  return typeof content === 'string' ? content : segmentsToText(content)
}
