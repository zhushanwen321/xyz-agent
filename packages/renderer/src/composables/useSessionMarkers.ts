/**
 * useSessionMarkers —— 统一 per-session 用户标记（未读 + 标记完成）。
 *
 * 设计决策（handoff §为什么合并）：
 * - 单 localStorage key `xyz-agent:session-markers`
 * - 单 registerSessionCleanup 注册
 * - 单 storage event listener（多窗口同步）
 * - 标记完成时内部自动清除同 sid 的 unread
 *
 * 为什么不用 useSessionScopedState：标量 boolean flag 不需要 reactive 容器模式，
 * localStorage + 内存缓存更合适。但必须走 registerSessionCleanup 注册清理。
 */
import { shallowRef } from 'vue'
import { registerSessionCleanup } from '@/composables/useSessionScopedState'

interface SessionMarker {
  unread?: boolean
  markedDone?: boolean
}

const STORAGE_KEY = 'xyz-agent:session-markers'

// ── 内存缓存（避免每次 isUnread 都 parse JSON）──
const cache = shallowRef<Map<string, SessionMarker>>(new Map())
// 是否已尝试从 localStorage hydrate。禁止用 cache.value.size===0 推断「是否已 hydrate」——
// localStorage 存空对象 {} 时 new Map 是空 Map，size===0 恒成立，会导致每次查询都重新 parse。
let hydrated = false

// ── localStorage 读写 ──

function readAll(): Record<string, SessionMarker> {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, SessionMarker>
  } catch {
    return {}
  }
}

function writeAll(data: Record<string, SessionMarker>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  // 同步更新内存缓存
  cache.value = new Map(Object.entries(data))
}

/**
 * 确保 cache 已从 localStorage hydrate。首次调用（无论 localStorage 为空还是有数据）hydrate 一次，
 * 之后不再重复。后续 writeAll 会同步更新 cache.value，读取直接命中。
 * 查询函数（isUnread/isMarkedDone）调此函数保证首次读取正确，同时访问 cache.value
 * 建立响应式依赖（markUnread/clearUnread 改 cache.value 时，依赖此函数结果的 computed 重算）。
 */
function ensureCache(): void {
  if (hydrated) return
  hydrated = true
  cache.value = new Map(Object.entries(readAll()))
}

// ── 多窗口同步（storage event）──
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      // 直接从事件 newValue 更新缓存，不重新 parse localStorage（避免竞态）
      try {
        const data = e.newValue ? JSON.parse(e.newValue) as Record<string, SessionMarker> : {}
        cache.value = new Map(Object.entries(data))
      } catch {
        cache.value = new Map()
      }
    }
  })
}

// ── API ──

/** 标记 session 为未读 */
export function markUnread(sid: string): void {
  const data = readAll()
  const marker = data[sid] ?? {}
  marker.unread = true
  data[sid] = marker
  writeAll(data)
}

/** 清除 session 未读标记 */
export function clearUnread(sid: string): void {
  const data = readAll()
  const marker = data[sid]
  if (!marker) return
  marker.unread = false
  // 如果两个标记都为 false/undefined，移除整个条目
  if (!marker.unread && !marker.markedDone) {
    delete data[sid]
  } else {
    data[sid] = marker
  }
  writeAll(data)
}

/** 查询 session 是否未读 */
export function isUnread(sid: string): boolean {
  ensureCache()
  return cache.value.get(sid)?.unread ?? false
}

/** 切换标记完成状态，内部自动清除同 sid 的 unread */
export function toggleMarkedDone(sid: string): void {
  const data = readAll()
  const marker = data[sid] ?? {}
  marker.markedDone = !marker.markedDone
  // 标记完成时自动清除 unread
  if (marker.markedDone) {
    marker.unread = false
  }
  // 如果两个标记都为 false/undefined，移除整个条目
  if (!marker.unread && !marker.markedDone) {
    delete data[sid]
  } else {
    data[sid] = marker
  }
  writeAll(data)
}

/** 查询 session 是否已标记完成 */
export function isMarkedDone(sid: string): boolean {
  ensureCache()
  return cache.value.get(sid)?.markedDone ?? false
}

/** 清除 session 的所有标记（registerSessionCleanup 注册用） */
export function clearAll(sid: string): void {
  const data = readAll()
  if (!(sid in data)) return
  delete data[sid]
  writeAll(data)
}

// ── 注册 session 销毁清理 ──
registerSessionCleanup(clearAll)

/** 测试专用：重新注册 cleanup（__clearSessionCleanupRegistryForTest 后补注册）。 */
export function __registerCleanupForTest(): void {
  registerSessionCleanup(clearAll)
}

/** 测试专用：重置内存缓存与 hydrated flag（localStorage.clear() 不同步模块级 cache，测试隔离用）。 */
export function __resetCacheForTest(): void {
  cache.value = new Map()
  hydrated = false
}

/**
 * useSessionMarkers composable（函数式封装，方便测试 mock）。
 */
export function useSessionMarkers() {
  return { markUnread, clearUnread, isUnread, toggleMarkedDone, isMarkedDone, clearAll }
}
