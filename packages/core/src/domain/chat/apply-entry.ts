/**
 * applyEntry —— chat 视图态 reducer（data-source-governance W20，D5「单一 reducer 双路喂入」重放侧）。
 *
 * 职责：把 pi session entry（get_entries 返回 / 实时事件重构，W21）逐条投影为 chat 视图态切片。
 * 消息列表 = entry 日志的纯函数——同 entry 序列必得同 state，「live ≡ reload」从构造上成立。
 *
 * 纯度契约（验收权威 w20-acceptance.md 规格锁定 1）：
 * - 无副作用、无时序依赖：不读 Date.now / crypto.randomUUID / Math.random，
 *   消息 id 与缺失 timestamp 全部从 entry 派生（确定性），两次喂入同一序列 state 全等。
 * - 不 mutate 输入 state / entry：toolResult 回填等就地变更点全部 copy-on-write。
 * - console.warn 是可观测性（未知 role / 孤儿 toolResult），不影响确定性——与迁移前行为对齐。
 *
 * 规则迁移源：packages/runtime/src/infra/pi/message-converter.ts 重放路径
 * （convertSinglePiMessage 的 content parts 解析 / skill block 剖离 / usage / fileChanges 静态提取、
 * convertPiHistory 的 toolResult 窗口局部配对 / compactionSummary / custom / branchSummary /
 * bashExecution 分支）。runtime 保留 wire 层职责（RPC reply → entry 列表 → 喂本 reducer，
 * 见 message-converter.ts liftHistoryToEntries），派生规则唯一实现在此（D7 投影一次）。
 *
 * [已知分叉，收敛待后续 wave] stripAnsi/normalizePiToolResult 与 runtime
 * infra/pi/normalize-tool-result.ts（event-adapter 实时路径 hook 上下文消费）仍为两份：
 * core 不依赖 runtime（包依赖方向）。W21 起 core 版已导出（effects/registry 的
 * tool_call_end overlay 收口消费，输入语义 = toolResult message body），shared 收敛
 * 留待后续 wave 统一处理。W5（2026-08-20）images 提取差异已消除——两份行为对齐
 * （此前 core 副本丢 toolResult content 的 ImageContent → 图片工具结果重开消失，
 * 破 live≡replay；审计 #3，pi-assumption-remediation）。
 *
 * 本文件自包含约束（runtime tsup 打包 / renderer vite 消费双重入口）：
 * 只 import '@xyz-agent/shared'，不 import core 内其他模块（防 vue 依赖渗入 runtime bundle）。
 */
import type {
  ContentBlock,
  FileChange,
  Message,
  PiEntry,
  PiEntryBase,
  PiMessageBody,
  Segment,
  ThinkingBlock,
  ToolCall,
} from '@xyz-agent/shared'
import { textToSegments, COMPLETE_NOTIFY_CUSTOM_TYPES } from '@xyz-agent/shared'

// ── pi entry 类型（W21 下沉 shared/pi-entry.ts，此处 re-export 保持 core API 兼容）───────
//
// 下沉动机：entry 形态成为三方共用 wire 契约（runtime event-adapter 实时重构 /
// protocol.ts message.* payload 类型 / 本 reducer 输入），shared 是唯一不破坏包依赖
// 方向的归属地。类型定义与注释见 @xyz-agent/shared/pi-entry.ts。
//
// 与 runtime infra/pi/pi-protocol.ts 的 PiSessionEntry 结构兼容（TS 结构类型，runtime 侧
// 无需 import 本文件类型即可喂入）。pi 还有 thinking_level_change / model_change /
// session_info 三个 entry 类型，xyz-agent 未建模——reducer 对未建模 type 走 default no-op
// （不丢弃 entry 语义 = 不崩溃不吞整个重放，见 default 分支注释）。
//
// id 可选的原因：pi 真实 entry 恒有 id（uuidv7）；wire 层 lift 无真实 entry id 的伪消息
// （get_messages 扁平列表 / __entryId 缺失）与实时路径 message_end 重构（pi 在 emit 之后才
// appendMessage 分配 id）均为 undefined——此时 piEntryId 不回填（对齐迁移前 convertPiHistory
// 的 entryIds?.[i] ?? __entryId 解析语义），reducer 按 `e<N>` 确定性派生。
export type {
  PiEntry,
  PiEntryBase,
  PiMessageEntry,
  PiMessageBody,
  PiCustomEntry,
  PiLabelEntry,
  PiCompactionEntry,
  PiBranchSummaryEntry,
  PiCustomMessageEntry,
} from '@xyz-agent/shared'

