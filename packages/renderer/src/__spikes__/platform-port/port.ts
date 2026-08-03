/**
 * PlatformPort —— 平台适配核心端口（P0 spike 基础设施）。
 *
 * 这是 §9「平台适配层 PlatformPort」的 spike 验证落地。当前位于 renderer 的临时 spike
 * 目录（packages/renderer/src/__spikes__/platform-port/），待兄弟 slice package-skeleton
 * 建立 core 包后，本文件整体迁移到 core/src/platform/port.ts，仅改 import 路径不改逻辑
 * （父 slice T2 决策）。
 *
 * P0 仅抽象 3 个核心端口（storage/webSocket/ipc），其余平台能力（notify/sound/clipboard/
 * filePicker/terminal）以注释形式预留迭代收编区，不进接口字段（§9 审查意见：当前无 web 版
 * 承诺，不预付全量抽象成本）。
 *
 * 设计目标：
 * - core 通过 getPlatform() 访问平台能力，禁止直接 window.electronAPI/localStorage/new WebSocket（AC2 lint 强制，lint 规则属 package-skeleton）
 * - 测试注入 createMockPlatform() 摆脱 DOM/electronAPI 依赖
 * - w2/w3/w4 三项 spike 据此接口验证端口抽象可行性
 */
import type { LatestReleaseInfo, UpdateStage, IProxyConfig } from '@xyz-agent/shared'

// ═══════════════════════════════════════════════════════════════════
// WebSocket 连接状态常量（与 DOM WebSocket 一致）
// ═══════════════════════════════════════════════════════════════════

export const ReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

// ═══════════════════════════════════════════════════════════════════
// 接口定义
// ═══════════════════════════════════════════════════════════════════

/**
 * 异步键值存储抽象。key 为 string，value 为 string（JSON 序列化由调用方负责，与
 * localStorage getItem/setItem 语义一致）。get 不存在的 key 返回 null（非抛错）；
 * set/remove 降级吞错（与现有 useRecents JSON.parse 兜底语义一致，父 slice ES-storage-fallback）。
 */
export interface KVStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * DOM WebSocket 子集。抽取 ws-client 实际用到的 readyState/send/close/
 * addEventListener/removeEventListener + 4 个状态常量，隔离 core 对浏览器 WebSocket 类型的依赖。
 */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (ev: unknown) => void): void
  removeEventListener(type: string, listener: (ev: unknown) => void): void
  readonly OPEN: number
  readonly CONNECTING: number
  readonly CLOSING: number
  readonly CLOSED: number
}

/**
 * WebSocket 工厂注入点。ws-client 消费 factory.create(url) 而非 new WebSocket(url)，
 * 测试注入 MockWebSocketFactory 摆脱全局 WebSocket 依赖（spike#2 验证目标）。
 */
export interface WebSocketFactory {
  create(url: string): WebSocketLike
}

/**
 * renderer 对 electronAPI 的唯一正式端口。方法集 = lib/ipc.ts 当前 38 个 export function
 * 签名 1:1 转换（方法名/参数/返回类型完全一致）。ElectronPlatformAdapter（后续壳层 wave）实现
 * 此接口（内部委托 window.electronAPI）；非 electron 环境 PlatformPort.ipc = null。
 *
 * 注：父 slice DM-ipc-callpoints 记 35 个方法，实测 lib/ipc.ts 导出 38 个（含 listSystemSounds/
 * playSystemSound/testProxy 等），w1 以实测为准照搬，w3 spike#3 调用点计数时用准确数 38。
 */
