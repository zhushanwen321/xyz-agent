/**
 * apply-entry 模块群 · message body 转换群（apply-entry.ts + apply-entry-convert.ts +
 * apply-entry-utils.ts 三件套）。
 *
 * 本文件承载 message entry 体 → xyz Message 的转换链（content parts 解析 / skill block
 * 剖离 / usage / fileChanges 静态提取 / user-assistant 转换）与 toolResult 回填字段计算
 * （computeToolCallFill）。reducer 本体（apply* handler / applyEntry / replayEntries）在
 * apply-entry.ts，共享底层在 apply-entry-utils.ts；规则迁移源叙事见 apply-entry.ts 文件头。
 *
 * 本模块群自包含约束（runtime tsup 打包 / renderer vite 消费双重入口）：本模块群
 * （apply-entry.ts + apply-entry-convert.ts + apply-entry-utils.ts）只 import
 * '@xyz-agent/shared' 与群内文件，不 import core 内群外模块（防 vue 依赖渗入 runtime bundle）。
 * 依赖单向：本文件 → utils（apply-entry.ts → 本文件 + utils），禁止反向 import / 循环。
 */
import type {
  ContentBlock,
  FileChange,
  Message,
  PiMessageBody,
  Segment,
  ThinkingBlock,
  ToolCall,
} from '@xyz-agent/shared'
import { textToSegments } from '@xyz-agent/shared'

import { isLooseRecord, isPlainRecord, normalizePiToolResult } from './apply-entry-utils'

// ── user 消息 skill block 剖离（迁移自 message-converter parseSkillBlock）──────────

/**
 * Parse `<skill name="xxx" location="...">...</skill>` blocks from
 * a user message's text content. Returns the extracted skill segment and the
 * remaining user text; `null` if no skill block is found.
 */
function parseSkillBlock(text: string): Segment[] | null {
  const match = text.match(/<skill\s+name="([^"]+)"(?:\s+location="([^"]+)")?[^>]*>[\s\S]*?<\/skill>([\s\S]*)$/)
  if (!match) return null
  const skillSeg: Segment = match[2]
    ? { type: 'skill', name: match[1], location: match[2] }
    : { type: 'skill', name: match[1] }
  const segments: Segment[] = [skillSeg]
  const userText = match[3].trim()
  if (userText) {
    segments.push({ type: 'text', text: userText })
  }
  return segments
}

// ── assistant toolCalls → fileChanges 静态提取（迁移自 extractHistoryFileChanges）──────
//
// 历史路径无 cwd 做 existsSync 判定：write 一律 modified（AC-9.3 graceful），
// edit 恒 modified。filePath 取 toolCall.arguments.path（file_path 防御 fallback）。
// 下方工具名集合刻意宽匹配（历史数据含 write_file/str_replace 等别名）。

const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'writeFile', 'create_file'])
const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'editFile', 'str_replace', 'replace'])

function extractHistoryFileChanges(toolCalls: ToolCall[]): FileChange[] {
  const changes: FileChange[] = []
  const seen = new Set<string>()
  for (const tc of toolCalls) {
    const isWrite = WRITE_TOOL_NAMES.has(tc.toolName)
    const isEdit = EDIT_TOOL_NAMES.has(tc.toolName)
    if (!isWrite && !isEdit) continue
    const args = (tc.input ?? {}) as Record<string, unknown>
    const filePath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : ''
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)
    changes.push({ filePath, status: 'modified' })
  }
  return changes
}

// ── message entry 体 → Message（迁移自 convertSinglePiMessage）───────────────