/** toolResult role 的窄化 body（role 字面量收窄后构造，供 orphan 收集的类型自洽）。 */
interface PiToolResultBody extends PiMessageBody {
  role: 'toolResult'
}

/** xyz-client-msg-id extension 写入的 customType 常量（与 extension 端字符串严格一致）。 */
const CLIENT_MSG_ID_TYPE = 'xyz.client-msg-id'

// ── chat 视图态切片 ─────────────────────────────────────────────────

/**
 * reducer 的 state：chat 视图态切片（plan W20 步骤 1）。
 *
 * W20 重放侧从 entry 日志可推导的字段集：messages + clientUuidMap + orphanToolResults。
 * queueDepth / subagents 等 runtime 实时态不可从 entry 重放推导（W21+ 实时喂入侧扩展），
 * 按「不加推测性功能」原则不预置空字段。
 */
export interface ChatViewState {
  /** 重建出的消息列表（entry 日志的投影，按 apply 顺序追加） */
  messages: Message[]
  /** userEntryId → clientUuid（"xyz.client-msg-id" custom entry 累积，badge 回填查表用） */
  clientUuidMap: Map<string, string>
  /** 窗口内无法配对的孤儿 toolResult（增量合并阶段按 toolCallId 回填，W20 review Fix-1 语义） */
  orphanToolResults: PiToolResultBody[]
  /**
   * reducer 簿记：最近一条带 toolCalls 的消息在 messages 中的下标（-1 = 无）。
   * toolResult 窗口局部配对的查找锚点（迁移前 convertPiHistory 同名局部变量语义）。
   */
  lastAssistantWithToolCalls: number
}

/** 初始 state（重放起点）。 */
export function createInitialChatViewState(): ChatViewState {
  return {
    messages: [],
    clientUuidMap: new Map(),
    orphanToolResults: [],
    lastAssistantWithToolCalls: -1,
  }
}

// ── 确定性派生工具 ───────────────────────────────────────────────────

