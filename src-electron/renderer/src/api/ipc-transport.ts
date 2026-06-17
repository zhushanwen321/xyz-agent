/**
 * IPC 传输抽象 —— 与 transport.ts（WS）对称。
 *
 * 封装 preload 注入的 window.electronAPI，供 IPC domain（window/dialog/runtime-port/
 * system 的 shortcut·fullscreen 分组）注入。职责：注入 + 可选降级（web/mock 环境无
 * preload 时 ipc 为 undefined，domain 方法优雅降级）+ mock 可替换。
 *
 * 不强求统一 transport 接口：IPC 方法形态不一（invoke/send/on 事件订阅），domain 直接
 * 调 `t.ipc?.method()`，与 transport.ts「抹平字节差异」的抽象粒度不同但对称。
 *
 * design.md R4：API Client 是 WS + IPC 的统一门面，组件只见 api.xxx，不见 ws/ipc。
 */
import type { ElectronAPI } from '../../../preload'

export interface IpcTransport {
  /** preload 注入的 electronAPI；web/mock 环境为 undefined（domain 方法优雅降级）。 */
  readonly ipc: ElectronAPI | undefined
}

export function createIpcTransport(ipc?: ElectronAPI): IpcTransport {
  return { ipc }
}
