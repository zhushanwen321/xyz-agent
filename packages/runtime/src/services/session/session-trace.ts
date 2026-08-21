/**
 * session-trace 数据通路（design D4：A1 混合路由，trace-runtime 单元）。
 *
 * 职责：session trace 台账的**读取与归一化**——
 *   - 路径 A（活跃 session）：RPC get_entries 权威解析（pi 原生，entry 结构演进跟随 pi
 *     升级）+ 文件首行补 header（pi getEntries() 明确不含 header，session-manager docstring）
 *     + 文件解析补 malformed（pi 静默跳坏行，G1 占位可见）。
 *   - 路径 B（非活跃/降级）：JSONL 直读（复用 core parse-jsonl——损坏行占位可见，不静默
 *     丢失，design §3.1 失败路径）+ sidecar `.meta.json` 合并（session_end BOUNDARY 行）。
 *   - 空态：session 未落盘（pi 延迟写入窗口，规则 6）→ source='empty' 标记，前端显示
 *     「session 尚未落盘」空态；不创建/触碰文件。
 *
 * 归一化产物 SessionTraceSnapshot 与 WS reply session.traceEntries payload 结构一致
 * （shared ServerMessageMap 的结构镜像；行渲染/边界计算归 renderer + core，本模块不染指）。
 *
 * 增量腿（A33）不在本文件：触发事件 → sessionService.syncTraceEntries（since 拉取 +
 * session.traceEntryAppended 广播），见 session-service.ts。
 */
import type {
  SessionTraceHeaderPayload,
  SessionTraceMalformedLine,
  SessionTraceSessionEndPayload,
} from '@xyz-agent/shared'
import { parseSessionTraceJsonl } from '@xyz-agent/core/domain/session-trace'
import type { ISessionStore } from '../ports/session.js'

/** trace 增量推送 id 序列（单调递增 + 时间戳，同 ms 内不碰撞；无魔数字面量）。 */
let tracePushSeq = 0
export function nextTracePushId(): string {
  tracePushSeq++
  return `push_trace_${Date.now()}_${tracePushSeq}`
}

/**
 * 现取 system prompt 的 custom entry customType。写入方 = 常驻 xyz-agent-extension.js 的
 * /__xyz_get_system_prompt__ 命令 handler（字面量锤定，纯 JS 不 import 本模块）；读取方 =
 * session-service.fetchCurrentSystemPrompt 轮询匹配。与留痕包的 xyz:system-prompt（core
 * SYSTEM_PROMPT_CUSTOM_TYPE）语义不同：这是「当前值现取」，非留痕历史。
 */
export const CURRENT_SYSTEM_PROMPT_CUSTOM_TYPE = 'xyz:current-system-prompt'

/** trace 台账快照（= session.traceEntries WS payload）。 */
export interface SessionTraceSnapshot {
  sessionId: string
  /** 数据通路：rpc（活跃，权威解析）/ file（非活跃或 RPC 失败降级）/ empty（未落盘空态）。 */
  source: 'rpc' | 'file' | 'empty'
  /** session JSONL 绝对路径（reveal 按钮数据源；empty 未落盘/路径未知时缺省）。 */
  filePath?: string | null
  /** JSONL 首行 header 完整 entry（parentSession 两形态原样透传）；未落盘/首行损坏时缺省。 */
  header?: SessionTraceHeaderPayload
  /** entry 全集（不含 header）。RPC 权威解析或文件解析（含 handoff_marker 等自定义行）。 */
  entries: unknown[]
  /** 损坏行占位（两路径均产出：文件解析提取行号与原文；RPC 路径补齐 pi 静默跳过的坏行）。 */
  malformed: SessionTraceMalformedLine[]
  /** sidecar session_end 终态（两路径都读 sidecar——终态与活跃性正交）。 */
  sessionEnd?: SessionTraceSessionEndPayload
  /** 当前叶子 entry id（RPC 路径；增量腿 since 基准）。文件路径无 leaf 概念，缺省。 */
  leafId?: string | null
}

/**
 * 解析 header 首行原文为完整 entry（路径 A 用）。
 *
 * 首行非 JSON / 非 type=session → null（session 文件延迟写入窗口内首行可能是半行——
 * 容错不抛，header 缺省是可接受的降级，SESSION 行由前端按缺省处理）。
 */
export function parseTraceHeaderLine(line: string | null): SessionTraceHeaderPayload | undefined {
  if (!line) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && (parsed as { type?: unknown }).type === 'session') {
      return parsed as SessionTraceHeaderPayload
    }
  } catch {
    void 0 /* 首行损坏 → header 缺省（trace 容错语义） */
  }
  return undefined
}

/**
 * 文件文本 → 损坏行占位（路径 A RPC 补齐专用：pi get_entries 静默跳坏行，本函数从文件
 * 文本提取坏行行号与原文）。路径 B 文件直读在 buildTraceSnapshotFromFile 单趟解析中
 * 内联提取（免二次解析），不经过本函数。
 *
 * G1（design「损坏行必须以占位行可见、不静默丢失」）：RPC 路径若不补齐则活跃 session
 * 的坏行对 Trace 视图彻底不可见（GUI 实测回归：非活跃时注入的坏行在 session 重新激活后
 * MALFORMED 行消失）。文本 null（未落盘/读失败）→ 空数组。
 */
export function collectMalformedLines(text: string | null): SessionTraceMalformedLine[] {
  if (text === null) return []
  const malformed: SessionTraceMalformedLine[] = []
  for (const line of parseSessionTraceJsonl(text)) {
    if (!line.ok) malformed.push({ lineNumber: line.lineNumber, raw: line.raw })
  }
  return malformed
}

/**
 * 路径 B：从 JSONL 文件直读构建 trace 快照。
 *
 * 文件不存在（未落盘）→ source='empty' 空态（规则 6：不创建文件）；读出后逐行解析
 * （core parse-jsonl：损坏行占位保留行号与原文），首条 type=session 行提 header，
 * 其余 ok 行按序作 entries；sidecar session_end 合并。
 */
export function buildTraceSnapshotFromFile(
  sessionId: string,
  filePath: string | null,
  sessionStore: ISessionStore,
): SessionTraceSnapshot {
  if (filePath === null) {
    return { sessionId, source: 'empty', entries: [], malformed: [] }
  }
  const text = sessionStore.readSessionJsonlText(filePath)
  if (text === null) {
    // 未落盘（pi 延迟写入：首条 assistant 消息前文件不存在）或读失败（EACCES 等）——
    // 统一空态标记，前端显示「尚未落盘，落盘后自动加载」。
    return { sessionId, source: 'empty', entries: [], malformed: [] }
  }
  const lines = parseSessionTraceJsonl(text)
  let header: SessionTraceHeaderPayload | undefined
  const entries: unknown[] = []
  const malformed: SessionTraceMalformedLine[] = []
  for (const line of lines) {
    if (!line.ok) {
      malformed.push({ lineNumber: line.lineNumber, raw: line.raw })
      continue
    }
    if ((line.entry as { type?: unknown }).type === 'session') {
      // header 固定首行；防御后续再遇 session 行（理论不可达）取首见
      if (header === undefined) header = line.entry as SessionTraceHeaderPayload
      continue
    }
    entries.push(line.entry)
  }
  const sessionEnd = sessionStore.readSessionEndMeta(filePath) ?? undefined
  return { sessionId, source: 'file', filePath, ...(header !== undefined ? { header } : {}), entries, malformed, ...(sessionEnd !== undefined ? { sessionEnd } : {}) }
}
