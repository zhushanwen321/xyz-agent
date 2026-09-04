/**
 * lastUsedModel KV 单键存储 —— 用户最后显式选择的模型（landing 新任务默认模型）。
 *
 * 设计文档 §3.3 D4：landing 新任务默认模型 = lastUsedModel（显式，跨重启成立）。
 * 写点 = onModelSelect 非 staging 分支（用户显式选模型时写入）；staging 试选不写。
 *
 * KV 经 getPlatform().storage（KVStorage 接口，platform/port），core 零 localStorage 直连
 * （W3 迁移约束，同 model-thinking-memory / system-storage）。
 *
 * 错误规格（对齐设计 E4）：
 * - KV 读失败 → undefined（catch 回退，不抛不吞；下游回落 defaultModel）
 * - KV 写失败 → console.warn，内存值不回滚（本次运行内仍生效，重启后丢）
 * - JSON 非字符串 → undefined（兼容旧格式或损坏数据）
 */
import { getPlatform } from '../../platform/port'

/** localStorage key（对齐 model-thinking-memory 命名空间）。 */
export const LAST_USED_MODEL_KEY = 'xyz-agent:last-used-model'

/** 内存缓存：模块级单例。 */
let cachedValue: string | undefined = undefined

type LoadState = 'idle' | 'loading' | 'loaded'

/** 预载状态：loadOnce 幂等。 */
let loadState: LoadState = 'idle'

/** 加载完成回调队列。 */
let loadedCallbacks: Array<() => void> = []

/** 加载完成前置起的写标记。 */
let deferredPersist = false

/**
 * 触发惰性预载（fire-and-forget，幂等）。
 * 由 model-thinking 组装时调用。加载完成前 lookup 返回 undefined。
 */
export function loadOnce(): void {
  if (loadState !== 'idle') return
  loadState = 'loading'
  void loadFromKV()
}

/** 读 KV 入内存。任何读失败/损坏都收敛到 undefined（E4）。 */
async function loadFromKV(): Promise<void> {
  try {
    const raw = await getPlatform().storage.get(LAST_USED_MODEL_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'string') {
        cachedValue = parsed
      }
    }
  } catch {
    // E4：KV 读失败/损坏 → undefined（不抛不吞）
    cachedValue = undefined
  }
  loadState = 'loaded'
  const callbacks = loadedCallbacks
  loadedCallbacks = []
  for (const cb of callbacks) cb()
  if (deferredPersist) {
    deferredPersist = false
    void persist()
  }
}

/**
 * 同步查记忆：返回最后显式选择的模型 id，未加载或无记录返回 undefined。
 */
export function lookup(): string | undefined {
  return cachedValue
}

/**
 * 写记忆：同步写内存 + 异步写穿 KV。
 * KV 写失败仅 console.warn，内存不回滚（E4）。
 */
export function record(modelId: string): void {
  cachedValue = modelId
  if (loadState !== 'loaded') {
    deferredPersist = true
    return
  }
  void persist()
}

/** 写穿 KV。失败不回滚内存。 */
async function persist(): Promise<void> {
  try {
    await getPlatform().storage.set(LAST_USED_MODEL_KEY, JSON.stringify(cachedValue))
  } catch (err) {
    console.warn('[last-used-model] KV write-through failed:', err)
  }
}

/**
 * 注册加载完成回调：供 downstream 在 KV 预载完成时补一次读取。
 * 加载已完成则立即同步触发。
 */
export function onLoaded(cb: () => void): void {
  if (loadState === 'loaded') {
    cb()
    return
  }
  loadedCallbacks.push(cb)
}

/** 仅测试用：重置模块级状态。 */
export function __resetLastUsedModelForTesting(): void {
  cachedValue = undefined
  loadState = 'idle'
  loadedCallbacks = []
  deferredPersist = false
}
