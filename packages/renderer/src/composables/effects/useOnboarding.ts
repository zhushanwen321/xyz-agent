/**
 * useOnboarding —— 渐进 onboarding 气泡控制（critique 第 3 轮 Nielsen 第 10 项 Help & Documentation）。
 *
 * message-stream 是新用户首次接触 agent 概念（subagent/workflow/fork/handoff）的地方。
 * 此 composable 为每个概念提供独立的 localStorage 记忆：dismissed 后永不再显示。
 *
 * 设计要点：
 * - **模块级 Map 缓存**：同一个 key 可能在多组件实例同时存在（split mode 多 panel），模块级缓存
 *   避免每实例独立读 localStorage 导致状态不一致（一个实例 dismiss，另一实例仍显）。与
 *   useSessionMarkers.ts 的 cache 模式一致。
 * - **localStorage try/catch 兜底**：隐私模式 / sandboxed iframe 下 localStorage 访问可能 throw
 *   SecurityError，必须兜底（AGENTS.md 规则 #5 错误处理）。兜底策略：访问失败时视为「已 dismissed」，
 *   避免在不可持久化的环境里反复弹气泡。
 * - **不做自动消失**：让用户主动点关闭，避免没看清就没了。
 *
 * 复用范式参考：BrowserPane.vue 的 GUIDE_DISMISSED_KEY guide hint。
 */
import { ref } from 'vue'

/** localStorage key 前缀，与 BrowserPane 的 `xyz-browser-guide-dismissed` 同 `xyz-` 命名空间 */
const STORAGE_PREFIX = 'xyz-onboarding-'

/** 模块级 dismissed 缓存：key → 是否已关闭。避免多实例重复读 localStorage + 状态不一致。 */
const dismissedCache = new Map<string, boolean>()

/** 安全访问 localStorage（隐私模式/iframe 抛 SecurityError 时返回 null） */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isDismissed(key: string): boolean {
  if (dismissedCache.has(key)) return dismissedCache.get(key)!
  const ls = safeLocalStorage()
  // localStorage 不可用（隐私模式等）：视为已 dismissed，避免反复触发不可持久化的气泡
  if (!ls) {
    dismissedCache.set(key, true)
    return true
  }
  const dismissed = ls.getItem(STORAGE_PREFIX + key) === '1'
  dismissedCache.set(key, dismissed)
  return dismissed
}

function setDismissed(key: string): void {
  dismissedCache.set(key, true)
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(STORAGE_PREFIX + key, '1')
  // eslint-disable-next-line taste/no-silent-catch -- 写入失败（配额满 / 受限）静默：内存缓存已更新，本 session 内不再显，跨 session 最多再显一次。与 i18n/index.ts localStorage 损坏同策略
  } catch {
    /* 内存缓存已 set，跨 session 最多再显一次，非关键路径 */
  }
}

export function useOnboarding(key: string) {
  /** 气泡是否可见（首次 = 未 dismissed = 对应 localStorage key 不存在） */
  const visible = ref(!isDismissed(key))

  /** 关闭气泡：本地置 false + 持久化 + 同步模块缓存（其他实例下次 useOnboarding 也不显） */
  function dismiss(): void {
    visible.value = false
    setDismissed(key)
  }

  return { visible, dismiss }
}

/**
 * 测试专用：重置模块级缓存（vitest beforeEach 调）。
 * 不清 localStorage 本身（测试自行 localStorage.clear()），只清内存缓存让下次读重新 hydrate。
 * 与 useSessionMarkers.ts 的 __resetCacheForTest 同范式。
 */
export function __resetOnboardingCacheForTest(): void {
  dismissedCache.clear()
}
