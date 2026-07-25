/**
 * insertImageBadge + getSegmentsFromEl image 分支单测（TC6/TC7）。
 *
 * 覆盖：
 * - TC6: insertImageBadge(path, name) 创建 .image-chip span + dataset + chip-label + chip-x + ZWSP spacer + 光标定位
 * - TC7: getSegmentsFromEl 解析 image-chip → {type:image,path,name}，跳子树（label/x 文本不污染）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useComposerChipCommands.image.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useComposerChipCommands } from '@/composables/useComposerChipCommands'
import { getSegmentsFromEl } from '@/composables/panel/useContenteditableInput'

/** 创建挂载在 document 上的 contenteditable div + chipCommands 实例（同 file-chip.test 范式） */
function setupChipCommands(): {
  el: HTMLDivElement
  chipCommands: ReturnType<typeof useComposerChipCommands>
} {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  const elRef = ref(el)
  window.getSelection()?.removeAllRanges()
  const onChanged = vi.fn()
  const restoreSelection = vi.fn()
  const chipCommands = useComposerChipCommands(elRef as never, { onChanged, restoreSelection })
  return { el, chipCommands }
}

describe('TC6: insertImageBadge DOM 结构', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('创建 .image-chip span + dataset + label + x + ZWSP spacer', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertImageBadge('/tmp/x.png', 'x.png')

    const chip = el.querySelector('.image-chip') as HTMLElement
    expect(chip).toBeTruthy()
    // 复用 mention-chip 基础样式（TO2）+ image-chip 修饰
    expect(chip.classList.contains('mention-chip')).toBe(true)
    expect(chip.classList.contains('image-chip')).toBe(true)
    expect(chip.contentEditable).toBe('false')
    // C2 DOM schema：dataset 结构化标记
    expect(chip.dataset.chipType).toBe('image')
    expect(chip.dataset.chipPath).toBe('/tmp/x.png')
    expect(chip.dataset.chipName).toBe('x.png')
    // C3：chipId 是稳定唯一 uuid（crypto.randomUUID），同一文件附两次时 ContextChipsBar :key 用它区分
    expect(chip.dataset.chipId).toBeTruthy()
    expect(chip.dataset.chipId.length).toBeGreaterThan(0)
    // 子元素：chip-label（显 name）+ chip-x
    const label = chip.querySelector('.chip-label') as HTMLElement
    expect(label).toBeTruthy()
    expect(label.textContent).toBe('x.png')
    expect(chip.querySelector('.chip-x')).toBeTruthy()
    // 后跟 ZWSP spacer 文本节点
    const spacer = chip.nextSibling
    expect(spacer?.nodeType).toBe(Node.TEXT_NODE)
    expect(spacer?.textContent).toBe('\u200B')
  })

  it('C3: 同一文件附两次 → 两个 chip 各有唯一 chipId（path 重复但 id 不冲突）', () => {
    const { el, chipCommands } = setupChipCommands()
    chipCommands.insertImageBadge('/tmp/dup.png', 'dup.png')
    chipCommands.insertImageBadge('/tmp/dup.png', 'dup.png')

    const chips = el.querySelectorAll<HTMLElement>('.image-chip')
    expect(chips.length).toBe(2)
    // path 相同（同一文件），id 必须不同（否则 ContextChipsBar :key 冲突）
    expect(chips[0].dataset.chipPath).toBe('/tmp/dup.png')
    expect(chips[1].dataset.chipPath).toBe('/tmp/dup.png')
    expect(chips[0].dataset.chipId).not.toBe(chips[1].dataset.chipId)
  })

  it('onChanged 被调用', () => {
    const { chipCommands } = setupChipCommands()
    // 重新 setup 拿到 onChanged（上面 setupChipCommands 内部已 vi.fn，这里独立验证）
    const onChanged = vi.fn()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const cc = useComposerChipCommands(ref(el) as never, { onChanged, restoreSelection: vi.fn() })
    cc.insertImageBadge('/tmp/a.png', 'a.png')
    expect(onChanged).toHaveBeenCalled()
  })
})

describe('TC7: getSegmentsFromEl image 分支', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('解析 [text][image-chip][text] → 3 段，image chip 子树文本不污染', () => {
    const { el, chipCommands } = setupChipCommands()
    el.textContent = 'hello'
    chipCommands.insertImageBadge('/tmp/a.png', 'a.png')
    // chip 后追加文本
    el.querySelector('.image-chip')?.after(document.createTextNode('world'))

    const segments = getSegmentsFromEl(el)
    expect(segments).toEqual([
      { type: 'text', text: 'hello' },
      // C3：image segment 含稳定唯一 id（chip.dataset.chipId 的 uuid）
      { type: 'image', id: expect.any(String), path: '/tmp/a.png', name: 'a.png' },
      { type: 'text', text: 'world' },
    ])
    // chip-label 'a.png' 与 chip-x '×' 不出现在任何 text segment（rejectChipSubtree 生效）
    const textContent = segments
      .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
      .map((s) => s.text)
      .join('')
    expect(textContent).not.toContain('×')
  })
})
