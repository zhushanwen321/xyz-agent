/**
 * session-trace 数据通路（design D4：A1 混合路由，trace-runtime 单元）。
 *
 * 职责：session trace 台账的**读取与归一化**——
 *   - 路径 A（活跃 session）：RPC get_entries 权威解析（pi 原生，entry 结构演进跟随 pi
 *     升级）+ 文件首行补 header（pi getEntries() 明确不含 header，session-manager docstring）。
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

/** trace 台账快照（= session.traceEntries WS payload）。 */
export interface SessionTraceSnapshot {
  sessionId: string
  /** 数据通路：rpc（活跃，权威解析）/ file（非活跃或 RPC 失败降级）/ empty（未落盘空态）。 */
  source: 'rpc' | 'file' | 'empty'
  /** JSONL 首行 header 完整 entry（parentSession 两形态原样透传）；未落盘/首行损坏时缺省。 */
  header?: SessionTraceHeaderPayload
  /** entry 全集（不含 header）。RPC 权威解析或文件解析（含 handoff_marker 等自定义行）。 */
  entries: unknown[]
  /** 损坏行占位（仅文件路径产出；RPC 路径 pi 已静默跳坏行，恒空数组）。 */
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
  return { sessionId, source: 'file', ...(header !== undefined ? { header } : {}), entries, malformed, ...(sessionEnd !== undefined ? { sessionEnd } : {}) }
}
