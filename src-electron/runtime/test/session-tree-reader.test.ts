/**
 * session-tree-reader 单测 — 覆盖纯解析逻辑（report round5 must-fix #2）。
 *
 * session-tree 是 fork pi 的核心动机（leafId 透出），WS 入口风险最高。
 * buildTreeFromFile / computeActivePath / extractFullText / countBranches 共 ~286 行纯解析逻辑
 * 此前无专属单测（tree-message-handler.test.ts 把 treeService 全 mock 掉）。
 *
 * 运行：cd src-electron/runtime && npx vitest run test/session-tree-reader.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildTreeFromFile,
  computeActivePath,
  extractFullText,
  countBranches,
} from '../src/infra/pi/session-tree-reader.js'

describe('session-tree-reader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'str-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 写 JSONL 文件并返回路径。每条 entry 会被 JSON.stringify。 */
  function writeSession(entries: Record<string, unknown>[]): string {
    const fp = join(tmpDir, 'session.jsonl')
    writeFileSync(fp, entries.map(e => JSON.stringify(e)).join('\n'), 'utf-8')
    return fp
  }

  describe('buildTreeFromFile — 文件缺失与空', () => {
    it('文件不存在时返回空树（pi 延迟写入：assistant 到达前不 flush）', async () => {
      const result = await buildTreeFromFile(join(tmpDir, 'never-exists.jsonl'))
      expect(result.rootNodes).toEqual([])
      expect(result.byId.size).toBe(0)
      expect(result.lastEntryId).toBeNull()
    })

    it('空文件返回空树', async () => {
      const fp = join(tmpDir, 'empty.jsonl')
      writeFileSync(fp, '', 'utf-8')
      const result = await buildTreeFromFile(fp)
      expect(result.rootNodes).toEqual([])
      expect(result.lastEntryId).toBeNull()
    })
  })

  describe('buildTreeFromFile — session header 跳过', () => {
    it('type=session 的 header 行被跳过，不进 byId', async () => {
      const fp = writeSession([
        { type: 'session', id: 'sess-1', cwd: '/x', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'user', content: 'hello' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.byId.has('sess-1')).toBe(false)
      expect(result.byId.has('m1')).toBe(true)
      expect(result.rootNodes).toHaveLength(1)
    })
  })

  describe('buildTreeFromFile — 正常多叉树', () => {
    it('构建父子关系并按 timestamp 排序 children', async () => {
      //   root(m1)
      //    ├── c1 (timestamp 更早，应排第一；文件中也先出现)
      //    └── c2 (timestamp 更晚，应排第二；文件中最后出现 → lastEntryId)
      const fp = writeSession([
        { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'root' } },
        { type: 'message', id: 'c1', parentId: 'm1', timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'assistant', content: 'first' } },
        { type: 'message', id: 'c2', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z',
          message: { role: 'assistant', content: 'second' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.rootNodes).toHaveLength(1)
      const root = result.rootNodes[0]!
      expect(root.id).toBe('m1')
      expect(root.children.map(c => c.id)).toEqual(['c1', 'c2'])
      // lastEntryId 取最后一条 type=message
      expect(result.lastEntryId).toBe('c2')
    })

    it('role 从 message.role 提取', async () => {
      const fp = writeSession([
        { type: 'message', id: 'u1', parentId: null, timestamp: 't',
          message: { role: 'user', content: 'hi' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.byId.get('u1')?.role).toBe('user')
    })
  })

  describe('buildTreeFromFile — orphan 升根', () => {
    it('parentId 指向不存在节点时，节点被提升为 root', async () => {
      const fp = writeSession([
        { type: 'message', id: 'orphan', parentId: 'ghost-parent', timestamp: 't',
          message: { role: 'user', content: 'x' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.rootNodes).toHaveLength(1)
      expect(result.rootNodes[0]!.id).toBe('orphan')
      // parentId 仍保留原始值（不重写）
      expect(result.rootNodes[0]!.parentId).toBe('ghost-parent')
    })

    it('parentId 等于自身 id 时视为 root（避免自环）', async () => {
      const fp = writeSession([
        { type: 'message', id: 'self', parentId: 'self', timestamp: 't',
          message: { role: 'user', content: 'x' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.rootNodes).toHaveLength(1)
      expect(result.rootNodes[0]!.id).toBe('self')
    })
  })

  describe('buildTreeFromFile — label 应用', () => {
    it('label entry 的 label 被应用到 targetId 对应节点（label 在 target 之后出现）', async () => {
      const fp = writeSession([
        { type: 'message', id: 'msg1', parentId: null, timestamp: 't',
          message: { role: 'user', content: 'hello' } },
        { type: 'label', id: 'lbl1', targetId: 'msg1', label: 'my-label' },
      ])
      const result = await buildTreeFromFile(fp)
      // label entry 自身也会建 node（filter 只跳 session header），但它不应进 rootNodes 以外的副作用
      expect(result.byId.get('msg1')?.label).toBe('my-label')
    })

    it('label 在 target 之前出现也能应用（两遍收集）', async () => {
      const fp = writeSession([
        { type: 'label', id: 'lbl1', targetId: 'msg1', label: 'pre-label' },
        { type: 'message', id: 'msg1', parentId: null, timestamp: 't',
          message: { role: 'user', content: 'hello' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.byId.get('msg1')?.label).toBe('pre-label')
    })
  })

  describe('buildTreeFromFile — content 多态（string vs array）', () => {
    it('content 为字符串时提取首行作为 text 预览', async () => {
      const fp = writeSession([
        { type: 'message', id: 's1', parentId: null, timestamp: 't',
          message: { role: 'user', content: 'first line\nsecond line' } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.byId.get('s1')!.text).toBe('first line')
    })

    it('content 为 array 时取第一个 text block 的首行', async () => {
      const fp = writeSession([
        { type: 'message', id: 'a1', parentId: null, timestamp: 't',
          message: { role: 'user', content: [
            { type: 'thinking', thinking: 'internal' },
            { type: 'text', text: 'visible text' },
          ] } },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.byId.get('a1')!.text).toBe('visible text')
    })

    it('text 预览截断到 100 字符（含 ... 后缀）', async () => {
      const longText = 'x'.repeat(150)
      const fp = writeSession([
        { type: 'message', id: 'long1', parentId: null, timestamp: 't',
          message: { role: 'user', content: longText } },
      ])
      const result = await buildTreeFromFile(fp)
      const text = result.byId.get('long1')!.text
      expect(text).toHaveLength(103) // 100 + '...'
      expect(text.endsWith('...')).toBe(true)
    })

    it('label entry 的 text 取 label 字段', async () => {
      const fp = writeSession([
        { type: 'label', id: 'lbl1', targetId: 'msg1', label: 'branch-A' },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.byId.get('lbl1')!.text).toBe('branch-A')
    })
  })

  describe('buildTreeFromFile — lastEntryId 只取 type=message', () => {
    it('尾部是 model_change/thinking_level_change 时跳过，取最后一条 message', async () => {
      const fp = writeSession([
        { type: 'message', id: 'm1', parentId: null, timestamp: 't1',
          message: { role: 'user', content: 'a' } },
        { type: 'message', id: 'm2', parentId: 'm1', timestamp: 't2',
          message: { role: 'assistant', content: 'b' } },
        { type: 'model_change', id: 'mc1', parentId: 'm2', timestamp: 't3' },
        { type: 'thinking_level_change', id: 'tlc1', parentId: 'm2', timestamp: 't4' },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.lastEntryId).toBe('m2')
    })

    it('无 message entry 时 lastEntryId 为 null', async () => {
      const fp = writeSession([
        { type: 'model_change', id: 'mc1', parentId: null, timestamp: 't1' },
      ])
      const result = await buildTreeFromFile(fp)
      expect(result.lastEntryId).toBeNull()
    })
  })

  describe('computeActivePath — 环路 guard', () => {
    it('正常路径：从 leaf 到 root 全部 id 入集合', () => {
      // 构造 byId: leaf -> mid -> root
      const byId = new Map<string, { parentId: string | null }>([
        ['root', { parentId: null }],
        ['mid', { parentId: 'root' }],
        ['leaf', { parentId: 'mid' }],
      ])
      const path = computeActivePath(byId as never, 'leaf')
      expect(path).toEqual(new Set(['leaf', 'mid', 'root']))
    })

    it('环路 guard：遇到已访问节点即停止，避免死循环', () => {
      // 构造环 a -> b -> a
      const byId = new Map<string, { parentId: string | null }>([
        ['a', { parentId: 'b' }],
        ['b', { parentId: 'a' }],
      ])
      const path = computeActivePath(byId as never, 'a')
      // 应包含 a, b 后即因 b.parentId=a 已在集合中而停止
      expect(path.has('a')).toBe(true)
      expect(path.has('b')).toBe(true)
      expect(path.size).toBe(2)
    })

    it('leafId 不在 byId 时只包含 leafId 自身', () => {
      const byId = new Map<string, { parentId: string | null }>()
      const path = computeActivePath(byId as never, 'ghost')
      expect(path).toEqual(new Set(['ghost']))
    })
  })

  describe('extractFullText', () => {
    it('content 为字符串时原样返回', () => {
      const entry = { type: 'message', message: { content: 'full text' } }
      expect(extractFullText(entry as never)).toBe('full text')
    })

    it('content 为 array 时拼接所有 text block（用 \\n 分隔）', () => {
      const entry = { type: 'message', message: { content: [
        { type: 'text', text: 'line1' },
        { type: 'thinking', thinking: 'ignore' },
        { type: 'text', text: 'line2' },
      ] } }
      expect(extractFullText(entry as never)).toBe('line1\nline2')
    })

    it('非 message entry 返回 undefined', () => {
      expect(extractFullText({ type: 'label' } as never)).toBeUndefined()
    })

    it('content 全是非 text block 时返回 undefined（join 结果为空）', () => {
      const entry = { type: 'message', message: { content: [
        { type: 'thinking', thinking: 'x' },
      ] } }
      expect(extractFullText(entry as never)).toBeUndefined()
    })
  })

  describe('countBranches', () => {
    it('无分支的线性树返回 0', () => {
      const linear = [{ id: 'a', parentId: null, children: [
        { id: 'b', parentId: 'a', children: [] },
      ] }]
      expect(countBranches(linear as never)).toBe(0)
    })

    it('统计所有 children.length > 1 的节点', () => {
      //    root (2 children → branch)
      //    ├── a (1 child → not branch)
      //    │   └── a1
      //    └── b (2 children → branch)
      //        ├── b1
      //        └── b2
      const tree = [{
        id: 'root', parentId: null, children: [
          { id: 'a', parentId: 'root', children: [
            { id: 'a1', parentId: 'a', children: [] },
          ] },
          { id: 'b', parentId: 'root', children: [
            { id: 'b1', parentId: 'b', children: [] },
            { id: 'b2', parentId: 'b', children: [] },
          ] },
        ],
      }]
      expect(countBranches(tree as never)).toBe(2)
    })

    it('空树返回 0', () => {
      expect(countBranches([])).toBe(0)
    })
  })
})
