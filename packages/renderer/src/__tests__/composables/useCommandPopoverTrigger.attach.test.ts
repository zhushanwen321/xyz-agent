/**
 * useCommandPopoverTrigger onAddSelect attach/image 分支单测（TC2/TC3，slice5 attach-dragdrop-menu）。
 *
 * 覆盖：
 * - TC2 attach: pickFile 返回 path → insertTextAtCursor(path)；canceled → 静默 return（不调）
 * - TC3 image:  pickFile（带 image filters）返回 path → insertImageBadge(path, basename)；
 *               canceled → 静默 return
 * - pickFile reject → catch 静默 return（不 throw）
 *
 * mock 策略：vi.mock('@/lib/ipc') 替换 pickFile；inputRef 用 spy 对象（insertTextAtCursor /
 * insertImageBadge / saveSelection / focus）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useCommandPopoverTrigger.attach.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'

// pickFile 可被每测试替换：resolved path / canceled / reject
const pickFileMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc', () => ({
  pickFile: pickFileMock,
}))

import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'

/** inputRef mock：spy insertTextAtCursor / insertImageBadge / saveSelection / focus */
function createInputMock() {
  return {
    insertTextAtCursor: vi.fn(),
    insertImageBadge: vi.fn(),
    saveSelection: vi.fn(),
    focus: vi.fn(),
  }
}

/** 在独立 effectScope 内运行 composable（watch 等需 scope） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('useCommandPopoverTrigger onAddSelect attach/image（TC2/TC3）', () => {
  let dispose: () => void

  beforeEach(() => {
    setActivePinia(createPinia())
    pickFileMock.mockReset()
  })

  afterEach(() => {
    dispose?.()
  })

  it('TC2: attach + pickFile 返回 path → insertTextAtCursor(path)', async () => {
    pickFileMock.mockResolvedValue({ canceled: false, path: '/x/y.txt' })
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    await result.onAddSelect('attach')
    // attach 无 filters：pickFile 以零参数调用（不传 filters options）
    expect(pickFileMock).toHaveBeenCalledTimes(1)
    expect(pickFileMock.mock.calls[0]).toHaveLength(0)
    expect(inputMock.insertTextAtCursor).toHaveBeenCalledWith('/x/y.txt')
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('TC2: attach + pickFile canceled → 静默 return（不插任何内容）', async () => {
    pickFileMock.mockResolvedValue({ canceled: true, path: null })
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    await result.onAddSelect('attach')
    expect(inputMock.insertTextAtCursor).not.toHaveBeenCalled()
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('TC3: image + pickFile 返回 path → insertImageBadge(path, basename)，filters 含 Images', async () => {
    pickFileMock.mockResolvedValue({ canceled: false, path: '/tmp/cat.png' })
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    await result.onAddSelect('image')
    // pickFile 带 image filters
    expect(pickFileMock).toHaveBeenCalledTimes(1)
    const options = pickFileMock.mock.calls[0][0]
    expect(options.filters[0]).toEqual({
      name: 'Images',
      extensions: expect.arrayContaining(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']),
    })
    // basename 取末段
    expect(inputMock.insertImageBadge).toHaveBeenCalledWith('/tmp/cat.png', 'cat.png')
    expect(inputMock.insertTextAtCursor).not.toHaveBeenCalled()
  })

  it('TC3: image + path 无分隔符 → basename 取整 path', async () => {
    pickFileMock.mockResolvedValue({ canceled: false, path: 'plainfile.png' })
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    await result.onAddSelect('image')
    expect(inputMock.insertImageBadge).toHaveBeenCalledWith('plainfile.png', 'plainfile.png')
  })

  it('TC3: image + pickFile canceled → 静默 return', async () => {
    pickFileMock.mockResolvedValue({ canceled: true, path: null })
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    await result.onAddSelect('image')
    expect(inputMock.insertImageBadge).not.toHaveBeenCalled()
  })

  it('ES: pickFile reject → catch 静默 return（不 throw、不插内容）', async () => {
    pickFileMock.mockRejectedValue(new Error('IPC down'))
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    await expect(result.onAddSelect('attach')).resolves.toBeUndefined()
    expect(inputMock.insertTextAtCursor).not.toHaveBeenCalled()
  })
})
