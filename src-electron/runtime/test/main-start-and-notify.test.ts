import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

// RuntimeManager import 了 electron（仅方法内访问 app；类型位置用 BrowserWindow）。
// 提供 stub 隔离 electron 在纯 node 环境下的副作用。start() 被 spy 后 app 不被访问。
vi.mock('electron', () => ({ app: {} }))

import { RuntimeManager } from '../../main/runtime-manager.js'

// startAndNotify 的 win 参数最小结构契约
function createMockWin(): { win: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const win = { webContents: { send } } as unknown as BrowserWindow
  return { win, send }
}

describe('RuntimeManager.startAndNotify', () => {
  let rm: RuntimeManager
  let startSpy: ReturnType<typeof vi.spyOn>
  let send: ReturnType<typeof vi.fn>
  let win: BrowserWindow

  beforeEach(() => {
    rm = new RuntimeManager()
    ;({ win, send } = createMockWin())
    startSpy = vi.spyOn(rm, 'start').mockResolvedValue(3210)
  })

  it('成功时调 start() 并通知 runtime-port', async () => {
    await rm.startAndNotify(win)

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('runtime-port', 3210)
  })

  it('start 抛错时通知 runtime-error 并打 error 日志', async () => {
    const err = new Error('boom')
    startSpy.mockRejectedValueOnce(err)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await rm.startAndNotify(win)

    expect(send).toHaveBeenCalledWith('runtime-error', { message: 'boom' })
    expect(errSpy).toHaveBeenCalledWith('[main] Failed to start runtime, notifying renderer:', err)
    errSpy.mockRestore()
  })

  it('幂等：连续两次调用都走 start()，第二次不抛', async () => {
    await rm.startAndNotify(win)
    await rm.startAndNotify(win)

    expect(startSpy).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('runtime-port', 3210)
  })
})
