/**
 * restore.ts composable 单测 —— composer 发送后清空 / 失败恢复（W2 TC）。
 *
 * 覆盖：clearInput（draft 置空 + drafts.delete 边界：sid=null 不删 + inputRef.clear）、
 * restoreInput（draft 同步 + setText）、restoreSegments（4 段类型分发：text 过滤 join /
 * image→insertImageBadge 含 needsMigrate ?? false 空值合并 / skill→insertSlashChip `/skill:` 前缀 /
 * file→insertFileChip lineRange 透传）。
 *
 * restore.ts 自述「纯逻辑编排，零 DOM 直连」，故本测试零 jsdom DOM 断言，全 mock deps。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/restore.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerRestore } from './restore'
import type { ComposerRestoreDeps, DraftStore } from './types'
import type { ComposerInputInstance } from '@xyz-agent/core/domain/composer'
import type { Segment } from '@xyz-agent/shared'

/** mock ComposerInputInstance（clear/setText/insertImageBadge/insertSlashChip/insertFileChip） */
function makeInputInstance(overrides: Partial<ComposerInputInstance> = {}): ComposerInputInstance {
  return {
    clear: vi.fn(),
    setText: vi.fn(),
    insertImageBadge: vi.fn(),
    insertSlashChip: vi.fn(),
    insertFileChip: vi.fn(),
    focus: vi.fn(),
    insertTextAtCursor: vi.fn(),
    ...overrides,
  } as unknown as ComposerInputInstance
}

/** mock DraftStore（ADR-0049：窄接口替代 Map<string,string>，spy 可断言调用） */
function makeDraftStore(initial?: Map<string, string>): DraftStore & { _store: Map<string, string> } {
  const store = initial ?? new Map<string, string>()
  return {
    _store: store,
    getDraft: vi.fn((sid: string) => store.get(sid) ?? ''),
    saveDraft: vi.fn((sid: string, text: string) => store.set(sid, text)),
    deleteDraft: vi.fn((sid: string) => store.delete(sid)),
  }
}

/** setup：构造 ComposerRestoreDeps（draft/inputRef/draftStore/sessionId） */
function setup(sessionId: string | null = 's1') {
  const draft = ref('')
  const inputRef = ref<ComposerInputInstance | null>(makeInputInstance())
  const drafts = makeDraftStore()
  const deps: ComposerRestoreDeps = {
    draft,
    inputRef,
    drafts,
    sessionId: ref(sessionId),
  }
  const api = useComposerRestore(deps)
  return { draft, inputRef, drafts, deps, ...api }
}

describe('useComposerRestore clearInput', () => {
  it('sid 非空：draft 置空 + drafts.deleteDraft(sid) + inputRef.clear()', () => {
    const c = setup('s1')
    c.drafts.saveDraft('s1', '保留草稿')
    c.draft.value = '待发送'
    c.clearInput()
    expect(c.draft.value).toBe('')
    // ADR-0049：deleteDraft 经工厂 cleanup 移除分区（spy 验证调用）
    expect(c.drafts.deleteDraft).toHaveBeenCalledWith('s1')
    expect(c.drafts._store.has('s1')).toBe(false)
    expect(c.inputRef.value?.clear).toHaveBeenCalled()
  })

  it('sid=null：draft 置空 + 不调 deleteDraft + 仍调 inputRef.clear()', () => {
    const c = setup(null)
    c.drafts.saveDraft('other', '其他 session 草稿')
    c.draft.value = 'x'
    c.clearInput()
    expect(c.draft.value).toBe('')
    // sid 为 null 时不调 drafts.deleteDraft（边界：landing 态）
    expect(c.drafts.deleteDraft).not.toHaveBeenCalled()
    expect(c.drafts._store.has('other')).toBe(true)
    expect(c.inputRef.value?.clear).toHaveBeenCalled()
  })

  it('inputRef 为 null：clearInput 不抛错', () => {
    const c = setup('s1')
    c.deps.inputRef.value = null
    expect(() => c.clearInput()).not.toThrow()
    expect(c.draft.value).toBe('')
  })
})

describe('useComposerRestore restoreInput', () => {
  it('draft 同步 + inputRef.setText(text)', () => {
    const c = setup('s1')
    c.restoreInput('恢复文本')
    expect(c.draft.value).toBe('恢复文本')
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('恢复文本')
  })
})

describe('useComposerRestore restoreSegments', () => {
  it('纯 text 段：过滤 join 后 restoreInput，不调任何 insert chip', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('hello world')
    expect(c.inputRef.value?.insertImageBadge).not.toHaveBeenCalled()
    expect(c.inputRef.value?.insertSlashChip).not.toHaveBeenCalled()
    expect(c.inputRef.value?.insertFileChip).not.toHaveBeenCalled()
  })

  it('image 段 needsMigrate undefined → insertImageBadge 第 4 参走 ?? false（空值合并分支）', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'text', text: '看图' },
      { type: 'image', id: 'i1', path: '/tmp/a.png', fileName: 'a.png', displayName: '截图.png' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('看图')
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/tmp/a.png', 'a.png', '截图.png', false)
  })

  it('image 段 needsMigrate=true → insertImageBadge 第 4 参传 true', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      {
        type: 'image',
        id: 'i2',
        path: '/tmp/b.png',
        fileName: 'b.png',
        displayName: 'b.png',
        needsMigrate: true,
      },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/tmp/b.png', 'b.png', 'b.png', true)
  })

  it('skill 段 → insertSlashChip(`/skill:${name}`) 前缀拼接', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'skill', name: 'cw-cli' }]
    c.restoreSegments(segments)
    // 纯 skill 段（无 text）→ restoreInput('') 先调 setText('')
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('')
    expect(c.inputRef.value?.insertSlashChip).toHaveBeenCalledWith('/skill:cw-cli')
  })

  it('file 段带 lineRange → insertFileChip(path, lineRange) 透传', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'file', path: '/a.ts', lineRange: [10, 20] }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertFileChip).toHaveBeenCalledWith('/a.ts', [10, 20])
  })

  it('file 段无 lineRange → insertFileChip(path, undefined)', () => {
    const c = setup('s1')
    const segments: Segment[] = [{ type: 'file', path: '/b.ts' }]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.insertFileChip).toHaveBeenCalledWith('/b.ts', undefined)
  })

  it('混合 4 类型：先 restoreInput(text 拼接) 再按序 insert 各 chip', () => {
    const c = setup('s1')
    const segments: Segment[] = [
      { type: 'text', text: 'pre ' },
      { type: 'image', id: 'i', path: '/i.png', fileName: 'i.png', displayName: 'i.png', needsMigrate: false },
      { type: 'skill', name: 's' },
      { type: 'file', path: '/f.ts', lineRange: [1, 2] },
      { type: 'text', text: ' post' },
    ]
    c.restoreSegments(segments)
    expect(c.inputRef.value?.setText).toHaveBeenCalledWith('pre  post')
    expect(c.inputRef.value?.insertImageBadge).toHaveBeenCalledWith('/i.png', 'i.png', 'i.png', false)
    expect(c.inputRef.value?.insertSlashChip).toHaveBeenCalledWith('/skill:s')
    expect(c.inputRef.value?.insertFileChip).toHaveBeenCalledWith('/f.ts', [1, 2])
  })
})
