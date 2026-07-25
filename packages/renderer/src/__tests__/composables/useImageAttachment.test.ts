/**
 * useImageAttachment 单测 —— Cmd+V 图片粘贴的三路径降级矩阵（C3 契约）。
 *
 * 覆盖：
 * - TC1: 成功 → {kind:'badge', path, name}（mock writeTmpImage resolve）
 * - TC4: writeTmpImage reject → {kind:'text', text:'[图片粘贴失败]'} 降级
 * - TC5: writeTmpImage resolve(undefined)（非 electron）→ {kind:'text', text:'[图片粘贴：需桌面环境]'}
 * - noop: metaKey=false → {kind:'noop'}
 * - 读 blob 失败 → {kind:'text', text:'[图片读取失败]'}
 *
 * mock 策略：vi.mock('@/lib/ipc') 替换 writeTmpImage 三态；FileReader 用 jsdom 原生实现。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useImageAttachment.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleImagePaste } from '@/composables/panel/useImageAttachment'

// writeTmpImage 可被每个测试替换三态：resolve({path,name}) / resolve(undefined) / reject
const writeTmpImageMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ipc', () => ({
  writeTmpImage: writeTmpImageMock,
}))

/** 构造最小 PNG（8 字节签名 + IHDR 占位，足够 FileReader.readAsArrayBuffer 产出非空 base64） */
function makePngFile(): File {
  // PNG signature + fake IHDR chunk（内容不要求是合法 PNG，只要求能读成 ArrayBuffer 转 base64）
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
  ])
  return new File([bytes], 'image.png', { type: 'image/png' })
}

describe('useImageAttachment: handleImagePaste 降级矩阵', () => {
  beforeEach(() => {
    writeTmpImageMock.mockReset()
  })

  it('TC1: writeTmpImage 成功 → {kind:badge, path, name}', async () => {
    writeTmpImageMock.mockResolvedValueOnce({ path: '/tmp/xyz-img-x.png', name: 'xyz-img-x.png' })
    const result = await handleImagePaste(makePngFile(), { metaKey: true })
    expect(result).toEqual({ kind: 'badge', path: '/tmp/xyz-img-x.png', name: 'xyz-img-x.png' })
    // writeTmpImage 收到 base64 非空 + mimeType='image/png'
    expect(writeTmpImageMock).toHaveBeenCalledTimes(1)
    const payload = writeTmpImageMock.mock.calls[0][0]
    expect(payload.mimeType).toBe('image/png')
    expect(payload.base64.length).toBeGreaterThan(0)
  })

  it('TC4: writeTmpImage reject → {kind:text, text:[图片粘贴失败]} 降级', async () => {
    writeTmpImageMock.mockRejectedValueOnce(new Error('write failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handleImagePaste(makePngFile(), { metaKey: true })
    expect(result).toEqual({ kind: 'text', text: '[图片粘贴失败]' })
    errSpy.mockRestore()
  })

  it('TC5: writeTmpImage resolve(undefined)（非 electron）→ {kind:text, text:[图片粘贴：需桌面环境]}', async () => {
    writeTmpImageMock.mockResolvedValueOnce(undefined)
    const result = await handleImagePaste(makePngFile(), { metaKey: true })
    expect(result).toEqual({ kind: 'text', text: '[图片粘贴：需桌面环境]' })
  })

  it('metaKey=false → {kind:noop}（Ctrl+V 路径文本通路，onPaste 自行处理）', async () => {
    const result = await handleImagePaste(makePngFile(), { metaKey: false })
    expect(result).toEqual({ kind: 'noop' })
    // noop 不应调 writeTmpImage
    expect(writeTmpImageMock).not.toHaveBeenCalled()
  })

  it('读 blob 失败（FileReader.onerror）→ {kind:text, text:[图片读取失败]}', async () => {
    // 构造会触发 FileReader.onerror 的 blob：传入无效 Blob（readAsArrayBuffer 在某些实现下 onerror）
    // jsdom 的 FileReader 对空 ArrayBuffer 不会 onerror，这里用 spy 强制触发 error 事件
    const file = makePngFile()
    const orig = globalThis.FileReader
    class FailReader extends orig {
      override readAsArrayBuffer(_blob: Blob): void {
        // 模拟读取失败：异步派发 error
        setTimeout(() => {
          Object.defineProperty(this, 'error', { value: new Error('read fail'), configurable: true })
          this.dispatchEvent(new Event('error'))
        }, 0)
      }
    }
    globalThis.FileReader = FailReader as unknown as typeof FileReader
    try {
      const result = await handleImagePaste(file, { metaKey: true })
      expect(result).toEqual({ kind: 'text', text: '[图片读取失败]' })
    } finally {
      globalThis.FileReader = orig
    }
  })
})