/** ISO string → ms；非字符串（类型异常）兜底 0（pi entry.timestamp 契约恒为 string）。 */
function toMs(timestamp: string): number {
  const ms = new Date(timestamp).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/**
 * 本条 entry 派生 Message 的确定性 id 基。
 * entry.id 缺失（lift 的无 id 伪消息）时用「即将追加的消息下标」——同一序列内确定性且唯一
 * （真实 entry.id 是 uuidv7，与 'e<N>' 命名空间无碰撞）。
 */
function deriveBaseId(entry: PiEntryBase, state: ChatViewState): string {
  return entry.id ?? `e${state.messages.length}`
}

/** unknown → Record 守卫（details 透传用；数组也放行——迁移前 custom details 是 cast 透传）。 */
function isLooseRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** unknown → 非数组 Record 守卫（toolResult details 透传用，迁移前显式排除数组）。 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── stripAnsi / normalizePiToolResult（迁移自 runtime normalize-tool-result.ts）──────
//
// 迁移副本（非 import）：core 包不依赖 runtime（包依赖方向），而 reducer 需要归一规则。
// 实时路径 SSOT 仍在 runtime normalize-tool-result.ts（event-adapter 消费，W21 领地），
// 两份并存是 W20 的已知分叉，收敛到 shared 留待后续 wave（见文件头注释）。

const ANSI_REGEX = /\x1b\[[0-9;]*m/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

/** 归一后的工具结果（镜像 runtime NormalizedToolResult；W5 起含 images，行为对齐）。 */
export interface NormalizedToolResult {
  output: string
  outputRaw?: string
  /**
   * 提取出的 image 块（来自 content-array 的 type==='image' 块，过滤空 data）。
   * W5 对齐 runtime 版：pi ToolResultMessage.content 是 (TextContent | ImageContent)[]
   * （pi-ai types.d.ts ToolResultMessage），extension 工具可返回 image block。
   */
  images?: Array<{ data: string; mimeType: string }>
}

/**
 * 工具产出三态归一（string / content block 数组 / 对象 → output + outputRaw + images）。
 * [W21] 导出供 effects/registry 消费（tool_call_end 的 entry.message.content 是原始
 * 产出——与 pi 持久化 toolResult entry 同构，归一化在消费侧做）；本文件 reducer 的
 * computeToolCallFill 同源调用。
 * [W5] content-array 分支的 image 块提取与 runtime 版逐字对齐（images 差异消除，
 * 见文件头分叉注释）。
 */
export function normalizePiToolResult(raw: unknown): NormalizedToolResult {
  let output: string
  let outputRaw: string | undefined
  let images: Array<{ data: string; mimeType: string }> | undefined

  if (typeof raw === 'string') {
    output = stripAnsi(raw)
    if (output !== raw) outputRaw = raw
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).content)) {
    const contentArr = (raw as Record<string, unknown>).content as Array<Record<string, unknown>>
    const rawText = contentArr
      .filter((c) => c.type === 'text')
      .map((c) => (c.text as string) ?? '')
      .join('\n')
    output = stripAnsi(rawText)
    if (output !== rawText) outputRaw = rawText
    const imageBlocks = contentArr
      .filter((c) => c.type === 'image')
      .map((c) => ({ data: String(c.data ?? ''), mimeType: String(c.mimeType ?? '') }))
      .filter((img) => img.data !== '' || img.mimeType !== '')
    if (imageBlocks.length > 0) images = imageBlocks
  } else if (raw != null) {
    output = JSON.stringify(raw)
  } else {
    output = ''
  }

  return { output, outputRaw, images }
}

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

/**
 * 转换单条 message entry 体为 xyz Message（user/assistant）。
 * 未知 role → warn + null（调用方跳过；迁移前 convertSinglePiMessage 同语义）。
 *
 * @param entryId 真实 pi entry id（无则 undefined——piEntryId 不回填）
 * @param baseId 消息确定性 id 基（entryId ?? 下标派生，见 deriveBaseId）
 */
