/**
 * 逆序分块读共享工具测试（u4b-history-budget，crash-resilience §3.3 D5）。
 *
 * 覆盖：
 * - 行边界对齐（断言⑦）：块边界切断长行 → 拼接后交付的行与原文件行逐字一致
 * - 多块迭代 / 读到文件头（sawStart / fullyScanned）
 * - visit 提前停止（stopped，停止时当前块内更早行不交付）
 * - 总量上限截停（maxTotalBytes，sawStart=false）
 * - 文件尾无换行（EOF 终止行完整交付）/ 空文件 / 文件不存在（openFailed）
 *
 * 测试框架：vitest；fixture 全部 mkdtempSync 自建自删（fs-guard 白名单 tmpdir）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/history-reverse-read.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { forEachReversedLineChunk } from '../history-reverse-read.js'

let tmpDir: string

// 每用例独立临时目录（fs-guard：tmpdir 白名单自建自删）
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'history-reverse-read-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function write(name: string, content: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/** 收集全部交付行的便捷封装（visit 按尾→头顺序调用，拼回文件正序需反转块序）。 */
function readAll(filePath: string, options: Parameters<typeof forEachReversedLineChunk>[1] = { chunkBytes: 64, maxTotalBytes: 1 << 20 }) {
  const chunks: string[][] = []
  const summary = forEachReversedLineChunk(filePath, options, (chunk) => {
    chunks.push(chunk.lines)
  })
  // 块内行正序；块间从尾向头推进 → 文件正序 = 块序反转后 flat
  const lines = chunks.slice().reverse().flat()
  return { lines, chunks, summary }
}

describe('行边界对齐（断言⑦：JSONL 行不切断）', () => {
  it('块边界切断长行：拼接后交付的行与原文件行逐字一致（长行跨块）', () => {
    // 行长 300 字节 > chunkBytes 64：每块必然切断行
    const lines = Array.from({ length: 12 }, (_, i) => `L${i}-` + 'x'.repeat(300 - 4 + i))
    const filePath = write('long-lines.jsonl', lines.join('\n') + '\n')

    const { lines: delivered, summary } = readAll(filePath)

    expect(delivered).toEqual(lines)
    expect(summary.sawStart).toBe(true)
    expect(summary.stopped).toBe(false)
    expect(summary.fullyScanned).toBe(true)
  })

  it('多字节边界组合：短行/长行交错 + 尾行无换行（EOF 终止行完整交付）', () => {
    const lines = ['a', 'y'.repeat(200), 'b', 'z'.repeat(199), 'tail-no-newline']
    const filePath = write('mixed.jsonl', lines.join('\n')) // 无尾换行

    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 50, maxTotalBytes: 1 << 20 })

    expect(delivered).toEqual(lines)
    expect(summary.fullyScanned).toBe(true)
  })

  it('块恰与行边界对齐（文件以 \\n 结尾且块长整除）：无空残段误交付', () => {
    const lines = ['r1', 'r2', 'r3', 'r4']
    const filePath = write('aligned.jsonl', lines.join('\n') + '\n')

    // 每行 2 字节 + \n = 3 字节，chunkBytes=9 恰好整除
    const { lines: delivered } = readAll(filePath, { chunkBytes: 9, maxTotalBytes: 1 << 20 })

    expect(delivered).toEqual(lines)
  })
})

describe('迭代过程语义', () => {
  it('块内行正序 + 块间从尾向头推进 + totalBytesRead 累计', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f']
    const filePath = write('order.jsonl', lines.join('\n') + '\n')

    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 4, maxTotalBytes: 1 << 20 })

    // 多块迭代拼回后与原行序一致（块分布是实现细节，不锚定）
    expect(delivered).toEqual(lines)
    expect(summary.totalBytesRead).toBe(lines.join('\n').length + 1)
    expect(summary.fullyScanned).toBe(true)
  })

  it('visit 返回 false 提前停止：stopped=true、fullyScanned=false，当前块剩余更早行不交付', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`)
    const filePath = write('stop.jsonl', lines.join('\n') + '\n')

    const delivered: string[] = []
    const summary = forEachReversedLineChunk(filePath, { chunkBytes: 8, maxTotalBytes: 1 << 20 }, ({ lines: chunkLines }) => {
      for (let i = chunkLines.length - 1; i >= 0; i--) {
        delivered.push(chunkLines[i])
        if (delivered.length >= 3) return false
      }
    })

    expect(summary.stopped).toBe(true)
    expect(summary.sawStart).toBe(false)
    expect(summary.fullyScanned).toBe(false)
    expect(delivered).toEqual(['line-9', 'line-8', 'line-7'])
  })

  it('总读取量上限截停：totalBytesRead = 上限、sawStart=false、不抛错', () => {
    const lines = Array.from({ length: 40 }, (_, i) => 'p'.repeat(100) + `-${i}`)
    const filePath = write('cap.jsonl', lines.join('\n') + '\n')
    const fullSize = lines.join('\n').length + 1

    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 128, maxTotalBytes: 300 })

    expect(summary.totalBytesRead).toBe(300)
    expect(summary.sawStart).toBe(false)
    expect(summary.stopped).toBe(false)
    expect(summary.fullyScanned).toBe(false)
    // 只交付了部分行（尾部），且总读取量被硬帽约束
    expect(delivered.length).toBeLessThan(lines.length)
    expect(fullSize).toBeGreaterThan(300)
  })
})

describe('边界输入', () => {
  it('空文件：sawStart/fullyScanned=true，不调用 visit', () => {
    const filePath = write('empty.jsonl', '')
    const visited: unknown[] = []
    const summary = forEachReversedLineChunk(filePath, { chunkBytes: 64, maxTotalBytes: 1024 }, (c) => {
      visited.push(c)
    })
    expect(visited).toHaveLength(0)
    expect(summary.fullyScanned).toBe(true)
  })

  it('文件不存在：openFailed=true 不抛错（INVAR-tail-4 同语义）', () => {
    const summary = forEachReversedLineChunk(join(tmpDir, 'nope.jsonl'), { chunkBytes: 64, maxTotalBytes: 1024 }, () => {})
    expect(summary.openFailed).toBe(true)
    expect(summary.totalBytesRead).toBe(0)
  })

  it('单块大于文件：一块读完（offset=0 无残行丢弃）', () => {
    const lines = ['one', 'two']
    const filePath = write('small.jsonl', lines.join('\n'))
    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 1 << 20, maxTotalBytes: 4 << 20 })
    expect(delivered).toEqual(lines)
    expect(summary.fullyScanned).toBe(true)
  })
})
