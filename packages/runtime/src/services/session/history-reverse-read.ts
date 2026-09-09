/**
 * 逆序分块读共享工具（crash-resilience §3.3 D5 / 实施计划 u4b-history-budget）。
 *
 * 从文件尾按固定字节块向前扫描，按「完整行块」交付给调用方——JSONL 行边界对齐
 * （跨块切断的行留在 pending，读到其前部后拼接成交整行才交付），供以下调用方复用：
 * - ①档 getHistoryFromFilePath 预检超限后的逆序窗口（session-history.ts）
 * - ②档尾读 fallback 分块扩窗（session-history.ts，替代「凑不够 20 turns 就全量读」）
 * - ③档 findLastEntryField 逆序分块读（u4c-read-paths，另一单元，预留同款形态）
 *
 * 定位声明：本工具只负责「逆序迭代完整行块」这一 IO 形态，不耦合任何历史业务语义
 * （turn 边界判定 / 窗口选择全部在调用方）。同步 readSync 实现——与 utils/jsonl.ts
 * 的 readTailBytes 同款 IO 模型（块级读取本身是纳秒级 syscall，异步化收益为零），
 * 读取总量受 maxTotalBytes 硬上限约束，不存在无界读。
 *
 * 内存界声明：任意时刻驻留 = 单块 buffer（默认 1MB）+ 尚未拼完整的 pending 行 +
 * 调用方自行的累积。32MB 上限内最坏驻留 ≈ 2×chunkBytes + pending 行，与文件总体积无关。
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

/** 默认块大小：1MB（crash-resilience §3.3 D5②「从尾部按 1MB 块向前扩窗」）。 */
// eslint-disable-next-line no-magic-numbers -- 设计标定块大小（D5② 文本值），非魔法数
export const DEFAULT_REVERSE_CHUNK_BYTES = 1024 * 1024

/**
 * 单次逆序读取的选项（全部可选——生产默认 1MB 块 / 32MB 总上限）。
 */
export interface ReverseReadOptions {
  /** 单块字节数（默认 DEFAULT_REVERSE_CHUNK_BYTES = 1MB）。 */
  chunkBytes?: number
  /**
   * 总读取量上限（默认 READ_PRECHECK_MAX_BYTES = 32MB，shared SSOT——此处不直接
   * import 而由调用方传参注入默认值，保持工具零 shared 依赖、纯 IO 形态）。
   */
  maxTotalBytes?: number
}

/** 交付给 visit 的单个完整行块。 */
export interface ReversedLineChunk {
  /**
   * 完整行文本（正序 = 文件内先后顺序）。每行不含行尾 '\n'。空行原样保留
   * （parse 侧自行跳过）。因 visit 提前停止时，当前块内未交付的更早行不交付。
   */
  lines: string[]
  /** 截至本块（含）的累计读取字节数。 */
  totalBytesRead: number
  /** 本块是否已覆盖到文件头（offset === 0——文件全部剩余内容都在本块及之前交付）。 */
  isStartChunk: boolean
}

/** 逆序读取过程汇总（循环结束时可用）。 */
export interface ReverseReadSummary {
  /** 累计读取字节数（受 maxTotalBytes 上限约束）。 */
  totalBytesRead: number
  /** 是否读到过文件头（最后交付的块 offset === 0）。 */
  sawStart: boolean
  /** visit 是否返回 false 提前停止（停止时当前块内更早行未交付）。 */
  stopped: boolean
  /**
   * 全文件已完整扫描（= sawStart && !stopped：所有块交付完毕且最后块覆盖文件头）。
   * 调用方据此做精确 truncated 判定（读完全文件时 turn 计数是精确总量；
   * 提前停止 / 上限截停时窗口外内容未知，保守判定）。
   */
  fullyScanned: boolean
  /** openSync 失败（文件不存在/不可读）——与 utils/jsonl.ts INVAR-tail-4 同语义，不抛错。 */
  openFailed: boolean
}