function convertMessageBody(
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
  const parts: PiContentPart[] = Array.isArray(body.content)
    ? (body.content as PiContentPart[])
    : [{ type: 'text', text: body.content != null ? String(body.content) : '' }]
  let textContent = ''
  const thinking: ThinkingBlock[] = []
  const toolCalls: ToolCall[] = []
  const contentBlocks: ContentBlock[] = []
  // [W5] user 消息 image part 收集（pi UserMessage.content 可为 (TextContent | ImageContent)[]
  // ——pi-ai types.d.ts UserMessage；xyz 发送路径走 segments 路径模式不经此形态，但
  // extension sendMessage images 通道 / 外部手写 session 文件可达，此前静默丢弃无 warn。
  // Segment image 是磁盘路径形态，与 base64 ImageContent 不可互转 → 保 images 字段不丢）。
  const imageParts: Array<{ data: string; mimeType: string }> = []
  // text 块只 push 一次的哨兵（多次 text part 只累加不重复 push，perf-w20 微项 2 同优化）。
  let hasTextBlock = false

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type === 'text') {
      textContent += part.text ?? ''
      // text 块按真实到达顺序 push（首次遇到时 push 一次）。contentIndex = parts 下标
      //（pi content array 顺序），与 streaming 路径对称（§11 检查点 3）。
      if (!hasTextBlock) {
        hasTextBlock = true
        contentBlocks.push({ type: 'text', refId: 'text', contentIndex: i })
      }
    } else if (part.type === 'thinking') {
      const thkId = `${baseId}-th${i}`
      thinking.push({
        id: thkId,
        content: part.thinking ?? '',
        collapsed: true,
      })
      contentBlocks.push({ type: 'thinking', refId: thkId, contentIndex: i })
    } else if (part.type === 'toolCall' || part.type === 'tool_use') {
      const tcId = part.id ?? `${baseId}-tc${i}`
      toolCalls.push({
        id: tcId,
        toolName: part.name ?? '',
        input: part.arguments ?? {},
        status: 'completed',
        startTime: body.timestamp ?? fallbackTs,
      })
      contentBlocks.push({ type: 'toolCall', refId: tcId, contentIndex: i })
    } else if (part.type === 'image') {
      // 提取语义与 normalizePiToolResult 的 image 块一致（data/mimeType String 归一，
      // 过滤双空）；不进 contentBlocks（ContentBlockType 无 image，保序渲染归后续 wave）。
      const img = { data: String(part.data ?? ''), mimeType: String(part.mimeType ?? '') }
      if (img.data !== '' || img.mimeType !== '') imageParts.push(img)
    }
  }

  const msg: Message = {
    id: baseId,
    role: body.role === 'user' ? 'user' : 'assistant',
    content: textContent,
    status: 'complete',
    timestamp: body.timestamp ?? fallbackTs,
    // piEntryId：fork 定位截断点用（RPC 路径无此字段时 fallback 读 JSONL 按 timestamp 匹配）
    ...(entryId !== undefined && { piEntryId: entryId }),
    ...(thinking.length > 0 && { thinking }),
    ...(toolCalls.length > 0 && { toolCalls }),
    ...(contentBlocks.length > 0 && { contentBlocks }),
    // [W5] user 消息 image part → images 保字段：shared.Message 暂无 images 类型声明
    //（W5 边界未动 shared），spread 保运行时字段（数据不丢优先），渲染消费与类型
    // 声明待后续 wave shared 加字段后收口。
    ...(imageParts.length > 0 && { images: imageParts }),
    // [W6 #9 G5] 历史路径还原 fileChanges（write/edit 工具静态提取，AC-9.1/9.3）
    ...(body.role === 'assistant' && toolCalls.length > 0 && (() => {
      const fc = extractHistoryFileChanges(toolCalls)
      return fc.length > 0 ? { fileChanges: fc } : {}
    })()),
    // Extract usage from pi assistant messages (input/output token counts)
    ...(() => {
      if (body.role !== 'assistant') return {}
      const u = body.usage
      if (!isLooseRecord(u)) return {}
      const input = typeof u.input === 'number' ? u.input : undefined
      const output = typeof u.output === 'number' ? u.output : undefined
      return { usage: { inputTokens: input ?? 0, outputTokens: output ?? 0 } }
    })(),
  }

  // For user messages, parse <skill> blocks injected by pi backend.
  // content 统一为 Segment[]：有 skill 标签时拆出 skill segment + 后续 user text，
  // 无 skill 标签时用 textToSegments 包成纯 text segment。
  if (body.role === 'user' && textContent) {
    const parsed = parseSkillBlock(textContent)
    if (parsed) {
      msg.content = parsed
    } else {
      msg.content = textToSegments(textContent)
    }
  }
  return msg
}

// ── toolResult 回填（迁移自 fillToolCallOutput，copy-on-write 化）──────────────

