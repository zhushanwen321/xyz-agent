/**
 * Settings 域 —— SettingsModal 数据源（返工：纠正订阅 vs 请求契约）。
 *
 * 返工前（错误）：getSkills/getAgents/getExtensions 全 Promise，real 模式后端不响应。
 * 返工后（正确）：providers 请求+订阅；skills/agents/extensions/defaults 纯订阅；
 *               setProvider 动作；system 纯前端 localStorage。
 *
 * 本域是 config/extension 订阅的薄封装，供 SettingsModal 统一从 @/api/settings 消费
 * （Modal 不直接散落 import config/extension）。契约见 contract.md §2.7。
 */
import * as configDomain from './config'
import * as extensionDomain from './extension'

export interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
}

const SYSTEM_KEY = 'xyz-agent:system-settings'
const DEFAULT_SYSTEM: SystemSettings = { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' }

// ── 订阅（转发 config / extension 域）──
export const onProviders = configDomain.onProviders
export const onSkills = configDomain.onSkills
export const onAgents = configDomain.onAgents
export const onExtensions = extensionDomain.onExtensions
export const onDefaults = configDomain.onDefaults

// ── 请求 ──
export const listProviders = configDomain.listProviders

// ── 动作 ──
export const setProvider = configDomain.setProvider

// ── 纯前端偏好（localStorage，不走 transport；mock 侧直接复用本实现，消除手工同构）──
export function getSystem(): Promise<SystemSettings> {
  const raw = localStorage.getItem(SYSTEM_KEY)
  let parsed: Partial<SystemSettings> = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<SystemSettings>
    } catch {
      // 数据损坏：显式回退到默认值（空对象 → 下行 spread 自动用 DEFAULT_SYSTEM 兜底）
      parsed = {}
    }
  }
  return Promise.resolve({ ...DEFAULT_SYSTEM, ...parsed })
}

export function updateSystem(patch: Partial<SystemSettings>): Promise<void> {
  // 同步读当前值再合并写回（getSystem 已做容错）
  void getSystem().then((cur) => {
    localStorage.setItem(SYSTEM_KEY, JSON.stringify({ ...cur, ...patch }))
  })
  return Promise.resolve()
}
