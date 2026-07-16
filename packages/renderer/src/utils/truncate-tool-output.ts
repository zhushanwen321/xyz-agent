/**
 * W2 H3：tool result 共享截断工具。
 *
 * 对应 FR-2 + D7/D9/D10/D12 + AC-3/4/10/11/13。
 *
 * 核心策略：
 * - toolName ∈ TRUNCATE_TOOLS（read/bash/cat/grep/glob/list）的 output/outputRaw
 *   按头部 TOOL_OUTPUT_MAX_BYTES(4KB) 截断 + 省略标记
 * - MCP 命名空间前缀（mcp__server__read）按末段匹配（D12）
 * - UTF-8 codepoint 边界对齐，不切断多字节字符（D10/AC-11）
 * - write/edit 不截断（AC-4）
 * - details.__gui__ 结构化数据不截断
 * - ≤4KB 不截断、不加标记
 *
 * 共享入口（D9/SR1）：实时路径（tool_call_end handler）和历史回流路径
 * （hydrate/setMessages）都调用此函数，保证两条路径截断策略一致。
 */
import type { Message } from '@xyz-agent/shared'

/**
 * 需要截断 output 的工具名（D7/AC-4）。
 * 这些工具的 output 可能很大（文件内容、命令输出、搜索结果）。
 */
export const TRUNCATE_TOOLS = new Set([
  'read', 'bash', 'cat', 'grep', 'glob', 'list',
])

/** 截断阈值：4KB（UTF-8 字节，D10） */
export const TOOL_OUTPUT_MAX_BYTES = 4096

/** 截断省略标记（D7） */
const TRUNCATION_MARKER = '\n\n[...output truncated...]'

/**
 * 判断 toolName 是否需要截断（D12 MCP 前缀兼容）。
 * mcp__server__read 按末段匹配 read。
 */
export function shouldTruncate(toolName: string): boolean {
  if (TRUNCATE_TOOLS.has(toolName)) return true
  // MCP 命名空间前缀：按 __ split 取最后一段匹配
  if (toolName.includes('__')) {
    const lastSegment = toolName.split('__').pop()!
    return TRUNCATE_TOOLS.has(lastSegment)
  }
  return false
}

/**
 * UTF-8 续字节位掩码（10xxxxxx = 0x80-0xBF）。
 * 用于 codepoint 边界对齐检测：续字节的高 2 位是 10。
 */
const UTF8_CONTINUATION_MASK = 0xC0
const UTF8_CONTINUATION_PREFIX = 0x80

/**
 * 按 UTF-8 字节截断字符串，在 codepoint 边界对齐（AC-11/D10）。
 * 不切断多字节字符（如 CJK 3 字节字符不会被切成半个）。
 */
export function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8')
  if (buf.length <= maxBytes) return str

  // 从 maxBytes 往前找 codepoint 边界
  // UTF-8 多字节字符：首字节高位是 11xxxxxx，续字节是 10xxxxxx
  // 找到第一个非续字节位置即为 codepoint 起点
  let cutPos = maxBytes
  // 往回找直到不是续字节（10xxxxxx = 0x80-0xBF）
  while (cutPos > 0 && (buf[cutPos] & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX) {
    cutPos--
  }
  return buf.subarray(0, cutPos).toString('utf-8')
}

/**
 * 截断单个 ToolCall 的 output/outputRaw（D7）。
 * 只截断 shouldTruncate(toolName) 的工具，其余原样返回。
 *
 * 截断后**含标记**总字节数 ≤ TOOL_OUTPUT_MAX_BYTES。
 *
 * 导出供 tool_call_end handler 在更新单个 toolCall 时直接调用（实时路径）。
 */
export function truncateToolCall<T extends import('@xyz-agent/shared').ToolCall>(tc: T): T {
  if (!shouldTruncate(tc.toolName)) return tc

  let truncated = false
  const next: Partial<T> = {}
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf-8')
  // 截断体预算 = MAX - marker，保证含标记后总长 ≤ MAX
  const bodyBudget = TOOL_OUTPUT_MAX_BYTES - markerBytes

  if (tc.output !== undefined) {
    const buf = Buffer.from(tc.output, 'utf-8')
    if (buf.length > TOOL_OUTPUT_MAX_BYTES) {
      next.output = truncateToBytes(tc.output, bodyBudget) + TRUNCATION_MARKER
      truncated = true
    }
  }
  if (tc.outputRaw !== undefined) {
    const buf = Buffer.from(tc.outputRaw, 'utf-8')
    if (buf.length > TOOL_OUTPUT_MAX_BYTES) {
      next.outputRaw = truncateToBytes(tc.outputRaw, bodyBudget) + TRUNCATION_MARKER
      truncated = true
    }
  }

  return truncated ? { ...tc, ...next } : tc
}

/**
 * 截断 Message 中的 tool result（共享入口，D9）。
 *
 * 遍历 message.toolCalls，对每个需要截断的 toolCall 应用 4KB 头部截断。
 * 无 toolCalls 的消息原样返回。details.__gui__ 等结构化字段不截断。
 *
 * 不可变写法：返回新对象（与 chat store commitMessages 的不可变约定一致）。
 *
 * @param msg 原始 Message
 * @returns 截断后的 Message（如无截断则原样返回同一引用）
 */
export function truncateToolOutput(msg: Message): Message {
  if (!msg.toolCalls || msg.toolCalls.length === 0) return msg

  let anyTruncated = false
  const newToolCalls = msg.toolCalls.map((tc) => {
    const truncated = truncateToolCall(tc)
    if (truncated !== tc) anyTruncated = true
    return truncated
  })

  return anyTruncated ? { ...msg, toolCalls: newToolCalls } : msg
}

/**
 * 批量截断 Message[]（hydrate/setMessages 回流路径用，AC-10）。
 */
export function truncateToolOutputBatch(messages: Message[]): Message[] {
  let anyTruncated = false
  const result = messages.map((m) => {
    const truncated = truncateToolOutput(m)
    if (truncated !== m) anyTruncated = true
    return truncated
  })
  return anyTruncated ? result : messages
}
