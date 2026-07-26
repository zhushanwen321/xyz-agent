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
 * - image: 图片附件段（Cmd+V 粘贴的截图等）：
 *   - id：composer chip 的稳定唯一标识（crypto.randomUUID），同一文件附两次时供
 *     ContextChipsBar :key 区分（path 会重复）
 *   - path：磁盘绝对路径（tmpdir 下落盘文件），不变
 *   - fileName：磁盘文件全名（含 uuid 前缀，如 `dbfdb3c8-...-image.png`），用于磁盘定位/日志
 *   - displayName：用户可读名（如 `截图-20260725-1530.png` 或 `照片.png`），用于 badge/
 *     占位/缩略图 alt 显示
 *   - needsMigrate：是否需要 tmpdir → attachments 迁移。只有 landing 态 writeSessionImage
 *     落 OS tmpdir 的图才标记 true（session 创建后需迁移到 attachments 持久化）。
 *     +菜单选的用户磁盘文件、normal 态 writeSessionImage 落 attachments 的图，都不设
 *     （undefined 等同 false）。迁移判断用此字段，不猜路径（避免把用户磁盘文件误当
 *     tmpdir 文件被 renameSync 移走——数据丢失）。
 *   segmentsToText 把 path 裸路径插进 prompt 文本（对齐 pi TUI），LLM 自己调 read 工具
 *   读路径（vision/非 vision 模型都能处理）。不走 base64 message.send.images 通道。
 */
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; location?: string }
  | { type: 'file'; path: string; lineRange?: [number, number] }
  | { type: 'mention'; name: string }
  | { type: 'image'; id: string; path: string; fileName: string; displayName: string; needsMigrate?: boolean }

/**
 * Segment[] → 纯文本（归一化展示用 + pi prompt 序列化的唯一实现）。
 *
 * skill → `/skill:name`，file → `path`（可选 `:L<s>-L<e>` 行范围），mention → `@name`，
 * text → 原文，image → 裸 path 独占一行（对齐 pi TUI，LLM 自己调 read 工具读）。
 * skill 段后若紧跟 text 段，中间补一个空格分隔（修复零宽空格被过滤导致的粘连 bug）。
 * image 后紧跟 text 不补空格（image 产出的 `\n${path}\n` 已有换行分隔，再补空格会污染行首）。
 *
 * 收敛说明：原本 segmentsToPrompt 与 segmentsToText 分两份实现，因为 file inline 需要
 * fileContexts Map 才分开。删除 file inline 后，所有 segment 序列化收敛到本函数一处，
 * segmentsToPrompt 仅是 trim 包装。展示格式（含末尾换行）与 pi prompt 格式（trim）的差异
 * 由调用方决定是否 trim，不再分两份逻辑。
 */
export function segmentsToText(segments: Segment[]): string {
  if (segments.length === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const prev = i > 0 ? segments[i - 1] : null
    // chip→chip / chip→text 边界补空格（skill→file / file→mention / skill→text 等）
    if (prev && prev.type !== 'text' && seg.type !== 'text') {
      parts.push(' ')
    }
    switch (seg.type) {
      case 'text':
        // 前一个 segment 是 chip 类（skill/file/mention）且当前 text 不以空格开头时，补空格分隔。
        // 但 image 段例外——image 产出 `\n${path}\n`（前后已有换行），紧跟的 text 不需要再补空格，
        // 否则产出 `\n/path\n 文本`（行首空格污染 pi prompt）。
        if (
          prev &&
          prev.type !== 'text' &&
          prev.type !== 'image' && // image 已有 \n 分隔，不补空格
          seg.text &&
          !seg.text.startsWith(' ')
        ) {
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
      case 'image':
        // 对齐 pi TUI 粘贴行为：裸路径进 prompt 文本，LLM 自己调 read 工具读。
        // 与 pi TUI（insertTextAtCursor 裸路径粘在光标处）的细微差异：xyz-agent 让每个图片
        // 路径独占一行（前后补换行），LLM 更易解析路径边界，多图时每行一个。
        // 不再用 [图片 N] 匿名占位——该占位对 LLM 无意义（非 vision 模型看不到图，
        // vision 模型不需要锚点），且会被 LLM 当文件名瞎找。
        // 图片持久化在 <dataDir>/attachments/<sessionId>/（非 pi TUI 的 /tmp），切换 session 不丢。
        parts.push(`\n${seg.path}\n`)
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
 * 删除 file inline 后，所有 segment 序列化逻辑收敛到 segmentsToText 一处，
 * 本函数只是 trim 包装：pi prompt 不需要首尾空白（尾随换行/空格）。
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
