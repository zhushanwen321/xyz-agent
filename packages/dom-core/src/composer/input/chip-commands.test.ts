/**
 * chip-commands.ts composable 单测 —— composer input 模块 chip DOM 创建/删除（W2 TC）。
 *
 * 覆盖：insertSlashChip（skill/slash 分发 + dataset + spacer + 图标注入两路）、insertFileChip
 * （lineRange 序列化 + 选区插入/appendChild 两路）、insertImageBadge（crypto id + metadata）、
 * insertMentionChip（@ chip + # 委托 insertFileChip）、handleBackspaceOnChip（TEXT_NODE offset 0 /
 * spacer 末尾 / 中段 / element 容器 chip / 非 chip / null el / 无选区）。
 *
 * 运行：cd packages/dom-core && npx vitest run src/composer/input/chip-commands.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerChipCommands } from './chip-commands'
import { getSegmentsFromEl } from './input-dom'
import type { ChipCallbacks } from './types'

/** mock ChipCallbacks 工厂（renderIcon 默认返回 true = 挂载图标） */
function makeCallbacks(overrides: Partial<ChipCallbacks> = {}): ChipCallbacks {
  return {
    onChanged: vi.fn(),
    restoreSelection: vi.fn(),
    renderIcon: vi.fn(() => true),
    t: vi.fn((key: string) => key),
    ...overrides,
  }
}

/** setup：创建 el 挂 body + elRef + composable */
function setup(initialHtml = '', overrides: Partial<ChipCallbacks> = {}) {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = initialHtml
  document.body.appendChild(el)
  const elRef = ref(el)
  const callbacks = makeCallbacks(overrides)
  const api = useComposerChipCommands(elRef, callbacks)
  return { el, elRef, callbacks, ...api, cleanup: () => document.body.removeChild(el) }
}

/** 把光标定位到指定节点的 offset 处（collapsed） */
function setCursor(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('useComposerChipCommands insertSlashChip', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
    cleanup = () => {} // 每个用例自决；el-null 用例无 DOM，留 noop 防上一个用例的 cleanup 重复 removeChild
  })
  afterEach(() => {
    cleanup?.()
  })

  it('skill 命令 (/skill:name)：dataset.chipType=skill + chipName=name + label=name + contentEditable=false', () => {
    const c = setup()
    c.insertSlashChip('/skill:cw-cli', 'terminal')
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipType).toBe('skill')
    expect(chip.dataset.chipName).toBe('cw-cli')
    expect(chip.contentEditable).toBe('false')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('cw-cli')
    // 图标注入（renderIcon 返回 true → .chip-icon 已挂载）
    expect(chip.querySelector('.chip-icon')).not.toBeNull()
    expect(c.callbacks.renderIcon).toHaveBeenCalledWith(expect.any(HTMLElement), 'terminal')
    // × 删除按钮（aria-label 经 t 注入）
    const xBtn = chip.querySelector('.chip-x') as HTMLElement
    expect(xBtn).not.toBeNull()
    expect(xBtn.getAttribute('role')).toBe('button')
    expect(xBtn.getAttribute('aria-label')).toBe('composable.removeLabel')
    expect(xBtn.textContent).toBe('×')
    // chip 插在最前 + 后跟 ZWSP spacer
    expect(c.el.firstChild).toBe(chip)
    expect(c.el.lastChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(c.el.lastChild?.textContent).toBe('\u200B')
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('slash 命令 (/commit)：dataset.chipType=slash + chipName 去掉 / + label 补回 /', () => {
    const c = setup()
    c.insertSlashChip('/commit')
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(chip.dataset.chipType).toBe('slash')
    expect(chip.dataset.chipName).toBe('commit')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('/commit')
    cleanup = c.cleanup
  })

  it('slash 命令无前缀 (commit)：chipName=commit + label 补 / 前缀', () => {
    const c = setup()
    c.insertSlashChip('commit')
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(chip.dataset.chipName).toBe('commit')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('/commit')
    cleanup = c.cleanup
  })

  it('重复插入：先清除已存在的 slash-chip（只保留一个）', () => {
    const c = setup('<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/old</span></span>hi')
    c.insertSlashChip('/new')
    expect(c.el.querySelectorAll('.slash-chip').length).toBe(1)
    expect((c.el.querySelector('.slash-chip .chip-label') as HTMLElement)?.textContent).toBe('/new')
    cleanup = c.cleanup
  })

  it('renderIcon 返回 false：不挂载 .chip-icon host', () => {
    const c = setup('', { renderIcon: vi.fn(() => false) })
    c.insertSlashChip('/commit', 'wrench')
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(c.callbacks.renderIcon).toHaveBeenCalledWith(expect.any(HTMLElement), 'wrench')
    expect(chip.querySelector('.chip-icon')).toBeNull()
    cleanup = c.cleanup
  })

  it('el 为 null：直接返回，不触发 onChanged', () => {
    const callbacks = makeCallbacks()
    const api = useComposerChipCommands(ref<HTMLDivElement | null>(null), callbacks)
    expect(() => api.insertSlashChip('/x')).not.toThrow()
    expect(callbacks.onChanged).not.toHaveBeenCalled()
  })
})

