import { describe, it, expect } from 'vitest'
import {
  getRuntimePort,
  getRuntimePortOffset,
  onRuntimePort,
  onShortcut,
  onRuntimeError,
  onRuntimeRestarting,
  onRuntimeFailed,
  restartRuntime,
  onFullscreenChanged,
  pickDirectory,
  windowMinimize,
  windowToggleMaximize,
  windowClose,
  openExternal,
  browserCreate,
  browserNavigate,
  browserHide,
  browserShow,
  browserFocus,
  browserBack,
  browserForward,
  browserSetZoom,
  browserGetZoom,
  browserGetSelection,
  browserSetRect,
  browserDestroy,
  onBrowserState,
} from '../ipc'

describe('mobile-renderer lib/ipc.ts no-op（spec P4 D8）', () => {
  it('window.electronAPI 保持 undefined（不注册 preload 桥）', () => {
    expect(window.electronAPI).toBeUndefined()
  })

  it('getRuntimePort / getRuntimePortOffset 恒 resolve undefined（无本地 runtime）', async () => {
    await expect(getRuntimePort()).resolves.toBeUndefined()
    await expect(getRuntimePortOffset()).resolves.toBeUndefined()
  })

  it('回调订阅类方法（onRuntimePort/onShortcut/onRuntimeError/onRuntimeRestarting/onRuntimeFailed/onFullscreenChanged/onBrowserState）返回 no-op 取消函数，调用不抛错', () => {
    const unsubscribers = [
      onRuntimePort(() => {}),
      onShortcut(() => {}),
      onRuntimeError(() => {}),
      onRuntimeRestarting(() => {}),
      onRuntimeFailed(() => {}),
      onFullscreenChanged(() => {}),
      onBrowserState(() => {}),
    ]
    for (const unsub of unsubscribers) {
      expect(typeof unsub).toBe('function')
      expect(() => unsub()).not.toThrow()
    }
  })

  it('restartRuntime / 窗口控制 / openExternal / browserCreate / browserNavigate 恒 resolve undefined', async () => {
    await expect(restartRuntime()).resolves.toBeUndefined()
    await expect(windowMinimize()).resolves.toBeUndefined()
    await expect(windowToggleMaximize()).resolves.toBeUndefined()
    await expect(windowClose()).resolves.toBeUndefined()
    await expect(openExternal('https://example.com')).resolves.toBeUndefined()
    await expect(browserCreate('s1', 'w1')).resolves.toBeUndefined()
    await expect(browserNavigate('s1', 'https://example.com')).resolves.toBeUndefined()
  })

  it('pickDirectory 恒 resolve {canceled:true, path:null}（上层落回手动路径输入，spec D4）', async () => {
    await expect(pickDirectory()).resolves.toEqual({ canceled: true, path: null })
    await expect(pickDirectory({ title: 't', defaultPath: '~' })).resolves.toEqual({
      canceled: true,
      path: null,
    })
  })

  it('browserGetZoom 恒 resolve 1.0，browserGetSelection 恒 resolve 空选区', async () => {
    await expect(browserGetZoom('s1')).resolves.toBe(1.0)
    await expect(browserGetSelection('s1')).resolves.toEqual({ text: '', url: '' })
  })

  it('browser drawer 剩余方法（Hide/Show/Focus/Back/Forward/SetZoom/SetRect/Destroy）恒 resolve undefined（w3 全方法覆盖）', async () => {
    await expect(browserHide('s1')).resolves.toBeUndefined()
    await expect(browserShow('s1')).resolves.toBeUndefined()
    await expect(browserFocus('s1')).resolves.toBeUndefined()
    await expect(browserBack('s1')).resolves.toBeUndefined()
    await expect(browserForward('s1')).resolves.toBeUndefined()
    await expect(browserSetZoom('s1', 1.5)).resolves.toBeUndefined()
    await expect(browserSetRect('s1', { x: 0, y: 0, width: 100, height: 100 })).resolves.toBeUndefined()
    await expect(browserDestroy('s1')).resolves.toBeUndefined()
  })

  it('onFullscreenChanged 返回 no-op 取消函数，调用不抛错（w3 全方法覆盖）', () => {
    const unsub = onFullscreenChanged(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })
})
