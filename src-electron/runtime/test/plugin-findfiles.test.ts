import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 直接测试 fast-glob 的 findFiles 行为（真实临时目录，无 mock）。
 *
 * findFiles handler 的核心逻辑：
 * 1. 用 fast-glob 按模式搜索
 * 2. 忽略 node_modules / .git
 * 3. 返回绝对路径，截断到 1000 条
 */
async function findFiles(pattern: string, cwd: string): Promise<string[]> {
  try {
    const fastGlob = (await import('fast-glob')).default
    const entries = await fastGlob(pattern, {
      cwd,
      ignore: ['**/node_modules/**', '**/.git/**'],
      absolute: true,
    }) as string[]
    return entries.slice(0, 1000)
  } catch {
    return []
  }
}

describe('findFiles (FR-6)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findfiles-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('用 **/*.json 能返回匹配文件', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'hello')

    const results = await findFiles('**/*.json', tmpDir)
    expect(results).toHaveLength(2)
    expect(results.every(f => f.endsWith('.json'))).toBe(true)
  })

  it('忽略 node_modules 和 .git 目录', async () => {
    // 正常文件
    fs.writeFileSync(path.join(tmpDir, 'src.ts'), 'code')

    // node_modules 内的文件
    const nmDir = path.join(tmpDir, 'node_modules', 'pkg')
    fs.mkdirSync(nmDir, { recursive: true })
    fs.writeFileSync(path.join(nmDir, 'index.ts'), 'pkg')

    // .git 内的文件
    const gitDir = path.join(tmpDir, '.git', 'objects')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'data.ts'), 'git')

    const results = await findFiles('**/*.ts', tmpDir)
    const basenames = results.map(f => path.basename(f))
    expect(basenames).toContain('src.ts')
    expect(basenames).not.toContain('index.ts')
    expect(basenames).not.toContain('data.ts')
  })

  it('超过 1000 条时截断', async () => {
    // 创建 1005 个文件
    for (let i = 0; i < 1005; i++) {
      fs.writeFileSync(path.join(tmpDir, `file-${i}.txt`), `${i}`)
    }

    const results = await findFiles('**/*.txt', tmpDir)
    expect(results).toHaveLength(1000)
    expect(results.every(f => f.endsWith('.txt'))).toBe(true)
  })

  it('返回绝对路径', async () => {
    fs.writeFileSync(path.join(tmpDir, 'abs.json'), '{}')

    const results = await findFiles('**/*.json', tmpDir)
    expect(results).toHaveLength(1)
    expect(path.isAbsolute(results[0])).toBe(true)
  })

  it('无匹配时返回空数组', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello')

    const results = await findFiles('**/*.json', tmpDir)
    expect(results).toEqual([])
  })
})