export interface IpcBridge {
  getRuntimePort(): Promise<number | undefined>
  getRuntimePortOffset(): Promise<number | undefined>
  onRuntimePort(cb: (port: number) => void): () => void
  onShortcut(cb: (type: string) => void): () => void
  onRuntimeError(cb: (error: { message: string }) => void): () => void
  onRuntimeRestarting(cb: (payload: { attempt: number }) => void): () => void
  onRuntimeFailed(cb: (payload: { attempts: number; message: string }) => void): () => void
  restartRuntime(): Promise<void>
  onFullscreenChanged(cb: (isFullscreen: boolean) => void): () => void
  pickDirectory(options?: { title?: string; defaultPath?: string }): Promise<{ canceled: boolean; path: string | null }>
  pickFile(
    options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
  ): Promise<{ canceled: boolean; path: string | null }>
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  openExternal(url: string): Promise<void>
  browserCreate(sessionId: string, windowId: string): Promise<void>
  browserNavigate(sessionId: string, url: string): Promise<void>
  browserHide(sessionId: string): Promise<void>
  browserShow(sessionId: string): Promise<void>
  browserFocus(sessionId: string): Promise<void>
  browserBack(sessionId: string): Promise<void>
  browserForward(sessionId: string): Promise<void>
  browserSetZoom(sessionId: string, factor: number): Promise<void>
  browserGetZoom(sessionId: string): Promise<number>
  browserGetSelection(sessionId: string): Promise<{ text: string; url: string }>
  browserSetRect(
    sessionId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<void>
  browserDestroy(sessionId: string): Promise<void>
  onBrowserState(
    callback: (state: {
      sessionId: string
      currentUrl: string
      isLoading: boolean
      error: { errorCode: number; errorDescription: string; validatedURL: string } | null
      canGoBack: boolean
      canGoForward: boolean
      zoomFactor: number
    }) => void,
  ): () => void
  checkForUpdate(opts?: { force?: boolean }): Promise<LatestReleaseInfo | null>
  performUpdate(release: LatestReleaseInfo): Promise<{ triggerRestart: boolean }>
  onUpdateProgress(cb: (p: { stage: UpdateStage; percent: number }) => void): () => void
  onUpdateError(cb: (e: { stage: string; message: string; errorCode?: string }) => void): () => void
  openUpdateFallbackUrl(url: string): Promise<void>
  getProxyConfig(): Promise<IProxyConfig>
  setProxyConfig(config: IProxyConfig): Promise<void>
  testProxy(config: IProxyConfig): Promise<{ success: boolean; message?: string }>
  listSystemSounds(): Promise<{ platform: string; sounds: Array<{ id: string; name: string }> }>
  playSystemSound(name: string, kind?: 'success' | 'error'): Promise<{ audioData?: string; mimeType?: string }>
}

/**
 * 平台适配核心端口。kind 标识运行平台；storage/webSocket/ipc 为 P0 落地的 3 个核心端口。
 * 迭代收编区（notify/sound/clipboard/filePicker/terminal，§9 标注的 P0 不抽象项）以注释形式
 * 预留，不进接口字段（避免接口频繁变更）。core 通过 getPlatform() 访问。
 */
export interface PlatformPort {
  readonly kind: 'electron' | 'mobile' | 'web' | 'mock'
  storage: KVStorage
  webSocket: WebSocketFactory
  ipc: IpcBridge | null
  // ── 迭代收编区（P0 不抽象，沿用隐式降级）──
  // notify / sound / clipboard / filePicker / terminal …
}

// ═══════════════════════════════════════════════════════════════════
// 默认实现（mock / 降级）
// ═══════════════════════════════════════════════════════════════════

/**
 * 内存 Map 降级实现。无 localStorage 环境（非 web / core 单测注入）使用。
 * get 不存在返回 null，set/remove 不抛错（与 useRecents JSON.parse 兜底语义一致）。
 */
export class InMemoryStorage implements KVStorage {
  private map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/**
 * 可外部控制的 MockWebSocket。实现 WebSocketLike，提供 mockOpen/mockMessage/mockClose/
 * mockError 辅助方法驱动 addEventListener 注册的 listener，供 w2 spike#2 注入
 * MockWebSocketFactory 跑通连接/消息/关闭 3 例。readyState 初始 CONNECTING。
 */
export class MockWebSocket implements WebSocketLike {
  readonly OPEN = ReadyState.OPEN
  readonly CONNECTING = ReadyState.CONNECTING
  readonly CLOSING = ReadyState.CLOSING
  readonly CLOSED = ReadyState.CLOSED

