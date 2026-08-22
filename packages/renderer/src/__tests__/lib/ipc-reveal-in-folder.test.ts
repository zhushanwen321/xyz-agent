/**
 * lib/ipc revealInFolder 封装单测（C2 前端接线：trace MALFORMED 行「打开所在目录」）。
 *
 * 覆盖（与 ipc-pick-file.test.ts 同范式）：
 * - web/mock 环境（window.electronAPI 无 revealInFolder）→ 静默 resolve，不 throw
 * - electronAPI.revealInFolder 存在 → 透传 filePath 并返回其结果
 *
 * 注意：lib/ipc.ts 顶层 `const api = window.electronAPI` 在模块加载时捕获，
 * 故须在 import 前设置 window.electronAPI，用动态 import + vi.resetModules 隔离每用例。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/ipc-reveal-in-folder.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('lib/ipc revealInFolder 封装（reveal-in-folder IPC）', () => {
  beforeEach(() => {
    vi.resetModules()
    // 清掉可能的 electronAPI 残留，每用例自行设置
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('无 preload（electronAPI 不存在）→ 静默 resolve，不 throw', async () => {
    // 不设置 window.electronAPI（模拟 web/mock 环境）
    const { revealInFolder } = await import('@/lib/ipc')
    await expect(revealInFolder('/a/b.jsonl')).resolves.toBeUndefined()
  })

  it('electronAPI 存在但无 revealInFolder（旧 preload）→ 同样降级', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {}
    const { revealInFolder } = await import('@/lib/ipc')
    await expect(revealInFolder('/a/b.jsonl')).resolves.toBeUndefined()
  })

  it('revealInFolder 存在 → 透传绝对路径并返回其结果', async () => {
    const impl = vi.fn().mockResolvedValue(true)
    ;(window as { electronAPI?: unknown }).electronAPI = { revealInFolder: impl }
    const { revealInFolder } = await import('@/lib/ipc')
    const result = await revealInFolder('/pi/sessions/s1.jsonl')
    expect(result).toBe(true)
    expect(impl).toHaveBeenCalledWith('/pi/sessions/s1.jsonl')
  })
})
