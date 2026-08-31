/**
 * 模型档位记忆存储 —— 「provider/modelId → 最后使用的 UI 档位」偏好表
 * （设计文档 docs/design/model-thinking-level-memory.md §3.4）。
 *
 * 本模块只提供存储原语：模块级 reactive Map 内存表 + 惰性异步预载 + KV 写穿；
 * 「仅已建态记录」等写入门禁是下游（model-thinking 记录 watch，D2）的职责。
 * 表值是 UI key（ThinkingLevel 枚举，D1——跨模型恢复的语义是档位名而非实现值）；
 * 表键是 provider/modelId 复合串、全局一份（D6，多 composer 实例共享）。
 *
 * 错误规格（设计 §3.4 错误规格表）：
 * - E1  KV 读失败 / JSON 损坏 → 空表启动（catch 回退，不抛不吞，对齐 system-storage ES2 范式）
 * - E2  KV 写失败 → console.warn，内存表不回滚（本次运行内记忆仍生效，重启后丢）
 * - E6  非法档位值（非 ThinkingLevel 枚举）→ 丢弃该条（record 拦截 + 加载时过滤）
 * - E7② onLoaded：加载完成回调（完成后注册立即同步触发），供下游在加载完成时补一次重设
 *
 * KV 经 getPlatform().storage（KVStorage 接口，platform/port），core 零 localStorage 直连
 * （W3 迁移约束，同 system-storage）。
 */
import { reactive } from 'vue'
import { getPlatform } from '../../platform/port'
import { isThinkingLevel, type ThinkingLevel } from './thinking-levels'

/** localStorage key（对齐 `xyz-agent:system-settings` 命名，设计 §3.4）。 */
export const MODEL_THINKING_MEMORY_KEY = 'xyz-agent:model-thinking-memory'

/**
 * 内存表：模块级单例（多 composer 实例 / split panel 共享，D6）。
 * reactive 使下游 watch 记忆变化成为可能；本模块自身不建立 watch。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 data-source-registry #21 非草稿）：模型档位记忆表单例（UI 偏好内存镜像，权威源 = KVStorage 持久化整表，12 类未覆盖）
const memory = reactive(new Map<string, ThinkingLevel>())

type LoadState = 'idle' | 'loading' | 'loaded'

/** 预载状态：loadOnce 幂等（loading/loaded 不重复读 KV）的判定依据。 */
let loadState: LoadState = 'idle'

/** 加载完成回调队列（E7②）。加载完成后本数组即被清空，之后注册走立即触发路径。 */
let loadedCallbacks: Array<() => void> = []

/**
 * 加载完成前置起的 record 标记（含 idle 与 loading 两个窗口）。
 * 为什么挂起而不立即写穿：KV 快照尚未读入（或读取在途）时写穿，会拿局部
 * 内存快照覆写整表，未知条目被静默清掉——必须等加载完成后补一次完整写收敛。
 */
let deferredPersist = false

/** KV 写穿串行链：防止并发 record 的写乱序（旧快照晚到覆盖新值）。 */
let persistChain: Promise<void> = Promise.resolve()

/**
 * 触发惰性预载（fire-and-forget，幂等：重复调用不重复读 KV）。
 * 由首个消费方组装时调用（composer-shell，u4）；加载完成前 lookup 返回
 * undefined（E7①「无记忆」，下游自然回落现有对齐规则）。
 */
export function loadOnce(): void {
  if (loadState !== 'idle') return
  loadState = 'loading'
  void loadFromKV()
}

/** 读 KV 入内存表。任何读失败 / 损坏都收敛到空表启动（E1），加载状态必然推进到 loaded。 */
async function loadFromKV(): Promise<void> {
  let table: Record<string, unknown> = {}
  try {
    const raw = await getPlatform().storage.get(MODEL_THINKING_MEMORY_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      // 合法 JSON 但非对象（数组/字符串/null）与损坏 JSON 同等对待：按缺省空表处理
      if (isPlainObject(parsed)) table = parsed
    }
  } catch {
    // E1：KV 读失败 / JSON 损坏 → 显式回退空表（不抛不吞；空表 = 全部回落现有规则，对齐 system-storage 范式）
    table = {}
  }
  for (const [modelId, level] of Object.entries(table)) {
    // E6：非法档位条目丢弃；内存已有值优先（加载窗口内的 record 比在途 KV 快照新，不被覆写）
    if (typeof level === 'string' && isThinkingLevel(level) && !memory.has(modelId)) {
      memory.set(modelId, level)
    }
  }
  loadState = 'loaded'
  const callbacks = loadedCallbacks
  loadedCallbacks = []
  for (const cb of callbacks) cb()
  if (deferredPersist) {
    // 加载窗口内挂起的 record 在此补写收敛（KV 已知全量，快照不再局部）
    deferredPersist = false
    void enqueuePersist()
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 同步查记忆：读内存 Map，未加载或无记录返回 undefined。
 * 返回的是 UI key（ThinkingLevel），可用性校验由下游按新模型 supportedLevels 做（D5）。
 */
export function lookup(modelId: string): ThinkingLevel | undefined {
  return memory.get(modelId)
}

/**
 * 写一条记忆：同步写内存 + 异步写穿 KV（整表序列化）。
 * level 非法（非 ThinkingLevel 枚举）直接丢弃（E6）——存储层是最后一道值域防线。
 * KV 写失败仅 console.warn，内存不回滚（E2）。
 */
export function record(modelId: string, level: string): void {
  if (!isThinkingLevel(level)) return
  memory.set(modelId, level)
  if (loadState !== 'loaded') {
    deferredPersist = true
    return
  }
  void enqueuePersist()
}

/** 整表写穿。失败不回滚内存（E2）——本次运行内记忆仍生效，重启后丢。 */
async function persist(): Promise<void> {
  try {
    const table: Record<string, string> = {}
    for (const [modelId, level] of memory.entries()) table[modelId] = level
    await getPlatform().storage.set(MODEL_THINKING_MEMORY_KEY, JSON.stringify(table))
  } catch (err) {
    // E2 降级策略（best-effort）：写穿失败不回滚内存、不向调用方传播——偏好数据可丢失，
    // 本次运行内记忆仍生效、重启后丢，warn 留排障线索即可
    console.warn('[model-thinking-memory] KV write-through failed:', err)
  }
}

/** 排队一次写穿；快照在链上实际执行时读取，链序保证最终落盘的是最新全量表。 */
function enqueuePersist(): Promise<void> {
  persistChain = persistChain.then(persist)
  return persistChain
}

/**
 * 注册加载完成回调（E7②）：供下游在 KV 预载完成时补一次重设
 * （landing memory-aware 跟随窗口兜底）。加载已完成则立即同步触发。
 */
export function onLoaded(cb: () => void): void {
  if (loadState === 'loaded') {
    cb()
    return
  }
  loadedCallbacks.push(cb)
}

/** 仅测试用：重置模块级状态（内存表 / 加载状态 / 回调 / 挂起写 / 写链），跨用例隔离。 */
export function __resetModelThinkingMemoryForTesting(): void {
  memory.clear()
  loadState = 'idle'
  loadedCallbacks = []
  deferredPersist = false
  persistChain = Promise.resolve()
}
