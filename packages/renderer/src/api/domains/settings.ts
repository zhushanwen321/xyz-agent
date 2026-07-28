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
import { command } from '../request'
import type { ServerMessageMap } from '@xyz-agent/shared'

export interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
  /** 字体大小：small/medium/large，缺省按 medium（D17） */
  fontSize?: 'small' | 'medium' | 'large'
  /** 后台完成提示音开关 */
  completionSound?: boolean
  /**
   * 成功完成提示音：系统声音 id（如 'Glass' / 'complete' / 'Windows Notify System Generic'）。
   * undefined / 空串 → 用平台默认（mac=Glass, win=Windows Notify System Generic, linux=complete）。
   * 跨平台失效兜底（W3）：保存的 id 在当前平台不存在时（如 mac 的 'Hero' 切到 linux），
   * main 侧 sound:play 据 kind 回落到对应平台默认（成功音→平台默认成功音），不再静默。
   */
  successSound?: string
  /** 失败完成提示音：语义同 successSound，默认 mac=Funk / win=Windows Notify Email / linux=message-new-instant */
  errorSound?: string
}

const SYSTEM_KEY = 'xyz-agent:system-settings'
const DEFAULT_SYSTEM: SystemSettings = { locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue', fontSize: 'medium', completionSound: true }

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

// ── Worktree 配置（config.setWorktreeRootDir / config.getWorktreeRootDir）──
/** worktree 专用目录配置 reply 类型。 */
export type WorktreeRootDirReply = ServerMessageMap['config.worktreeRootDir']
/** worktree 初始化脚本配置 reply 类型。 */
type SetupScriptReply = ServerMessageMap['config.setupScript']
/** bare-workspace 初始化脚本配置 reply 类型。 */
type BareSetupScriptReply = ServerMessageMap['config.bareSetupScript']
/** worktree 创建超时时间配置 reply 类型。 */
type WorktreeTimeoutReply = ServerMessageMap['config.worktreeTimeout']
/** 默认基分支配置 reply 类型。 */
type DefaultBaseBranchReply = ServerMessageMap['config.defaultBaseBranch']

/** 设置 worktree 专用目录（持久化到 settings.json）。 */
export async function setWorktreeRootDir(dir: string): Promise<WorktreeRootDirReply> {
  return command('config.setWorktreeRootDir', { dir })
}

/** 读取 worktree 专用目录配置。 */
export async function getWorktreeRootDir(): Promise<WorktreeRootDirReply> {
  return command('config.getWorktreeRootDir', {})
}

/** 设置 worktree 初始化脚本（持久化到 settings.json）。 */
export async function setSetupScript(script: string): Promise<SetupScriptReply> {
  return command('config.setSetupScript', { script })
}

/** 读取 worktree 初始化脚本配置。 */
export async function getSetupScript(): Promise<SetupScriptReply> {
  return command('config.getSetupScript', {})
}

/** 设置 bare-workspace 初始化脚本（持久化到 settings.json）。 */
export async function setBareSetupScript(script: string): Promise<BareSetupScriptReply> {
  return command('config.setBareSetupScript', { script })
}

/** 读取 bare-workspace 初始化脚本配置。 */
export async function getBareSetupScript(): Promise<BareSetupScriptReply> {
  return command('config.getBareSetupScript', {})
}

/** 设置 worktree 创建超时时间（秒，持久化到 settings.json）。 */
export async function setWorktreeTimeout(timeout: number): Promise<WorktreeTimeoutReply> {
  return command('config.setTimeout', { timeout })
}

/** 读取 worktree 创建超时时间配置。 */
export async function getWorktreeTimeout(): Promise<WorktreeTimeoutReply> {
  return command('config.getTimeout', {})
}

/** 设置默认基分支（持久化到 settings.json）。 */
export async function setDefaultBaseBranch(baseBranch: string): Promise<DefaultBaseBranchReply> {
  return command('config.setDefaultBaseBranch', { baseBranch })
}

/** 读取默认基分支配置。 */
export async function getDefaultBaseBranch(): Promise<DefaultBaseBranchReply> {
  return command('config.getDefaultBaseBranch', {})
}

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

export async function updateSystem(patch: Partial<SystemSettings>): Promise<void> {
  // 真 await：读当前值 → 合并 → 写回。写入失败 throw（调用方可据 toast 提示）。
  const cur = await getSystem()
  localStorage.setItem(SYSTEM_KEY, JSON.stringify({ ...cur, ...patch }))
}
