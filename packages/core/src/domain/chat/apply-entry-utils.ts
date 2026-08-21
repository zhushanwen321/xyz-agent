/**
 * apply-entry 模块群共享底层（apply-entry.ts + apply-entry-convert.ts + apply-entry-utils.ts 三件套）。
 *
 * 本文件承载三件套的共享底层：工具产出归一（normalizePiToolResult / stripAnsi）、
 * 确定性派生与 Record 守卫（toMs / isLooseRecord / isPlainRecord）、reducer 簇共用
 * 类型与常量（PiToolResultBody / CLIENT_MSG_ID_TYPE）。reducer 本体在 apply-entry.ts，
 * message body 转换群在 apply-entry-convert.ts；整体职责叙事见 apply-entry.ts 文件头。
 *
 * 本模块群自包含约束（runtime tsup 打包 / renderer vite 消费双重入口）：本模块群
 * （apply-entry.ts + apply-entry-convert.ts + apply-entry-utils.ts）只 import
 * '@xyz-agent/shared' 与群内文件，不 import core 内群外模块（防 vue 依赖渗入 runtime bundle）。
 */
import type { PiMessageBody } from '@xyz-agent/shared'

/** toolResult role 的窄化 body（role 字面量收窄后构造，供 orphan 收集的类型自洽）。 */
export interface PiToolResultBody extends PiMessageBody {
  role: 'toolResult'
}

/** xyz-client-msg-id extension 写入的 customType 常量（与 extension 端字符串严格一致）。 */
export const CLIENT_MSG_ID_TYPE = 'xyz.client-msg-id'

// ── 确定性派生工具 ───────────────────────────────────────────────────

/** ISO string → ms；非字符串（类型异常）兜底 0（pi entry.timestamp 契约恒为 string）。 */
export function toMs(timestamp: string): number {
  const ms = new Date(timestamp).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/** unknown → Record 守卫（details 透传用；数组也放行——迁移前 custom details 是 cast 透传）。 */
export function isLooseRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** unknown → 非数组 Record 守卫（toolResult details 透传用，迁移前显式排除数组）。 */
export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ── stripAnsi / normalizePiToolResult（迁移自 runtime normalize-tool-result.ts）──────
//
// 迁移副本（非 import）：core 包不依赖 runtime（包依赖方向），而 reducer 需要归一规则。
// 实时路径 SSOT 仍在 runtime normalize-tool-result.ts（event-adapter 消费，W21 领地），
// 两份并存是 W20 的已知分叉，收敛到 shared 留待后续 wave（见 apply-entry.ts 文件头注释）。

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
 * [W21] 由 apply-entry.ts re-export 保持 core API 不变，供 effects/registry 消费
 * （tool_call_end 的 entry.message.content 是原始产出——与 pi 持久化 toolResult entry
 * 同构，归一化在消费侧做）；convert 侧 computeToolCallFill 同源调用。
 * [W5] content-array 分支的 image 块提取与 runtime 版逐字对齐（images 差异消除，
 * 见 apply-entry.ts 文件头分叉注释）。
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
