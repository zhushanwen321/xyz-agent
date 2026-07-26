/**
 * lib/ipc pickFile 封装单测（TC1，slice5 attach-dragdrop-menu）。
 *
 * 覆盖：
 * - TC1a: web/mock 环境（window.electronAPI 无 pickFile）→ 返回 {canceled:true, path:null}，不 throw
 * - TC1b: api.pickFile 存在 → 透传 options 并返回其结果
 *
 * 注意：lib/ipc.ts 顶层 `const api = window.electronAPI` 在模块加载时捕获，
 * 故须在 import 前设置 window.electronAPI，用动态 import + vi.resetModules 隔离每用例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/ipc-pick-file.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('lib/ipc pickFile 封装（TC1）', () => {
  beforeEach(() => {
    vi.resetModules()
    // 清掉可能的 electronAPI 残留，每用例自行设置
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('TC1a: 无 preload（api.pickFile 不存在）→ 返回 {canceled:true, path:null}，不 throw', async () => {
    // 不设置 window.electronAPI（模拟 web/mock 环境）
    const { pickFile } = await import('@/lib/ipc')
    const result = await pickFile()
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('TC1a-variant: electronAPI 存在但无 pickFile → 同样降级', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {} // 有 api 但无 pickFile
    const { pickFile } = await import('@/lib/ipc')
    const result = await pickFile()
    expect(result).toEqual({ canceled: true, path: null })
  })

  it('TC1b: api.pickFile 存在 → 透传 options 并返回其结果', async () => {
    const pickFileImpl = vi.fn().mockResolvedValue({ canceled: false, path: '/a/b.png' })
    ;(window as { electronAPI?: unknown }).electronAPI = { pickFile: pickFileImpl }
    const { pickFile } = await import('@/lib/ipc')
    const options = { filters: [{ name: 'Images', extensions: ['png', 'jpg'] }] }
    const result = await pickFile(options)
    expect(result).toEqual({ canceled: false, path: '/a/b.png' })
    expect(pickFileImpl).toHaveBeenCalledWith(options)
  })

  it('TC1b-default: 不传 options → pickFile 以 undefined 调用', async () => {
    const pickFileImpl = vi.fn().mockResolvedValue({ canceled: false, path: '/x.txt' })
    ;(window as { electronAPI?: unknown }).electronAPI = { pickFile: pickFileImpl }
    const { pickFile } = await import('@/lib/ipc')
    await pickFile()
    expect(pickFileImpl).toHaveBeenCalledWith(undefined)
  })
})
