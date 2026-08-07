/**
 * 11-remote-mode.md 文档完整性 + 链接有效性单测（wave w2 TC1/TC3）。
 *
 * 覆盖：
 * - TC1（机器部分）：5 个章节标题齐全（## 0. / ## 1. / ## 2. / ## 3. / ## 4.）
 * - TC3：所有 markdown 相对链接指向真实存在的文件（无悬空引用）
 *
 * 文档内容质量（TC1 章节正文 / TC2 feature-map 状态准确性）走人审（review），
 * 本测只验机器可断言的部分。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/docs/remote-mode-doc.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// docs/testing/11-remote-mode.md 相对 monorepo 根的绝对路径
// 测试文件位置：packages/renderer/src/__tests__/docs/ → 向上 5 层到 monorepo 根（feat-remote-use）
const MONOREPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const DOC_PATH = resolve(MONOREPO_ROOT, 'docs/testing/11-remote-mode.md')
const docText = readFileSync(DOC_PATH, 'utf8')

/** 提取 markdown 链接（[text](url) 形式），过滤掉 http(s) 外链 + 锚点。 */
function extractRelativeLinks(text: string): string[] {
  const links: string[] = []
  const re = /\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const url = m[1]
    // 跳过外链 + 锚点
    if (url.startsWith('http://') || url.startsWith('https://')) continue
    if (url.startsWith('#')) continue
    links.push(url)
  }
  return links
}

describe('11-remote-mode.md 章节完整性（TC1 机器部分）', () => {
  it('含 5 个章节标题（## 0. / ## 1. / ## 2. / ## 3. / ## 4.）', () => {
    expect(docText).toMatch(/^## 0\. 测试策略/m)
    expect(docText).toMatch(/^## 1\. 前置条件/m)
    expect(docText).toMatch(/^## 2\. MOCK 测试/m)
    expect(docText).toMatch(/^## 3\. 非 MOCK 全链路/m)
    expect(docText).toMatch(/^## 4\. 已知坑/m)
  })
})

describe('11-remote-mode.md 链接有效性（TC3）', () => {
  it('所有相对链接指向真实存在的文件（无悬空引用）', () => {
    const links = extractRelativeLinks(docText)
    expect(links.length).toBeGreaterThan(0)

    const dangling: string[] = []
    for (const link of links) {
      // 相对 docs/testing/11-remote-mode.md 自身位置解析
      const abs = resolve(dirname(DOC_PATH), link)
      if (!existsSync(abs)) {
        dangling.push(link)
      }
    }
    expect(dangling).toEqual([])
  })
})
