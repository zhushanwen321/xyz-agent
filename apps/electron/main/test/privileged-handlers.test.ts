/**
 * W7: pick-directory IPC handler 的 try/catch 风格一致性。
 *
 * 背景：同文件 open-external 有 try/catch + 返回 false 降级，pick-directory 没有，
 * 靠 ipcMain.handle 的 invoke rejection 兜底（renderer openDirDialog catch 接住）。
 * 不是 bug，但风格不一致，维护者易误判为「故意吞错」。
 *
 * 修复：pick-directory 补 try/catch，dialog 抛异常时返回 {canceled:true, path:null}，
 * 与 getFocusedWindow null 的降级 + open-external 风格对称。
 *
 * Mock 策略：vi.mock('electron') 注入 ipcMain.handle 捕获 handler、dialog 控制抛错/返回。
 *
 * 运行：cd apps/electron/main && npx vitest run test/privileged-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 捕获注册的 handler（key=channel, value=handler fn），由 ipcMain.handle 桩写入
const handlers = new Map<string, (...args: unknown[]) => unknown>()
// dialog.showOpenDialog 可被测试替换：默认正常，测试 2 替换为 reject
const dialogMock = vi.hoisted(() => ({
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/picked'] })),
}))
const shellMock = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})), // 默认有聚焦窗口
    fromWebContents: vi.fn(() => ({})),
  },
  dialog: dialogMock,
  shell: shellMock,
}))

import { registerPrivilegedHandlers } from '../gateway/privileged-handlers.js'

describe('W7: pick-directory IPC try/catch 一致性', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerPrivilegedHandlers({} as never)
  })

  it('dialog 正常返回选中目录 → handler 返回 {canceled:false, path}', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/my/repo'] })
    const pickDir = handlers.get('pick-directory')!
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: false, path: '/my/repo' })
  })

  it('dialog 抛异常 → handler 返回 {canceled:true, path:null} 不 reject', async () => {
    dialogMock.showOpenDialog.mockRejectedValueOnce(new Error('dialog crash'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const pickDir = handlers.get('pick-directory')!
    // 不该抛（ipcMain.handle 的 rejection 兜底虽存在，但本修复要求 handler 自身降级）
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: true, path: null })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('用户取消 → handler 返回 {canceled:true, path:null}（既有降级回归防护）', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const pickDir = handlers.get('pick-directory')!
    const result = await pickDir({}, {})
    expect(result).toEqual({ canceled: true, path: null })
  })
})
