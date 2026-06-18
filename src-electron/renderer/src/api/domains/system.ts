/**
 * System domain —— WS 系统命令 + M3 OS Gateway 的 shortcut/fullscreen 分组（design.md D1）。
 *
 * - ping / file.read 走 WS（command）。
 * - onShortcut / onFullscreenChanged 走 IPC（M3 OS Gateway）。
 *   这两组逻辑量小，并入 system；窗口管理（window）/对话框（dialog）/端口发现
 *   （runtime-port）因逻辑量大各独立 domain。
 * 经 IpcTransport 注入，ipc 为 undefined（web/mock）时 IPC 方法优雅降级。
 */
import type { ClientMessage, ClientMessageMap } from '@xyz-agent/shared'
import type { IpcTransport } from '../ipc-transport'

type Command = <T = unknown>(msg: ClientMessage) => Promise<T>

export interface SystemDomain {
  ping: () => Promise<unknown>
  readFile: (payload: ClientMessageMap['file.read']) => Promise<unknown>
  /** 监听全局快捷键事件（M3），返回取消函数。 */
  onShortcut: (cb: (type: string) => void) => () => void
  /** 监听 macOS 全屏状态变化（M3），返回取消函数。 */
  onFullscreenChanged: (cb: (payload: { isFullscreen: boolean }) => void) => () => void
}

export const systemApi = (command: Command, ipc?: IpcTransport): SystemDomain => {
  const e = ipc?.ipc
  return {
    ping: () => command({ type: 'ping', payload: {} }),
    readFile: (payload) => command({ type: 'file.read', payload }),
    onShortcut: (cb) => e?.onShortcut(cb) ?? (() => {}),
    onFullscreenChanged: (cb) => e?.onFullscreenChanged(cb) ?? (() => {}),
  }
}