  /** 连接目标 URL（构造时传入，供测试断言连接地址） */
  readonly url: string
  readyState: number = ReadyState.CONNECTING
  /** 已发送的消息（供测试断言 send 调用） */
  sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
  }

  private listeners = new Map<string, Set<(ev: unknown) => void>>()

  send(data: string): void {
    this.sentMessages.push(data)
  }

  close(): void {
    this.readyState = ReadyState.CLOSED
    this.emit('close', {})
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  // ── 测试驱动辅助方法（仅 mock 用，生产壳层不消费）──

  /** 驱动连接成功：readyState 置 OPEN 并触发 open listener */
  mockOpen(): void {
    this.readyState = ReadyState.OPEN
    this.emit('open', {})
  }

  /** 驱动消息到达：触发 message listener */
  mockMessage(data: string): void {
    this.emit('message', { data })
  }

  /** 驱动连接关闭：readyState 置 CLOSED 并触发 close listener */
  mockClose(): void {
    this.readyState = ReadyState.CLOSED
    this.emit('close', {})
  }

  /** 驱动错误：触发 error listener */
  mockError(ev?: unknown): void {
    this.emit('error', ev ?? {})
  }

  private emit(type: string, ev: unknown): void {
    const set = this.listeners.get(type)
    if (set) {
      // 复制一份遍历，避免 listener 内反注册导致迭代异常
      for (const listener of [...set]) {
        listener(ev)
      }
    }
  }
}

/**
 * MockWebSocket 工厂。create 返回新 MockWebSocket 实例并记录到 created 数组，
 * 供测试断言连接次数。返回的实例可外部控制（mockOpen/mockMessage/...）。
 */
export class MockWebSocketFactory implements WebSocketFactory {
  /** 已创建的 WebSocket 实例（供测试断言连接次数/获取实例驱动事件） */
  created: MockWebSocket[] = []

  create(url: string): MockWebSocket {
    const ws = new MockWebSocket(url)
    this.created.push(ws)
    return ws
  }
}

/**
 * 测试用 PlatformPort 工厂。默认 kind='mock'，storage=InMemoryStorage，
 * webSocket=MockWebSocketFactory，ipc=null。支持 Partial<PlatformPort> 局部替换
 * （如注入 spy ipc）。供本 spike 三项验证脚本 + 后续特征测试 PoC 复用。
 */
export function createMockPlatform(overrides?: Partial<PlatformPort>): PlatformPort {
  const defaults: PlatformPort = {
    kind: 'mock',
    storage: new InMemoryStorage(),
    webSocket: new MockWebSocketFactory(),
    ipc: null,
  }
  return overrides ? { ...defaults, ...overrides } : defaults
}

// ═══════════════════════════════════════════════════════════════════
// 模块级注入机制
// ═══════════════════════════════════════════════════════════════════

let currentPlatform: PlatformPort | null = null

/**
 * 注入平台端口。壳 bootstrap 时调 providePlatform(ElectronPlatformAdapter)（后续壳层 wave
 * 实现），测试调 providePlatform(createMockPlatform()) 注入测试端口。
 */
export function providePlatform(port: PlatformPort): void {
  currentPlatform = port
}

/**
 * 读取已注入的平台端口。未注入（providePlatform 前调用）抛 Error（fail-fast，防隐式 undefined
 * 传播）。
 */
export function getPlatform(): PlatformPort {
  if (!currentPlatform) {
    throw new Error('PlatformPort not provided. Call providePlatform() first.')
  }
  return currentPlatform
}

/**
 * 重置平台端口为 null（仅测试用，确保用例隔离，避免模块级单例跨用例污染）。
 * 命名带 __ 前缀标记测试专用，不进生产调用。
 */
export function __resetPlatformForTesting(): void {
  currentPlatform = null
}
