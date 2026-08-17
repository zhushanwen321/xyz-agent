// PlatformPort — 平台适配核心端口（P0 最小 stub）。
//
// 本 stub 满足 bootstrap import + 单测 spy。正式实现由 platform-port-spike slice 落地
// （IF-provide-platform 契约：providePlatform/getPlatform + 完整 KVStorage/WebSocketFactory/IpcBridge
//  + ElectronPlatformAdapter/MockPlatform）。platform-port-spike execute 后本文件被其正式实现替换，
// bootstrap.ts 的 import 路径与单测 spy 不变（只换实现）。
//
// 设计依据：renderer-rebuild-architecture.md §9（PlatformPort）、§11.0.3（bootstrap 时序）。

// KVStorage —— 异步键值存储抽象（platform-port-spike IF-kv-storage）。
// LocalStorageAdapter 桥接 localStorage；InMemoryStorage 用 Map。get 不存在 key 返回 null（非抛错）。
export interface KVStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

// WebSocketLike —— WebSocket 抽象（属性式回调，贴合原生 WebSocket 语义）。
// 平台适配层（ElectronPlatformAdapter/MockPlatform）按本接口实现真实/模拟连接。
// readyState 数字常量对齐 WHATWG：CONNECTING=0 / OPEN=1 / CLOSING=2 / CLOSED=3。
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((err: unknown) => void) | null
}

/** WebSocketLike.readyState 常量（WHATWG 对齐） */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

// WebSocketFactory —— ws-client 消费 factory.create(url) 而非 new WebSocket(url)（platform-port-spike IF-websocket-factory）。
// mock 模式由 platform 注入 mock factory（platform.kind === 'mock' 时 create 返回模拟实例）。
export interface WebSocketFactory {
  create(url: string): WebSocketLike
}

// IpcBridge —— renderer 对 electronAPI 的端口抽象（platform-port-spike IF-ipc-bridge）。
//
// 【现状：deferred，非 P0 已完成】spike③（把 lib/ipc.ts 调用点收编进 PlatformPort.ipc）
// 未通过验证：lib/ipc.ts 39 个 electronAPI 包装方法被 17 个 renderer 文件直接 import 消费，
// 全量改走 getPlatform().ipc 的改动量超出 P0 可控范围，且 core 内 getPlatform().ipc 零消费。
// 按架构文档 §9「三项验证任一失败即回退隐式降级方案重估，不硬推」规则，本字段标记 deferred。
//
// 【当前主路径】packages/renderer/src/lib/ipc.ts 仍是 electronAPI 的实际访问点（未进
// PlatformPort，工作正常，勿动）。本字段预留给未来迭代收编，当前桌面/mobile 两壳均注入 null。
// P0 stub 用索引签名占位，正式落地时用完整方法签名替换。
export interface IpcBridge {
  [method: string]: (...args: unknown[]) => unknown
}

// PlatformPort —— 平台适配核心端口（platform-port-spike IF-platform-port）。
// kind 标识运行平台；storage/webSocket 为 P0 已落地的 2 个核心端口。
// 迭代收编区（notify/sound/clipboard/filePicker/terminal，§9）以注释预留，不进接口字段。
export interface PlatformPort {
  readonly kind: 'electron' | 'mobile' | 'web' | 'mock'
  storage: KVStorage
  webSocket: WebSocketFactory
  // ipc：deferred（spike③ 未通过，core 内零消费），当前两壳均 null；详见上方 IpcBridge 注释。
  ipc: IpcBridge | null
}

let currentPlatform: PlatformPort | null = null

// providePlatform —— 壳 bootstrap 时注入平台端口（模块级单例）。
export function providePlatform(port: PlatformPort): void {
  currentPlatform = port
}

// getPlatform —— 获取已注入的平台端口。注入前调用 fail-fast 抛错（防隐式 undefined）。
export function getPlatform(): PlatformPort {
  if (!currentPlatform) {
    throw new Error(
      '[core/platform] getPlatform() called before providePlatform() — platform port not injected',
    )
  }
  return currentPlatform
}

/** 仅测试用：重置为 null（单测隔离，避免跨用例污染，对齐 transport 的 __resetSettingsTransportForTesting）。 */
export function __resetPlatformForTesting(): void {
  currentPlatform = null
}