/** message entry 的 content 数组元素（宽形态，读取点运行时守卫）。 */
interface PiContentPart {
  type: string
  text?: string
  thinking?: string
  /** [W5] image 块（pi ImageContent：base64 data + mimeType），user 消息可含。 */
  data?: string
  mimeType?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

/** content parts 归集产物（按 part kind 分派收集的中间态，构造 Message 用）。 */
interface CollectedContent {
  /** text part 累加合并后的纯文本（多次 text part 拼接） */
  textContent: string
  thinking: ThinkingBlock[]
  toolCalls: ToolCall[]
  contentBlocks: ContentBlock[]
  /**
   * [W5] user 消息 image part 收集（pi UserMessage.content 可为 (TextContent | ImageContent)[]
   * ——pi-ai types.d.ts UserMessage；xyz 发送路径走 segments 路径模式不经此形态，但
   * extension sendMessage images 通道 / 外部手写 session 文件可达，此前静默丢弃无 warn。
   * Segment image 是磁盘路径形态，与 base64 ImageContent 不可互转 → 保 images 字段不丢）。
   */
  imageParts: Array<{ data: string; mimeType: string }>
  /** text 块只 push 一次的哨兵（多次 text part 只累加不重复 push，perf-w20 微项 2 同优化）。 */
  hasTextBlock: boolean
}

/** body.content 宽形态归一：数组原样透传，非数组包成单 text part（null → ''）。 */
function normalizeContentParts(body: PiMessageBody): PiContentPart[] {
  return Array.isArray(body.content)
    ? (body.content as PiContentPart[])
    : [{ type: 'text', text: body.content != null ? String(body.content) : '' }]
}

function collectTextPart(part: PiContentPart, index: number, acc: CollectedContent): void {
  acc.textContent += part.text ?? ''
  // text 块按真实到达顺序 push（首次遇到时 push 一次）。contentIndex = parts 下标
  //（pi content array 顺序），与 streaming 路径对称（§11 检查点 3）。
  if (!acc.hasTextBlock) {
    acc.hasTextBlock = true
    acc.contentBlocks.push({ type: 'text', refId: 'text', contentIndex: index })
  }
}

function collectThinkingPart(part: PiContentPart, index: number, baseId: string, acc: CollectedContent): void {
  const thkId = `${baseId}-th${index}`
  acc.thinking.push({
    id: thkId,
    content: part.thinking ?? '',
    collapsed: true,
  })
  acc.contentBlocks.push({ type: 'thinking', refId: thkId, contentIndex: index })
}

function collectToolCallPart(
  part: PiContentPart,
  index: number,
  baseId: string,
  body: PiMessageBody,
  fallbackTs: number,
  acc: CollectedContent,
): void {
  const tcId = part.id ?? `${baseId}-tc${index}`
  acc.toolCalls.push({
    id: tcId,
    toolName: part.name ?? '',
    input: part.arguments ?? {},
    status: 'completed',
    startTime: body.timestamp ?? fallbackTs,
  })
  acc.contentBlocks.push({ type: 'toolCall', refId: tcId, contentIndex: index })
}

function collectImagePart(part: PiContentPart, acc: CollectedContent): void {
  // 提取语义与 normalizePiToolResult 的 image 块一致（data/mimeType String 归一，
  // 过滤双空）；不进 contentBlocks（ContentBlockType 无 image，保序渲染归后续 wave）。
  const img = { data: String(part.data ?? ''), mimeType: String(part.mimeType ?? '') }
  if (img.data !== '' || img.mimeType !== '') acc.imageParts.push(img)
}

/** 逐 part 分派收集（text/thinking/toolCall/image 四类，其余 kind 忽略）。 */
function collectContentParts(
  parts: PiContentPart[],
  baseId: string,
  body: PiMessageBody,
  fallbackTs: number,
): CollectedContent {
  const acc: CollectedContent = {
    textContent: '',
    thinking: [],
    toolCalls: [],
    contentBlocks: [],
    imageParts: [],
    hasTextBlock: false,
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type === 'text') {
      collectTextPart(part, i, acc)
    } else if (part.type === 'thinking') {
      collectThinkingPart(part, i, baseId, acc)
    } else if (part.type === 'toolCall' || part.type === 'tool_use') {
      collectToolCallPart(part, i, baseId, body, fallbackTs, acc)
    } else if (part.type === 'image') {
      collectImagePart(part, acc)
    }
  }
  return acc
}

