/**
 * SessionData 刷写工具
 *
 * 从 PluginService 提取 sessionData 的 flush、定时器等操作。
 */

import { getConfigDir } from '../../pi-config-bridge.js'
import { persistSessionData } from './plugin-storage.js'

const FLUSH_INTERVAL_MS = 5_000

/** 将所有 dirty sessionData 批量 flush */
export async function flushSessionData(
  sessionDataDirty: Map<string, Set<string>>,
  sessionDataCache: Map<string, Map<string, unknown>>,
): Promise<void> {
  for (const [sessionId, dirtyKeys] of sessionDataDirty) {
    if (dirtyKeys.size === 0) continue
    const cache = sessionDataCache.get(sessionId)
    if (!cache) continue

    // 快照 dirty 数据
    const dirtySnapshot = new Map<string, unknown>()
    for (const key of dirtyKeys) {
      const val = cache.get(key)
      if (val !== undefined) dirtySnapshot.set(key, val)
    }

    // 先清除 dirty（让 timer 测试能正确验证）
    dirtyKeys.clear()

    // 异步持久化；失败时恢复 dirty
    try {
      await persistSessionData(getConfigDir(), sessionId, cache)
    } catch (err: unknown) {
      console.warn(`[plugin-service] sessionData flush failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
      // 恢复 dirty 标记
      for (const key of dirtySnapshot.keys()) {
        dirtyKeys.add(key)
      }
    }
  }
}

/** flush 指定 session 的 dirty 数据（deactivate/关闭时调用） */
export async function flushSessionDataForSession(
  sessionId: string,
  sessionDataDirty: Map<string, Set<string>>,
  sessionDataCache: Map<string, Map<string, unknown>>,
): Promise<void> {
  const dirtyKeys = sessionDataDirty.get(sessionId)
  if (!dirtyKeys || dirtyKeys.size === 0) return

  const cache = sessionDataCache.get(sessionId)
  if (!cache) return

  try {
    await persistSessionData(getConfigDir(), sessionId, cache)
    dirtyKeys.clear()
    // eslint-disable-next-line taste/no-silent-catch -- sessionData flush failure: log and keep existing data
  } catch (err: unknown) {
    console.warn(`[plugin-service] sessionData flush failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
  }
}

/** 启动 sessionData 定时 flush */
export function startFlushTimer(
  sessionDataDirty: Map<string, Set<string>>,
  sessionDataCache: Map<string, Map<string, unknown>>,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    flushSessionData(sessionDataDirty, sessionDataCache).catch((err: unknown) => {
      console.error('[plugin-service] sessionData flush error:', err)
    })
  }, FLUSH_INTERVAL_MS)
}

/** 停止 sessionData 定时 flush */
export function stopFlushTimer(
  timer: ReturnType<typeof setInterval> | null,
): null {
  if (timer) {
    clearInterval(timer)
  }
  return null
}