/** 计算 toolResult 回填字段（不含 id 匹配；返回增量字段对象）。 */
function computeToolCallFill(body: PiMessageBody): {
  output: string
  outputRaw?: string
  isError: boolean
  details?: Record<string, unknown>
  /** [W5] toolResult content 的 ImageContent 块（live≡replay：此前仅实时路径可见）。 */
  images?: Array<{ data: string; mimeType: string }>
} {
  const { output, outputRaw, images } = normalizePiToolResult(body)
  const isError = body.isError === true
  // F1 透传 details（含 __gui__），排除数组形态（迁移前显式判定，规则 7.5 可重开恢复）。
  const details = isPlainRecord(body.details) ? body.details : undefined
  return { output, outputRaw, isError, details, images }
}

// ── reducer 本体 ────────────────────────────────────────────────────

/**
 * 单条 pi entry → chat 视图态切片的纯函数投影（D5）。
 *
 * case 覆盖（pi SessionEntry 全集）：message（role 细分 user/assistant/toolResult/
 * bashExecution）/ custom / label / compaction / branch_summary / custom_message；
 * 未建模类型（thinking_level_change / model_change / session_info / 未来的新类型）走
 * default no-op——「converter 不丢弃任何 pi entry 类型」（父文档规则 #9）指不崩溃、
 * 不中断重放、不静默吞掉后续 entry；元数据类 entry 本身不产出对话流消息。
 */
