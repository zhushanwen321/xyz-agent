/**
 * last-used-model KV 单键存储测试。
 *
 * 覆盖：
 * - 基本 lookup/record
 * - loadOnce 预载 + onLoaded 回调
 * - KV 损坏回退（E4：读失败/JSON 损坏 → undefined）
 * - KV 写失败降级（console.warn，内存不回滚）
 * - deferred persist（loadOnce 期间 record 挂起，加载完成后补写）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LAST_USED_MODEL_KEY,
  loadOnce,
  lookup,
  record,
  onLoaded,
  __resetLastUsedModelForTesting,
} from './last-used-model'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../../platform/port'

/** 平面 KV stub */
class MemKV implements KVStorage {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/** 可控时序 KV：closeGate 挂起 get、openGateNow 放行 */
class GatedKV extends MemKV {
  private gate: Promise<void> | null = null
  private open: (() => void) | null = null
  closeGate(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }
  openGateNow(): void {
    this.open?.()
    this.open = null
  }
  override async get(key: string): Promise<string | null> {
    if (this.gate) await this.gate
    return super.get(key)
  }
}

/** 写失败 KV：set 抛错 */
class FailWriteKV extends MemKV {
  override async set(_key: string, _value: string): Promise<void> {
    throw new Error('disk full')
  }
}

function provideMockPlatform(storage: KVStorage): void {
  const port: PlatformPort = {
    kind: 'mock',
    storage,
    webSocket: {
      create: () => { throw new Error('stub') },
    },
    ipc: null,
  }
  providePlatform(port)
}

beforeEach(() => {
  provideMockPlatform(new MemKV())
  __resetLastUsedModelForTesting()
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetPlatformForTesting()
  __resetLastUsedModelForTesting()
})

describe('last-used-model · 基本 lookup/record', () => {
  it('未加载时 lookup 返回 undefined', () => {
    expect(lookup()).toBeUndefined()
  })

  it('record 后 lookup 返回记录值', () => {
    record('provider/model')
    expect(lookup()).toBe('provider/model')
  })

  it('多次 record 以最后一次为准', () => {
    record('provider/model-A')
    record('provider/model-B')
    expect(lookup()).toBe('provider/model-B')
  })
})

describe('last-used-model · loadOnce 预载', () => {
  it('loadOnce 从 KV 加载已有值', async () => {
    // 预置 KV
    const kv = new MemKV()
    await kv.set(LAST_USED_MODEL_KEY, JSON.stringify('provider/saved'))
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce()
    // 等异步加载完成
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lookup()).toBe('provider/saved')
  })

  it('loadOnce 幂等：重复调用不重复读', async () => {
    const kv = new MemKV()
    const spy = vi.spyOn(kv, 'get')
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce()
    loadOnce() // 第二次不应再读
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(spy).toHaveBeenCalledTimes(1) // 只调一次 get
  })

  it('onLoaded 回调：加载完成后注册立即触发', async () => {
    const kv = new MemKV()
    await kv.set(LAST_USED_MODEL_KEY, JSON.stringify('provider/saved'))
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    // 加载完成后注册 → 立即触发
    const cb = vi.fn()
    onLoaded(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('onLoaded 回调：加载前注册，加载完成后触发', async () => {
    const gated = new GatedKV()
    gated.closeGate()
    provideMockPlatform(gated)
    __resetLastUsedModelForTesting()

    loadOnce()
    const cb = vi.fn()
    onLoaded(cb)
    expect(cb).not.toHaveBeenCalled()

    gated.openGateNow()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('last-used-model · E4 错误规格', () => {
  it('KV 读失败 → undefined（不抛）', async () => {
    const kv = new MemKV()
    vi.spyOn(kv, 'get').mockRejectedValue(new Error('read error'))
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lookup()).toBeUndefined()
  })

  it('KV JSON 损坏 → undefined（不抛）', async () => {
    const kv = new MemKV()
    await kv.set(LAST_USED_MODEL_KEY, 'not-valid-json{{{')
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lookup()).toBeUndefined()
  })

  it('KV JSON 非字符串（数组）→ undefined', async () => {
    const kv = new MemKV()
    await kv.set(LAST_USED_MODEL_KEY, JSON.stringify(['a', 'b']))
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lookup()).toBeUndefined()
  })

  it('KV 写失败 → console.warn，内存值不回滚', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kv = new FailWriteKV()
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    // 先加载完成（无 KV 数据）
    loadOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    record('provider/model')
    // 内存值保持
    expect(lookup()).toBe('provider/model')
    // 写失败触发 warn
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('last-used-model · deferred persist', () => {
  it('loadOnce 期间 record → 加载完成后补写', async () => {
    const kv = new MemKV()
    const setSpy = vi.spyOn(kv, 'set')
    provideMockPlatform(kv)
    __resetLastUsedModelForTesting()

    loadOnce() // 状态 → loading
    record('provider/deferred') // deferred persist
    expect(lookup()).toBe('provider/deferred') // 内存立即可读

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    // 加载完成后补写
    expect(setSpy).toHaveBeenCalledWith(
      LAST_USED_MODEL_KEY,
      JSON.stringify('provider/deferred'),
    )
  })
})
