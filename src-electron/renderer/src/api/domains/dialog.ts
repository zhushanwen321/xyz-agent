/**
 * Dialog domain —— M3 OS Gateway IPC（design.md D1）：原生对话框 + 外链。
 *
 * 封装 preload 的 pickDirectory（原生目录选择）+ openExternal（默认浏览器开链接）。
 * 经 IpcTransport 注入，ipc 为 undefined（web/mock）时方法优雅降级。
 */
import type { IpcTransport } from '../ipc-transport'

export interface DialogDomain {
  /** 打开原生目录选择对话框。web/mock 环境返回 canceled。 */
  pickDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; path: string | null }>
  /** 在默认浏览器打开外链（调用方应先校验 http/https 协议）。 */
  openExternal: (url: string) => Promise<void>
}

export const dialogApi = (t: IpcTransport): DialogDomain => ({
  pickDirectory: (options) =>
    t.ipc?.pickDirectory(options) ?? Promise.resolve({ canceled: true, path: null }),
  openExternal: (url) => t.ipc?.openExternal(url) ?? Promise.resolve(),
})
