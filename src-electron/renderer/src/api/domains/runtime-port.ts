/**
 * RuntimePort domain —— M1 Process Supervisor IPC（design.md D1）。
 *
 * 封装 preload 的 runtime 端口发现 + 重连/错误事件：
 * getRuntimePort / getRuntimePortOffset / onRuntimePort / onRuntimeError。
 *
 * 用途：useConnection（effects 层）管理 WS 连接生命周期——先经 IPC 取 runtime 端口，
 * 再 connect WS；runtime 重启时经 onRuntimePort 推新端口触发重连（D1 启动时序契约）。
 * 经 IpcTransport 注入，ipc 为 undefined（web/mock）时降级。
 */
import type { IpcTransport } from '../ipc-transport'

export interface RuntimePortDomain {
  /** 取得已知 runtime 端口（main 已 spawn）。 */
  getPort: () => Promise<number | undefined>
  /** 获取 runtime 端口偏移（dev +100，prod 0）。 */
  getPortOffset: () => Promise<number | undefined>
  /** 监听 runtime 端口推送（runtime 重启后 main 推新端口触发重连），返回取消函数。 */
  onPort: (cb: (port: number) => void) => () => void
  /** 监听 runtime 启动失败事件，返回取消函数。 */
  onError: (cb: (error: { message: string }) => void) => () => void
}

export const runtimePortApi = (t: IpcTransport): RuntimePortDomain => ({
  getPort: () => Promise.resolve(t.ipc?.getRuntimePort()),
  getPortOffset: () => Promise.resolve(t.ipc?.getRuntimePortOffset()),
  onPort: (cb) => t.ipc?.onRuntimePort(cb) ?? (() => {}),
  onError: (cb) => t.ipc?.onRuntimeError(cb) ?? (() => {}),
})