describe('useComposerChipCommands insertFileChip', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('无选区（rangeCount=0）走 appendChild + 无 lineRange：dataset.chipType=file + label=path', () => {
    const c = setup()
    c.insertFileChip('/a/b.ts')
    const chip = c.el.querySelector('.mention-file') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('/a/b.ts')
    expect(chip.dataset.chipLineStart).toBeUndefined()
    expect(chip.querySelector('.chip-label')?.textContent).toBe('/a/b.ts')
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('lineRange 多行 (start≠end)：dataset.chipLineStart/End + label=L{s}-L{e}', () => {
    const c = setup()
    c.insertFileChip('/a.ts', [10, 20])
    const chip = c.el.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('/a.ts:L10-L20')
    cleanup = c.cleanup
  })

  it('lineRange 单行 (start===end)：label=L{s}', () => {
    const c = setup()
    c.insertFileChip('/a.ts', [7, 7])
    const chip = c.el.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('7')
    expect(chip.dataset.chipLineEnd).toBe('7')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('/a.ts:L7')
    cleanup = c.cleanup
  })

  it('有选区：走 range.deleteContents + insertNode（chip 落在选区位置）', () => {
    const c = setup('hello')
    const textNode = c.el.firstChild as Text
    setCursor(textNode, 2) // 折叠选区在 "he|llo"
    c.insertFileChip('/mid.ts')
    const chip = c.el.querySelector('.mention-file') as HTMLElement
    expect(chip).not.toBeNull()
    expect(c.el.contains(chip)).toBe(true)
    expect(chip.dataset.chipPath).toBe('/mid.ts')
    cleanup = c.cleanup
  })
})

describe('useComposerChipCommands insertImageBadge', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('crypto id + 全量 metadata：dataset.chipType=image + chipId(UUID) + path/fileName/displayName', () => {
    const c = setup()
    c.insertImageBadge('/tmp/x.png', 'dbfdb3c8-x.png', '截图.png')
    const chip = c.el.querySelector('.image-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipType).toBe('image')
    expect(chip.dataset.chipId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(chip.dataset.chipPath).toBe('/tmp/x.png')
    expect(chip.dataset.chipFileName).toBe('dbfdb3c8-x.png')
    expect(chip.dataset.chipDisplayName).toBe('截图.png')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('截图.png')
    cleanup = c.cleanup
  })

  it('needsMigrate 默认 false（不传第 4 参）→ dataset.chipNeedsMigrate=false', () => {
    const c = setup()
    c.insertImageBadge('/p.png', 'p.png', 'p.png')
    expect((c.el.querySelector('.image-chip') as HTMLElement).dataset.chipNeedsMigrate).toBe('false')
    cleanup = c.cleanup
  })

  it('needsMigrate=true → dataset.chipNeedsMigrate=true', () => {
    const c = setup()
    c.insertImageBadge('/p.png', 'p.png', 'p.png', true)
    expect((c.el.querySelector('.image-chip') as HTMLElement).dataset.chipNeedsMigrate).toBe('true')
    cleanup = c.cleanup
  })
})

describe('useComposerChipCommands insertMentionChip', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('@ 类型：mention-at chip + 文本=@{name}', () => {
    const c = setup()
    c.insertMentionChip('@', 'alice')
    const chip = c.el.querySelector('.mention-at') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toBe('@alice')
    cleanup = c.cleanup
  })

  it('# 类型：委托 insertFileChip（产出 mention-file chip）', () => {
    const c = setup()
    c.insertMentionChip('#', '/path/file.ts')
    const fileChip = c.el.querySelector('.mention-file') as HTMLElement
    expect(fileChip).not.toBeNull()
    expect(fileChip.dataset.chipPath).toBe('/path/file.ts')
    // 不产 mention-at chip
    expect(c.el.querySelector('.mention-at')).toBeNull()
    cleanup = c.cleanup
  })
})

describe('useComposerChipCommands insertSessionChip', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('class=mention-session + dataset 三件套 + label 文本 + × 按钮 + spacer', () => {
    const c = setup()
    c.insertSessionChip('019e-abc-123', 'fix-com 设计讨论')
    const chip = c.el.querySelector('.mention-session') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipType).toBe('session')
    expect(chip.dataset.chipSessionId).toBe('019e-abc-123')
    expect(chip.dataset.chipLabel).toBe('fix-com 设计讨论')
    expect(chip.contentEditable).toBe('false')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('fix-com 设计讨论')
    // × 删除按钮（对齐 insertFileChip 结构惯例）
    expect(chip.querySelector('.chip-x')).not.toBeNull()
    // ZWSP spacer + 光标定位
    expect(c.el.lastChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(c.el.lastChild?.textContent).toBe('\u200B')
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('有选区：chip 落在光标处（range.insertNode）', () => {
    const c = setup('hello')
    const textNode = c.el.firstChild as Text
    setCursor(textNode, 5)
    c.insertSessionChip('s1', '会话 A')
    const chip = c.el.querySelector('.mention-session') as HTMLElement
    expect(chip).not.toBeNull()
    expect(c.el.contains(chip)).toBe(true)
    cleanup = c.cleanup
  })

  it('往返：insertSessionChip → getSegmentsFromEl 产出 session segment', () => {
    const c = setup()
    c.insertSessionChip('019e-abc-123', '设计讨论')
    expect(getSegmentsFromEl(c.el)).toEqual([
      { type: 'session', sessionId: '019e-abc-123', label: '设计讨论' },
    ])
    cleanup = c.cleanup
  })
})

describe('useComposerChipCommands insertSubagentChip', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    cleanup?.()
  })

  it('class=mention-at（复用蓝色样式）+ dataset 三件套 + label=@slug + × 按钮（F3 修复）', () => {
    const c = setup()
    c.insertSubagentChip('sub-1', 'build-api')
    const chip = c.el.querySelector('.mention-at') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipType).toBe('subagent')
    expect(chip.dataset.chipSubagentId).toBe('sub-1')
    expect(chip.dataset.chipSlug).toBe('build-api')
    expect(chip.contentEditable).toBe('false')
    expect(chip.querySelector('.chip-label')?.textContent).toBe('@build-api')
    // 旧 mention-at 无 × 按钮的问题（F3）在新 chip 修复
    expect(chip.querySelector('.chip-x')).not.toBeNull()
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('往返：insertSubagentChip → getSegmentsFromEl 产出 subagent segment', () => {
    const c = setup()
    c.insertSubagentChip('sub-1', 'build-api')
    expect(getSegmentsFromEl(c.el)).toEqual([
      { type: 'subagent', subagentId: 'sub-1', slug: 'build-api' },
    ])
    cleanup = c.cleanup
  })

  it('往返：subagent chip + 文本混合 → segment 顺序正确', () => {
    const c = setup()
    c.insertSubagentChip('sub-1', 'build-api')
    // 在 spacer 后追加文本（模拟用户 chip 后继续输入）
    const spacer = c.el.lastChild as Text
    spacer.after(document.createTextNode('汇报进度'))
    expect(getSegmentsFromEl(c.el)).toEqual([
      { type: 'subagent', subagentId: 'sub-1', slug: 'build-api' },
      { type: 'text', text: '汇报进度' },
    ])
    cleanup = c.cleanup
  })
})

