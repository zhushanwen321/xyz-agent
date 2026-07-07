/**
 * parseDiff unified diff 解析纯函数单测。
 *
 * 覆盖：
 * - 标准 patch：文件头跳过 + hunk 头解析 + context/add/del 分类 + 行号推进
 * - 多 hunk：行号计数器随 hunk 头重置
 * - 空 patch / 非 diff 文本 → 空 hunks
 * - 行号连续性（context 推进双计数，add 推进 newNo，del 推进 oldNo）
 * - hunk 头省略 count（@@ -1 +1 @@）
 * - 'No newline at end of file' meta 行
 * - 空行作 context 处理
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/lib/parseDiff.test.ts
 */
import { describe, it, expect } from 'vitest'
import { parseDiff } from '@/composables/logic/parseDiff'

/** 标准 unified diff 样例（含文件头 + 单 hunk + context/add/del） */
const STANDARD_PATCH = `diff --git a/src/existing.ts b/src/existing.ts
index 111..222 100644
--- a/src/existing.ts
+++ b/src/existing.ts
@@ -1,3 +1,5 @@
 line1
+new line
 line2
+added line`

describe('parseDiff', () => {
  it('空 patch → 空 hunks', () => {
    expect(parseDiff('')).toEqual({ hunks: [] })
  })

  it('非 diff 文本（无 hunk 头）→ 空 hunks', () => {
    expect(parseDiff('just some text\nno diff here')).toEqual({ hunks: [] })
  })

  it('标准 patch：解析单 hunk 的行分类与行号', () => {
    const { hunks } = parseDiff(STANDARD_PATCH)
    expect(hunks).toHaveLength(1)
    const h = hunks[0]
    expect(h.oldStart).toBe(1)
    expect(h.newStart).toBe(1)

    // hunk 内行序列：hunk头 + context + add + context + add
    expect(h.lines).toHaveLength(5)
    const [h0, h1, h2, h3, h4] = h.lines

    expect(h0.type).toBe('hunk')
    expect(h0.content).toContain('@@ -1,3 +1,5 @@')

    // line1（context）：双行号推进
    expect(h1).toMatchObject({ type: 'context', oldNo: 1, newNo: 1, content: 'line1' })
    // +new line（add）：仅 newNo
    expect(h2).toMatchObject({ type: 'add', newNo: 2, content: 'new line' })
    expect(h2.oldNo).toBeUndefined()
    // line2（context）：双行号推进
    expect(h3).toMatchObject({ type: 'context', oldNo: 2, newNo: 3, content: 'line2' })
    // +added line（add）
    expect(h4).toMatchObject({ type: 'add', newNo: 4, content: 'added line' })
  })

  it('del 行仅推进 oldNo', () => {
    const patch = `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1 @@
-removed
 keep`
    const { hunks } = parseDiff(patch)
    const lines = hunks[0].lines
    // hunk头 + del + context
    expect(lines[1]).toMatchObject({ type: 'del', oldNo: 1, content: 'removed' })
    expect(lines[1].newNo).toBeUndefined()
    expect(lines[2]).toMatchObject({ type: 'context', oldNo: 2, newNo: 1, content: 'keep' })
  })

  it('多 hunk：行号计数器随各 hunk 头重置', () => {
    const patch = `--- a/f
+++ b/f
@@ -1,1 +1,1 @@
 a
@@ -10,1 +20,1 @@
 b`
    const { hunks } = parseDiff(patch)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].oldStart).toBe(1)
    expect(hunks[0].newStart).toBe(1)
    expect(hunks[1].oldStart).toBe(10)
    expect(hunks[1].newStart).toBe(20)
  })

  it('hunk 头省略 count（@@ -1 +1 @@）', () => {
    const patch = `--- a/f
+++ b/f
@@ -5 +5 @@
 x`
    const { hunks } = parseDiff(patch)
    expect(hunks[0].oldStart).toBe(5)
    expect(hunks[0].newStart).toBe(5)
  })

  it("'\\ No newline at end of file' 归为 meta", () => {
    const patch = `--- a/f
+++ b/f
@@ -1,1 +1,1 @@
 x
\\ No newline at end of file`
    const lines = parseDiff(patch).hunks[0].lines
    const meta = lines[lines.length - 1]
    expect(meta.type).toBe('meta')
    expect(meta.content).toBe('\\ No newline at end of file')
  })

  it('hunk 内空行作 context 处理', () => {
    const patch = `--- a/f
+++ b/f
@@ -1,2 +1,3 @@
 a

b`
    const { hunks } = parseDiff(patch)
    const lines = hunks[0].lines
    // hunk头 + context(a) + context(空行) + context(b)
    expect(lines[2]).toMatchObject({ type: 'context', content: '' })
  })

  it('文件头 meta 行被跳过（不进 hunks）', () => {
    const patch = `diff --git a/x b/x
index 111..222 100644
--- a/x
+++ b/x
@@ -1,1 +1,1 @@
 x`
    const { hunks } = parseDiff(patch)
    // 文件头 4 行不进任何 hunk
    const allTypes = hunks.flatMap((h) => h.lines.map((l) => l.type))
    expect(allTypes).not.toContain('meta')
    expect(hunks[0].lines[0].type).toBe('hunk')
  })
})