export function applyEntry(state: ChatViewState, entry: PiEntry): ChatViewState {
  switch (entry.type) {
    case 'message': {
      const body = entry.message
      const entryId = entry.id
      const baseId = deriveBaseId(entry, state)
      const fallbackTs = toMs(entry.timestamp)

      // message entry 的 role 细分（pi AgentMessage 联合镜像：user/assistant/toolResult/
      // bashExecution/compactionSummary/custom/branchSummary）。后三个特殊 role 与专用
      // entry 类型（compaction/branch_summary/custom_message）双形态存储（session-manager
      // 持久化为 message entry / 专用 entry 均存在；get_messages / mapSessionEntries 的
      // message-entry 透传路径会以本形态到达）。语义与专用 entry case 的差异只有一点：
      // display 覆写归专用 custom_message entry case（mapSessionEntries SSOT 同规则），
      // message-role 形态到达时上游已完成或不适用覆写——迁移前 convertPiHistory 同行为。
      switch (body.role) {
        case 'toolResult': {
          // 窗口局部配对：只查最近一条带 toolCalls 的消息（迁移前 lastAssistantWithToolCalls 语义）
          const last = state.lastAssistantWithToolCalls
          const host = last >= 0 ? state.messages[last] : undefined
          const tcs = host?.toolCalls
          const matched = tcs?.find((t) => t.id === body.toolCallId)
          if (host !== undefined && tcs !== undefined && matched !== undefined) {
            const fill = computeToolCallFill(body)
            const filled: ToolCall = {
              ...matched,
              output: fill.output,
              ...(fill.outputRaw !== undefined && { outputRaw: fill.outputRaw }),
              ...(fill.isError && { status: 'error' as const }),
              ...(fill.details !== undefined && { details: fill.details }),
              // [W5] images 保字段：shared.ToolCall 暂无 images 类型声明（W5 边界未动
              // shared），spread 条件属性保运行时字段——数据不丢优先（live≡replay），
              // 类型声明与渲染消费待后续 wave shared 加字段后收口。
              ...(fill.images !== undefined && { images: fill.images }),
            }
            const updatedHost: Message = { ...host, toolCalls: tcs.map((t) => (t === matched ? filled : t)) }
            const messages = state.messages.map((m, idx) => (idx === last ? updatedHost : m))
            return { ...state, messages }
          }
          // 孤儿：窗口内无 preceding assistant 或 toolCallId 无匹配——收集给增量合并阶段回填
          const orphan: PiToolResultBody = { ...body, role: 'toolResult' }
          console.warn(`[apply-entry] toolResult has no matching toolCall in window: ${String(body.toolCallId)}`)
          return { ...state, orphanToolResults: [...state.orphanToolResults, orphan] }
        }

        case 'bashExecution': {
          // bash 是元信息非用户输入（W3 WC5）→ 带 bashExecution 字段的 system 消息。
          // exitCode undefined → null（防 JSON 丢值，与 dispatcher 广播对称）。
          const ts = body.timestamp ?? fallbackTs
          const msg: Message = {
            id: baseId,
            role: 'system',
            content: '',
            status: 'complete',
            timestamp: ts,
            bashExecution: {
              command: typeof body.command === 'string' ? body.command : '',
              output: typeof body.output === 'string' ? body.output : '',
              exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
              cancelled: body.cancelled === true,
              truncated: body.truncated === true,
              excludeFromContext: body.excludeFromContext === true,
              timestamp: ts,
              ...(typeof body.fullOutputPath === 'string' && { fullOutputPath: body.fullOutputPath }),
            },
          }
          return { ...state, messages: [...state.messages, msg] }
        }

        case 'compactionSummary': {
          const ts = body.timestamp ?? fallbackTs
          const summary = typeof body.summary === 'string' ? body.summary : undefined
          const tokensBefore = typeof body.tokensBefore === 'number' ? body.tokensBefore : undefined
          const msg: Message = {
            id: baseId,
            role: 'system',
            content: summary ?? '上下文已压缩',
            status: 'complete',
            compactionSummary: { summary, tokensBefore, timestamp: ts },
            timestamp: ts,
          }
          return { ...state, messages: [...state.messages, msg] }
        }

        case 'custom': {
          // custom message（pi CustomMessage，扩展经 sendMessage 注入）。details 原始透传
          //（__gui__ 等由前端消费）；display 透传（不覆写——见上方形态差异注释）。
          const ts = body.timestamp ?? fallbackTs
          const msg: Message = {
            id: baseId,
            role: 'system',
            content: typeof body.content === 'string' ? body.content : '',
            status: 'complete',
            customType: typeof body.customType === 'string' ? body.customType : '',
            details: isLooseRecord(body.details) ? body.details : undefined,
            timestamp: ts,
            display: body.display === true || body.display === false ? body.display : undefined,
          }
          return { ...state, messages: [...state.messages, msg] }
        }

        case 'branchSummary': {
          const ts = body.timestamp ?? fallbackTs
          const rawSummary = typeof body.summary === 'string' ? body.summary : undefined
          const msg: Message = {
            id: baseId,
            role: 'system',
            content: rawSummary ?? '',
            status: 'complete',
            branchSummary: {
              summary: rawSummary,
              fromId: typeof body.fromId === 'string' ? body.fromId : undefined,
              timestamp: ts,
            },
            timestamp: ts,
          }
          return { ...state, messages: [...state.messages, msg] }
        }

        case 'user':
        case 'assistant': {
          const msg = convertMessageBody(body, entryId, baseId, fallbackTs)
          if (!msg) return state
          const messages = [...state.messages, msg]
          const next: ChatViewState = { ...state, messages }
          if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
            next.lastAssistantWithToolCalls = messages.length - 1
          }
          return next
        }

        default: {
          // 显式拒绝未知 role（W11 语义）：非已建模 role 不默认归 assistant，防数据异常被掩盖
          console.warn(`[apply-entry] unknown role: ${String(body.role)}, skipping`)
          return state
        }
      }
    }

    case 'compaction': {
      // pi 压缩记录 → system 消息 + compactionSummary 字段（SystemNotice「上下文已压缩」）
      const ts = toMs(entry.timestamp)
      const summary = typeof entry.summary === 'string' ? entry.summary : undefined
      const tokensBefore = typeof entry.tokensBefore === 'number' ? entry.tokensBefore : undefined
      const msg: Message = {
        id: deriveBaseId(entry, state),
        role: 'system',
        content: summary ?? '上下文已压缩',
        status: 'complete',
        compactionSummary: {
          summary,
          tokensBefore,
          timestamp: ts,
        },
        timestamp: ts,
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'branch_summary': {
      // summary 原值透传（'' 保留 ''，缺失 → undefined），content 缺失 fallback 空字符串——
      // 与迁移前 branchSummary 分支逐字段对齐。
      const ts = toMs(entry.timestamp)
      const rawSummary = typeof entry.summary === 'string' ? entry.summary : undefined
      const msg: Message = {
        id: deriveBaseId(entry, state),
        role: 'system',
        content: rawSummary ?? '',
        status: 'complete',
        branchSummary: {
          summary: rawSummary,
          fromId: entry.fromId,
          timestamp: ts,
        },
        timestamp: ts,
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'custom_message': {
      // 扩展经 sendMessage 注入的结构化通知 → system 消息（details 原始透传，__gui__ 前端消费）。
      // 完成通知类 customType display 覆写 false（pi 可能持久化 true，xyz-agent 统一隐藏——
      // 与 mapSessionEntries 引用同一 SSOT，覆写幂等）。
      const ts = toMs(entry.timestamp)
      const isCompleteNotify = COMPLETE_NOTIFY_CUSTOM_TYPES.has(entry.customType)
      const display = entry.display === true || entry.display === false ? entry.display : undefined
      const msg: Message = {
        id: deriveBaseId(entry, state),
        role: 'system',
        content: typeof entry.content === 'string' ? entry.content : '',
        status: 'complete',
        customType: entry.customType,
        details: isLooseRecord(entry.details) ? entry.details : undefined,
        timestamp: ts,
        display: isCompleteNotify ? false : display,
      }
      return { ...state, messages: [...state.messages, msg] }
    }

    case 'custom': {
      // 纯数据 entry：不进对话流。xyz.client-msg-id 累积 clientUuidMap（badge 回填查表）。
      // data 形状不匹配（缺字段/类型错）→ 跳过（降级不崩溃）；冲突 later-wins（warn 防御）。
      if (entry.customType !== CLIENT_MSG_ID_TYPE) return state
      const data = entry.data
      if (!isPlainRecord(data) || typeof data.clientUuid !== 'string' || typeof data.userEntryId !== 'string') {
        return state
      }
      const existing = state.clientUuidMap.get(data.userEntryId)
      if (existing !== undefined && existing !== data.clientUuid) {
        console.warn(
          `[apply-entry] clientUuidMap conflict for userEntryId=${data.userEntryId}: ` +
          `existing=${existing}, new=${data.clientUuid} (later wins)`,
        )
      }
      const clientUuidMap = new Map(state.clientUuidMap)
      clientUuidMap.set(data.userEntryId, data.clientUuid)
      return { ...state, clientUuidMap }
    }

    case 'label': {
      // 用户书签/标记：重放侧无对话流投影，显式 no-op（规则 #9：有 case、不丢弃、不崩溃）。
      return state
    }

    default: {
      // 未建模 entry 类型（thinking_level_change / model_change / session_info / pi 未来新增）
      // → no-op。重放不中断，后续 entry 照常投影；类型清单见 pi session-manager.ts SessionEntry。
      return state
    }
  }
}

/**
 * 逐条 fold entry 序列 → 最终视图态（重放驱动器）。
 *
 * 文件重放路径（getHistory → hydrate，W20）与实时 feed（W21）共用的喂入形态：
 * `entries.reduce(applyEntry, initial ?? createInitialChatViewState())` 的显式封装。
 */
export function replayEntries(entries: PiEntry[], initial?: ChatViewState): ChatViewState {
  let state = initial ?? createInitialChatViewState()
  for (const entry of entries) {
    state = applyEntry(state, entry)
  }
  return state
}