/** [W6 #9 G5] 历史路径还原 fileChanges（write/edit 工具静态提取，AC-9.1/9.3）。 */
function fileChangesField(body: PiMessageBody, toolCalls: ToolCall[]): { fileChanges?: FileChange[] } {
  if (body.role !== 'assistant' || toolCalls.length === 0) return {}
  const fc = extractHistoryFileChanges(toolCalls)
  return fc.length > 0 ? { fileChanges: fc } : {}
}

/** Extract usage from pi assistant messages (input/output token counts)。 */
function usageField(body: PiMessageBody): { usage?: { inputTokens: number; outputTokens: number } } {
  if (body.role !== 'assistant') return {}
  const u = body.usage
  if (!isLooseRecord(u)) return {}
  const input = typeof u.input === 'number' ? u.input : undefined
  const output = typeof u.output === 'number' ? u.output : undefined
  return { usage: { inputTokens: input ?? 0, outputTokens: output ?? 0 } }
}

function buildMessage(
  body: PiMessageBody,
  entryId: string | undefined,
  baseId: string,
  fallbackTs: number,
  acc: CollectedContent,
): Message {
  return {
    id: baseId,
    role: body.role === 'user' ? 'user' : 'assistant',
    content: acc.textContent,
    status: 'complete',
    timestamp: body.timestamp ?? fallbackTs,
    // piEntryId：fork 定位截断点用（RPC 路径无此字段时 fallback 读 JSONL 按 timestamp 匹配）
    ...(entryId !== undefined && { piEntryId: entryId }),
    ...(acc.thinking.length > 0 && { thinking: acc.thinking }),
    ...(acc.toolCalls.length > 0 && { toolCalls: acc.toolCalls }),
    ...(acc.contentBlocks.length > 0 && { contentBlocks: acc.contentBlocks }),
    ...(acc.imageParts.length > 0 && { images: acc.imageParts }),
    ...fileChangesField(body, acc.toolCalls),
    ...usageField(body),
  }
}

/**
 * 转换单条 message entry 体为 xyz Message（user/assistant）。
 * 未知 role → warn + null（调用方跳过；迁移前 convertSinglePiMessage 同语义）。
 *
 * @param entryId 真实 pi entry id（无则 undefined——piEntryId 不回填）
 * @param baseId 消息确定性 id 基（entryId ?? 下标派生，见 deriveBaseId）
 */
export function convertMessageBody(
  body: PiMessageBody,
  entryId: string | undefined,
  baseId: string,
  fallbackTs: number,
): Message | null {
  // 防御性收窄（正常路径由 applyEntry 的 message switch 分派保证只收 user/assistant）：
  // 非 user/assistant 返回 null 调用方跳过；warn 在 switch default 统一发出，此处不重复。
  if (body.role !== 'user' && body.role !== 'assistant') {
    return null
  }
  const acc = collectContentParts(normalizeContentParts(body), baseId, body, fallbackTs)
  const msg = buildMessage(body, entryId, baseId, fallbackTs, acc)

  // For user messages, parse <skill> blocks injected by pi backend.
  // content 统一为 Segment[]：有 skill 标签时拆出 skill segment + 后续 user text，
  // 无 skill 标签时用 textToSegments 包成纯 text segment。
  if (body.role === 'user' && acc.textContent) {
    msg.content = parseSkillBlock(acc.textContent) ?? textToSegments(acc.textContent)
  }
  return msg
}

// ── toolResult 回填（迁移自 fillToolCallOutput，copy-on-write 化）──────────────

/** 计算 toolResult 回填字段（不含 id 匹配；返回增量字段对象）。 */
export function computeToolCallFill(body: PiMessageBody): {
  output: string
  outputRaw?: string
  isError: boolean
  details?: Record<string, unknown>
  /** [W5] toolResult content 的 ImageContent 块（live≡replay：此前仅实时路径可见）。 */
  images?: Array<{ data: string; mimeType: string }>
} {
  const { output, outputRaw, images } = normalizePiToolResult(body)
  const isError = body.isError === true
  // F1 透传 details（含 __gui__），排除数组形态（迁移前显式判定，关键规则 9 可重开恢复）。
  const details = isPlainRecord(body.details) ? body.details : undefined
  return { output, outputRaw, isError, details, images }
}
