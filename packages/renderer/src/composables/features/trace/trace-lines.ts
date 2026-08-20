/**
 * trace-lines —— runtime WS payload → core mapSessionTraceRows 输入的适配（trace-ui A41）。
 *
 * runtime 全量回包（session.traceEntries）把 JSONL 拆成 header / entries / malformed 三段
 * （entries 保持文件行序但跳过坏行；malformed 带绝对行号）。core 的 mapSessionTraceRows
 * 消费逐行产物（ParsedSessionTraceLine[]，坏行在原位）。本模块把三段归并回逐行产物，
 * 归并锚点 = malformed 的绝对行号（文件直读路径 runtime 保证行号合法；entry 行号不可知，
 * 用「计数推进 + 坏行行号 ≤ 当前行号即插前」近似——空行跳号时坏行最多延后到尾部，不丢）。
 * RPC 路径 malformed 恒空（pi 已静默跳坏行），归并退化为直拼，无精度损失。
 */
import type { ParsedSessionTraceLine, TraceFileEntry } from '@xyz-agent/core/domain/session-trace'
import type {
  SessionTraceHeaderPayload,
  SessionTraceMalformedLine,
} from '@xyz-agent/shared'

/** entry 未知 JSON → TraceFileEntry 的宽松收窄（pi session 解析不做校验，宽松结构见 core types）。 */
function asEntry(value: unknown): TraceFileEntry {
  return value as TraceFileEntry
}

/** header 占用的首行行号之后首个 entry 行（pi 约定 JSONL 首行是 session header）。 */
const FIRST_ENTRY_LINE = 2

/**
 * header + entries + malformed → 逐行产物（行序 = 文件行序的最好复原）。
 * header 存在时占第 1 行（pi 约定 JSONL 首行）；malformed 按行号升序穿插。
 */
export function mergeTraceLines(
  header: SessionTraceHeaderPayload | undefined,
  entries: readonly unknown[],
  malformed: readonly SessionTraceMalformedLine[],
): ParsedSessionTraceLine[] {
  const lines: ParsedSessionTraceLine[] = []
  const bad = [...malformed].sort((a, b) => a.lineNumber - b.lineNumber)
  let mi = 0
  let nextLine = 1

  if (header !== undefined) {
    lines.push({ ok: true, lineNumber: 1, entry: asEntry(header) })
    nextLine = FIRST_ENTRY_LINE
  }

  for (const entry of entries) {
    // 坏行行号 ≤ 当前行号 → 插在当前 entry 之前（原位语义的最好近似；空行跳号延后到尾部）
    while (mi < bad.length && bad[mi]!.lineNumber <= nextLine) {
      lines.push({ ok: false, lineNumber: bad[mi]!.lineNumber, raw: bad[mi]!.raw })
      mi++
      nextLine++
    }
    lines.push({ ok: true, lineNumber: nextLine, entry: asEntry(entry) })
    nextLine++
  }
  // 尾部剩余坏行（行号超出全部 entry 位置，如文件尾部注入）
  for (; mi < bad.length; mi++) {
    lines.push({ ok: false, lineNumber: bad[mi]!.lineNumber, raw: bad[mi]!.raw })
  }
  return lines
}
