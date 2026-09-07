/**
 * 后台任务输出文件 tail 读取（D7：按需尾部预览 + running 跟随刷新）。
 *
 * 算法 = 从文件末尾按字节窗口读（对齐 extension 侧 output-tail.ts readOutputTail
 * 语义：末尾窗口 + 余量、残首行丢弃、行/字节双上限先到为准），runtime 侧独立实现
 * 不 import extension 代码（extension 代码属于 pi 进程侧源码树，runtime bundle 不
 * 引用 extension 内部模块）。
 *
 * 与 extension 侧的差异（有意为之）：默认字节上界 32KB（D3 `backgroundTask.output`
 * RPC 默认上界，非 bash_output 的 50KB——UI 尾部预览不需要 AI 上下文预算口径）。
 *
 * 文件不存在/不可读返回 undefined——调用方（u-runtime-rpc 的 output RPC handler）
 * 据此降级为 lost 语义（§3.1 失败路径「输出不可用（文件已清理）」），不崩溃。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'

/** 默认字节窗口上界（D3：默认 32KB = 32_768 字节）。 */
export const OUTPUT_TAIL_DEFAULT_MAX_BYTES = 32_768
/** 行数上限（对齐 output-tail.ts 行上限语义；UI 预览场景 2000 行足够）。 */
export const OUTPUT_TAIL_MAX_LINES = 2000
/** 字节窗口余量：截窗口可能吞掉首行前半，余量降低残行概率（对齐 extension 侧同款参数）。 */
const TAIL_WINDOW_MARGIN_BYTES = 64

export interface OutputTailResult {
  /** 尾部文本（末尾 maxLines 行；窗口起点落在行中间时已丢弃残首行）。 */
  text: string
  /** 读取窗口被截断（内容超字节或行上限）时 true。 */
  truncated: boolean
}

/**
 * 读输出文件尾部（字节窗口从末尾 + 行上限）。文件不存在/不可读返回 undefined。
 * 纯同步实现：调用点为 RPC handler 与轮询回调（每次 O(maxBytes)，32KB 量级微秒级）。
 */
export function readOutputTail(
  outputFile: string,
  maxBytes: number = OUTPUT_TAIL_DEFAULT_MAX_BYTES,
  maxLines: number = OUTPUT_TAIL_MAX_LINES,
): OutputTailResult | undefined {
  let size: number
  try {
    size = statSync(outputFile).size
  } catch {
    return undefined
  }
  // 字节窗口从末尾取 maxBytes + 余量（截窗口可能吞掉首行前半，余量降低概率）
  const windowSize = Math.min(size, maxBytes + TAIL_WINDOW_MARGIN_BYTES)
  const buffer = Buffer.alloc(windowSize)
  let fd: number | undefined
  try {
    fd = openSync(outputFile, 'r')
    readSync(fd, buffer, 0, windowSize, size - windowSize)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch (err) {
        // 已读完内容，close 失败不影响结果（best-effort，与 extension 侧同款防御）
        console.debug('[bg-task-tail] close failed:', err instanceof Error ? err.message : err)
      }
    }
  }
  const text = buffer.toString('utf8')
  const lines = text.split('\n')
  // 窗口起点可能落在行中间：首行是残行时丢弃（它必然不完整）
  const firstLineIsPartial = windowSize < size && lines.length > 0
  const effectiveLines = firstLineIsPartial ? lines.slice(1) : lines
  const byteTruncated = size > maxBytes
  const shown = effectiveLines.slice(-maxLines).join('\n')
  return { text: shown, truncated: byteTruncated || effectiveLines.length > maxLines }
}