/**
 * 从文件尾向前按块迭代完整行，visit 返回 false 可提前停止。
 *
 * 行边界对齐算法（INVAR-reverse-1）：维护 pending（已读区域最前面那行尚未确认完整的
 * 部分文本）。每块读 [offset, end)，合并 = 当前块文本（前） + pending（后）后 split('\n')：
 * - offset > 0 → 首段是被切断行的头部 → 成为新 pending，其余段完整交付；
 * - offset === 0（文件头）→ 全部段完整（pending 补齐后一起交付），pending 清空。
 * 文件末字节非 '\n' 时最后一行仍完整交付（EOF 终止行）。
 *
 * @param filePath JSONL 文件绝对路径
 * @param options 块大小 / 总量上限（缺省 1MB / 调用方注入 READ_PRECHECK_MAX_BYTES）
 * @param visit 行块消费者；返回 false 停止迭代（当前块内剩余更早行不交付）
 * @returns 过程汇总（openFailed=true 时 totalBytesRead=0 且不调用 visit）
 */
export function forEachReversedLineChunk(
  filePath: string,
  options: ReverseReadOptions | undefined,
  visit: (chunk: ReversedLineChunk) => boolean | void,
): ReverseReadSummary {
  const chunkBytes = options?.chunkBytes ?? DEFAULT_REVERSE_CHUNK_BYTES
  const maxTotalBytes = options?.maxTotalBytes ?? Number.MAX_SAFE_INTEGER

  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    // INVAR-tail-4 同语义：文件不存在（ENOENT）/不可读（EACCES）→ openFailed 汇总不抛
    return { totalBytesRead: 0, sawStart: false, stopped: false, fullyScanned: false, openFailed: true }
  }
  try {
    const size = fstatSync(fd).size
    // 空文件：天然「无内容可读」= 已完整扫描（避免调用方把空文件误判为「未读到头」）
    if (size === 0) return { totalBytesRead: 0, sawStart: true, stopped: false, fullyScanned: true, openFailed: false }
    let pending = ''
    let end = size
    let totalBytesRead = 0
    let sawStart = false
    let stopped = false

    while (end > 0) {
      const remaining = maxTotalBytes - totalBytesRead
      if (remaining <= 0) break // 总量上限：停止（sawStart=false，调用方保守判定）
      const chunkLen = Math.min(chunkBytes, end, remaining)
      const offset = end - chunkLen
      const buf = Buffer.alloc(chunkLen)
      const bytesRead = readSync(fd, buf, 0, chunkLen, offset)
      totalBytesRead += bytesRead
      // 当前块在前、pending（来自更靠后的块）在后，文件顺序拼接
      const text = buf.subarray(0, bytesRead).toString('utf-8') + pending
      const segs = text.split('\n')
      // 行界伪影：text 以 '\n' 结尾时 split 的尾随空段不是行（'\n' 结束了前一行；
      // 中间的空串才是真实空行，保留）。不判伪影会把每块行尾的空段当空行交付。
      if (text.endsWith('\n')) segs.pop()
      const isStartChunk = offset === 0
      if (isStartChunk) {
        sawStart = true
        pending = ''
      } else {
        // 首段是被切断行的头部（其开头在 offset 之前）——留 pending，不交付
        pending = segs[0] ?? ''
        segs.shift()
      }
      if (segs.length > 0) {
        const stop = visit({ lines: segs, totalBytesRead, isStartChunk })
        if (stop === false) {
          stopped = true
          break
        }
      }
      end = offset
    }
    // pending 残留 = 因提前停止 / 上限截停而永不完整的半行——按残行丢弃语义放弃
    // （对齐 readTailBytes INVAR-tail-3「宁可多丢一行也不冒险 parse 残行」取舍）
    return { totalBytesRead, sawStart, stopped, fullyScanned: sawStart && !stopped, openFailed: false }
  } finally {
    closeSync(fd)
  }
}
