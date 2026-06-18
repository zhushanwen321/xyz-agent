import { describe, it, expect, vi } from 'vitest'
import type { ElectronAPI } from '../../../preload'
import { createIpcTransport } from '../ipc-transport'
import { windowApi } from '../domains/window'
import { dialogApi } from '../domains/dialog'
import { runtimePortApi } from '../domains/runtime-port'
import { systemApi } from '../domains/system'

/** 构造一个记录调用的 mock electronAPI。 */
function mockIpc(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  return {
    onRuntimePort: vi.fn(() => () => {}),
    onRuntimeError: vi.fn(() => () => {}),
    onShortcut: vi.fn(() => () => {}),
    getRuntimePort: vi.fn(() => Promise.resolve(7456)),
    getRuntimePortOffset: vi.fn(() => Promise.resolve(100)),
    createWindow: vi.fn(() => Promise.resolve({ windowId: 'w-2' })),
    getWindows: vi.fn(() => Promise.resolve([])),
    focusWindow: vi.fn(() => Promise.resolve()),
    findSessionWindow: vi.fn(() => Promise.resolve(null)),
    updateWindowState: vi.fn(() => Promise.resolve()),
    onWindowCreated: vi.fn(() => () => {}),
    onWindowClosed: vi.fn(() => () => {}),
    onWindowListUpdated: vi.fn(() => () => {}),
    pickDirectory: vi.fn(() => Promise.resolve({ canceled: false, path: '/x' })),
    openExternal: vi.fn(() => Promise.resolve()),
    onFullscreenChanged: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as ElectronAPI
}

describe('IpcTransport + IPC domains — 转发与降级', () => {
  describe('window domain', () => {
    it('转发到 electronAPI 对应方法', async () => {
      const ipc = mockIpc()
      const w = windowApi(createIpcTransport(ipc))
      await w.create('s-1')
      expect(ipc.createWindow).toHaveBeenCalledWith('s-1')

      await w.list()
      expect(ipc.getWindows).toHaveBeenCalled()

      w.focus('w-1')
      expect(ipc.focusWindow).toHaveBeenCalledWith('w-1')

      await w.findSession('s-9')
      expect(ipc.findSessionWindow).toHaveBeenCalledWith('s-9')

      w.updateState('w-1', { panelTree: {} })
      expect(ipc.updateWindowState).toHaveBeenCalledWith('w-1', { panelTree: {} })
    })

    it('事件订阅转发并返回取消函数', () => {
      const ipc = mockIpc()
      const w = windowApi(createIpcTransport(ipc))
      const cb = vi.fn()
      const off = w.onCreated(cb)
      expect(ipc.onWindowCreated).toHaveBeenCalledWith(cb)
      expect(typeof off).toBe('function')
    })

    it('ipc 为 undefined 时优雅降级：findSession 返回 null，focus 无抛异常', async () => {
      const w = windowApi(createIpcTransport(undefined))
      expect(await w.findSession('s-1')).toBeNull()
      expect(w.focus('w-1')).toBeUndefined()
      expect(w.onListUpdated(() => {})).toBeInstanceOf(Function)
    })
  })

  describe('dialog domain', () => {
    it('转发 pickDirectory / openExternal', async () => {
      const ipc = mockIpc()
      const d = dialogApi(createIpcTransport(ipc))
      const r = await d.pickDirectory({ title: 't' })
      expect(r).toEqual({ canceled: false, path: '/x' })
      expect(ipc.pickDirectory).toHaveBeenCalledWith({ title: 't' })

      await d.openExternal('https://x')
      expect(ipc.openExternal).toHaveBeenCalledWith('https://x')
    })

    it('ipc 为 undefined 时 pickDirectory 返回 canceled', async () => {
      const d = dialogApi(createIpcTransport(undefined))
      expect(await d.pickDirectory()).toEqual({ canceled: true, path: null })
    })
  })

  describe('runtimePort domain', () => {
    it('转发端口获取与事件订阅', async () => {
      const ipc = mockIpc()
      const rp = runtimePortApi(createIpcTransport(ipc))
      expect(await rp.getPort()).toBe(7456)
      expect(await rp.getPortOffset()).toBe(100)

      const cb = vi.fn()
      const off = rp.onPort(cb)
      expect(ipc.onRuntimePort).toHaveBeenCalledWith(cb)
      off()
    })

    it('ipc 为 undefined 时 getPort 返回 undefined', async () => {
      const rp = runtimePortApi(createIpcTransport(undefined))
      expect(await rp.getPort()).toBeUndefined()
      expect(rp.onError(() => {})).toBeInstanceOf(Function)
    })
  })

  describe('system domain — shortcut/fullscreen 分组', () => {
    it('WS 命令经 command 注入；shortcut/fullscreen 经 ipc', () => {
      const cmd = vi.fn(() => Promise.resolve())
      const ipc = mockIpc()
      const s = systemApi(cmd, createIpcTransport(ipc))

      s.ping()
      expect(cmd).toHaveBeenCalledWith({ type: 'ping', payload: {} })

      const cb = vi.fn()
      s.onShortcut(cb)
      expect(ipc.onShortcut).toHaveBeenCalledWith(cb)
    })
  })
})
