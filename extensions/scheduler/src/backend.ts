import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { createStore } from './store.js'
import type { ScheduledTask, SchedulerStore } from './types.js'

// ── SchedulerBackend 接口 ──

/**
 * 运行时协作后端抽象（依赖反转）。SchedulerRuntime 只依赖此接口：
 * 不触碰 FS、不持有 pi、不管理 store。
 *
 * - sendMessage: 到期 dispatch 的消息注入（生产实现委托 pi.sendMessage）
 * - persist: 持久化任务状态。失败必须抛错（ERR-6：runtime 捕获后记日志、
 *   保留内存态、不 rethrow）；opts.sync=true 表示立即同步写盘
 *   （session_shutdown 场景，对应原 persistSync 语义）
 * - now: 时间源（测试可注入固定值）
 *
 * sendMessage 的 msg 签名与 pi 的 CustomMessage 对齐（customType/display 必填）：
 * 调用方必须显式提供，PiSchedulerBackend 直接透传无需兜底默认值。
 *
 * load 不在接口（IF-3 只定义运行时协作三方法）：读路径由
 * PiSchedulerBackend.loadTasks() 实现类方法承担（非接口成员），
 * index.ts 装配点调用后经 runtime.loadTasks(tasks) 注入。
 */
export interface SchedulerBackend {
  sendMessage(
    msg: { content: string; customType: string; display: boolean },
    opts?: { deliverAs?: 'followUp'; triggerTurn?: boolean },
  ): Promise<void>
  persist(store: SchedulerStore, opts?: { sync?: boolean }): Promise<void>
  now(): number
}

// ── 生产实现 ──

/**
 * 生产后端：store 文件 + pi.sendMessage + Date.now()。
 *
 * persist 不委托 store 的 debounced persist（design-review R1 修正）：
 * debounce 定时器里的错误逃出调用栈，runtime 的 try/catch 捕获不到，
 * 且 2s 后写盘时内存态可能已再次变化。统一走同步写盘路径
 * （store.persistSync），sync:false/sync:true 同路径，保证 persist
 * 错误在调用栈内抛出供 runtime 捕获。
 */
export class PiSchedulerBackend implements SchedulerBackend {
  private store: ReturnType<typeof createStore>
  private pi: Pick<ExtensionAPI, 'sendMessage'>

  constructor(cwd: string, pi: Pick<ExtensionAPI, 'sendMessage'>) {
    this.store = createStore(cwd)
    this.pi = pi
  }

  /** 读路径：从 store 文件加载任务（非接口成员，由装配点调用）。 */
  loadTasks(): ScheduledTask[] {
    return this.store.load().tasks
  }

  async sendMessage(
    msg: { content: string; customType: string; display: boolean },
    opts?: { deliverAs?: 'followUp'; triggerTurn?: boolean },
  ): Promise<void> {
    await this.pi.sendMessage(msg, opts)
  }

  async persist(store: SchedulerStore, _opts?: { sync?: boolean }): Promise<void> {
    // 同步写盘（复用 store.persistSync）：sync:false/sync:true 同路径。
    this.store.persistSync(store)
  }

  now(): number {
    return Date.now()
  }
}

// ── 测试实现 ──

export interface SentMessage {
  msg: { content: string; customType: string; display: boolean }
  opts?: { deliverAs?: 'followUp'; triggerTurn?: boolean }
}

/**
 * Mock 后端：零 FS 副作用，记录 sendMessage/persist 调用，支持注入错误与固定时间。
 * 与 SchedulerBackend/PiSchedulerBackend 同文件 export（M3 测试从 './backend.js' import）。
 *
 * 能力：
 * - sentMessages: 每次 sendMessage 的 {msg, opts} 记录
 * - persistedStores: 每次 persist 收到的 store 记录
 * - persistError: 注入后 persist 抛该错（测 ERR-6 捕获路径）
 * - nowValue: now() 返回固定值，缺省 Date.now()
 */
export class MockSchedulerBackend implements SchedulerBackend {
  sentMessages: SentMessage[] = []
  persistedStores: SchedulerStore[] = []
  persistError: Error | null = null
  nowValue: number | undefined

  async sendMessage(
    msg: { content: string; customType: string; display: boolean },
    opts?: { deliverAs?: 'followUp'; triggerTurn?: boolean },
  ): Promise<void> {
    this.sentMessages.push({ msg, opts })
  }

  async persist(store: SchedulerStore, _opts?: { sync?: boolean }): Promise<void> {
    if (this.persistError) throw this.persistError
    this.persistedStores.push(store)
  }

  now(): number {
    return this.nowValue ?? Date.now()
  }
}