describe('useComposerChipCommands handleBackspaceOnChip', () => {
  let cleanup: () => void
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
    cleanup = () => {} // 每个用例自决；el-null 用例无 DOM，留 noop 防上一个用例的 cleanup 重复 removeChild
  })
  afterEach(() => {
    cleanup?.()
  })

  it('TEXT_NODE offset===0 + 前邻 slash-chip：删 chip 返回 true', () => {
    const c = setup('<span class="slash-chip">chip</span>hello')
    const textNode = c.el.lastChild as Text // "hello"
    setCursor(textNode, 0)
    const chip = c.el.querySelector('.slash-chip') as HTMLElement
    expect(c.handleBackspaceOnChip()).toBe(true)
    expect(c.el.contains(chip)).toBe(false)
    expect(c.callbacks.onChanged).toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('TEXT_NODE spacer 末尾 (ZWSP) + 前邻 mention-chip：删 chip 返回 true', () => {
    const c = setup('')
    const chip = document.createElement('span')
    chip.className = 'mention-chip'
    chip.textContent = '@x'
    c.el.appendChild(chip)
    const spacer = document.createTextNode('\u200B') // ZWSP spacer
    c.el.appendChild(spacer)
    setCursor(spacer, 1) // offset === text.length(1)，isSpacerNode true
    expect(c.handleBackspaceOnChip()).toBe(true)
    expect(c.el.contains(chip)).toBe(false)
    cleanup = c.cleanup
  })

  it('TEXT_NODE 中段 (offset>0 且非 spacer 末尾)：返回 false 不删', () => {
    const c = setup('hello')
    const textNode = c.el.firstChild as Text
    setCursor(textNode, 2) // 中段
    expect(c.handleBackspaceOnChip()).toBe(false)
    expect(c.callbacks.onChanged).not.toHaveBeenCalled()
    cleanup = c.cleanup
  })

  it('element 容器 + offset 指向前一个 chip：删 chip 返回 true', () => {
    const c = setup('<span class="mention-chip">@x</span><span>other</span>')
    // startContainer = el（element），startOffset = 1 → prev = childNodes[0] = mention-chip
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(c.el, 1)
    range.collapse(true)
    sel?.addRange(range)
    const chip = c.el.querySelector('.mention-chip') as HTMLElement
    expect(c.handleBackspaceOnChip()).toBe(true)
    expect(c.el.contains(chip)).toBe(false)
    cleanup = c.cleanup
  })

  it('element 容器 + prev 非 chip（如 <br>）：返回 false', () => {
    const c = setup('<br>text')
    const sel = window.getSelection()
    sel?.removeAllRanges()
    const range = document.createRange()
    range.setStart(c.el, 1) // prev = childNodes[0] = <br>（element 但无 chip class）
    range.collapse(true)
    sel?.addRange(range)
    expect(c.handleBackspaceOnChip()).toBe(false)
    cleanup = c.cleanup
  })

  it('新 session / subagent chip 被 .mention-chip 选择器天然覆盖（Backspace 整删验证）', () => {
    // insertSessionChip/insertSubagentChip 的 class 都含 mention-chip → 整删分支命中
    const c = setup()
    c.insertSessionChip('s1', '会话 A')
    c.insertSubagentChip('sub-1', 'build-api')
    expect(c.el.querySelectorAll('.mention-chip').length).toBe(2)
    // 光标移到末尾 spacer 后，Backspace 整删最后一个 chip（subagent chip）
    const lastSpacer = c.el.lastChild as Text // insertChipAtSelection 的 ZWSP
    setCursor(lastSpacer, 1)
    expect(c.handleBackspaceOnChip()).toBe(true)
    const remaining = c.el.querySelectorAll<HTMLElement>('.mention-chip')
    expect(remaining.length).toBe(1)
    expect(remaining[0].dataset.chipType).toBe('session')
    cleanup = c.cleanup
  })

  it('无选区 (rangeCount=0)：返回 false', () => {
    const c = setup('hello')
    window.getSelection()?.removeAllRanges()
    expect(c.handleBackspaceOnChip()).toBe(false)
    cleanup = c.cleanup
  })

  it('el 为 null：返回 false', () => {
    const callbacks = makeCallbacks()
    const api = useComposerChipCommands(ref<HTMLDivElement | null>(null), callbacks)
    expect(api.handleBackspaceOnChip()).toBe(false)
  })
})
