/**
 * output tail 字节窗口单测（u-runtime-svc，D7：从文件末尾按字节窗口读，
 * 对齐 extension 侧 output-tail.ts readOutputTail 语义；默认 32KB）。
 *
 * 运行：cd packages/runtime && env -u XYZ_AGENT_DATA_DIR npx vitest run src/services/background-task
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OUTPUT_TAIL_DEFAULT_MAX_BYTES, readOutputTail } from './output-tail.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bg-task-tail-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function writeLog(content: string): string {
  const p = join(dir, 'task.log')
  writeFileSync(p, content, 'utf8')
  return p
}

describe('readOutputTail', () => {
  it('小文件：全文返回，truncated=false', () => {
    const p = writeLog('line1\nline2\nline3\n')
    expect(readOutputTail(p)).toEqual({ text: 'line1\nline2\nline3\n', truncated: false })
  })

  it('字节窗口：默认 32KB 上界，超界 truncated=true 且窗口起点残行被丢弃', () => {
    // 60 行 × 1000 字节 = 60KB > 32KB 默认窗口
    const lines = Array.from({ length: 60 }, (_, i) => `L${String(i).padStart(2, '0')}${'x'.repeat(997)}`)
    const p = writeLog(lines.join('\n') + '\n')
    const result = readOutputTail(p)
    expect(result).not.toBeUndefined()
    expect(result!.truncated).toBe(true)
    // 窗口 32768+64 字节 ≈ 32.8 行 → 首行为残行被丢弃，返回完整行
    for (const line of result!.text.split('\n').filter(Boolean)) {
      expect(line).toMatch(/^L\d{2}/)
    }
    // 末尾行保留
    expect(result!.text).toContain('L59')
    expect(result!.text.length).toBeLessThanOrEqual(60 * 1000)
  })

  it('显式 maxBytes：精确窗口语义（size>maxBytes 即 truncated，即使行数少）', () => {
    const p = writeLog(`${'a'.repeat(300)}\n${'b'.repeat(300)}\n`)
    const result = readOutputTail(p, 250)
    expect(result!.truncated).toBe(true)
    // 窗口 250+64=314 字节 → 第一行 'aaa…' 只剩残段 → 丢弃 → 只剩完整第二行
    expect(result!.text).toBe(`${'b'.repeat(300)}\n`)
  })

  it('行上限：超 maxLines 截尾且 truncated=true', () => {
    const p = writeLog(Array.from({ length: 2500 }, (_, i) => `n${i}`).join('\n'))
    const result = readOutputTail(p, 1024 * 1024, 2000)
    expect(result!.truncated).toBe(true)
    expect(result!.text.split('\n')).toHaveLength(2000)
    expect(result!.text.endsWith('n2499')).toBe(true)
  })

  it('文件不存在 → undefined（调用方映射 lost 语义）', () => {
    expect(readOutputTail(join(dir, 'never.log'))).toBeUndefined()
  })

  it('默认导出常量 = 32KB（D3 output RPC 默认上界）', () => {
    expect(OUTPUT_TAIL_DEFAULT_MAX_BYTES).toBe(32 * 1024)
  })
})
