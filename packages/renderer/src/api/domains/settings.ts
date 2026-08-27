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
import type { ServerMessageMap, IProxyConfig, UpdateSettings, ProxyTestResult } from '@xyz-agent/shared'
import {
  getProxyConfig as getProxyConfigIpc,
  setProxyConfig as setProxyConfigIpc,
  testProxy as testProxyIpc,
  getUpdateSettings as getUpdateSettingsIpc,
  setUpdateSettings as setUpdateSettingsIpc,
} from '@/lib/ipc'

// [W4] SystemSettings 类型 + SYSTEM_KEY/DEFAULT_SYSTEM/getSystem/updateSystem 持久化已迁
// @xyz-agent/core（domain/settings system-storage + types）。本文件仅保留 transport 转发与
// proxy/worktree ipc 函数。SystemSettings 类型消费方改从 @xyz-agent/core import。

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
/** 自动重命名 session 配置 reply 类型。 */
type AutoRenameEnabledReply = ServerMessageMap['config.autoRenameEnabled']
/** rename 标题生成模型配置 reply 类型。 */
type RenameModelReply = ServerMessageMap['config.renameModel']
/** 智能上下文压缩配置（get 全量）reply 类型。 */
type SmartContextConfigReply = ServerMessageMap['config.smartContextConfig']
/** 智能上下文压缩开关配置 reply 类型。 */
type SmartContextEnabledReply = ServerMessageMap['config.smartContextEnabled']
/** 智能上下文压缩模型配置 reply 类型。 */
type SmartContextCompactModelReply = ServerMessageMap['config.smartContextCompactModel']
/** 智能上下文提醒阈值配置 reply 类型。 */
type SmartContextThresholdsReply = ServerMessageMap['config.smartContextThresholds']
/** 智能上下文排除模型配置 reply 类型。 */
type SmartContextExcludedModelsReply = ServerMessageMap['config.smartContextExcludedModels']

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

/** 设置自动重命名 session 开关。 */
export async function setAutoRenameEnabled(enabled: boolean): Promise<AutoRenameEnabledReply> {
  return command('config.setAutoRenameEnabled', { enabled })
}

/** 读取自动重命名 session 配置。 */
export async function getAutoRenameEnabled(): Promise<AutoRenameEnabledReply> {
  return command('config.getAutoRenameEnabled', {})
}

/** 设置 rename 标题生成模型（"provider/modelId"，空串 = 清除回未设置）。 */
export async function setRenameModel(model: string): Promise<RenameModelReply> {
  return command('config.setRenameModel', { model })
}

/** 读取 rename 标题生成模型（"provider/modelId"，空串 = 未设置）。 */
export async function getRenameModel(): Promise<RenameModelReply> {
  return command('config.getRenameModel', {})
}

/** 读取智能上下文压缩配置全量（compactModel 空串 = 未设置；thresholds 为 token 绝对数）。 */
export async function getSmartContextConfig(): Promise<SmartContextConfigReply> {
  return command('config.getSmartContextConfig', {})
}

/** 设置智能上下文压缩开关。 */
export async function setSmartContextEnabled(enabled: boolean): Promise<SmartContextEnabledReply> {
  return command('config.setSmartContextEnabled', { enabled })
}

/** 设置压缩模型（"provider/modelId"，空串 = 跟随当前会话模型）。 */
export async function setSmartContextCompactModel(model: string): Promise<SmartContextCompactModelReply> {
  return command('config.setSmartContextCompactModel', { model })
}

/** 设置 3 档提醒阈值（token 绝对数，runtime 侧 clamp 升序 3 档）。 */
export async function setSmartContextThresholds(thresholds: number[]): Promise<SmartContextThresholdsReply> {
  return command('config.setSmartContextThresholds', { thresholds })
}

/** 设置排除模型列表（每条完整 provider/modelId，runtime 侧过滤无 "/" 条目去重）。 */
export async function setSmartContextExcludedModels(models: string[]): Promise<SmartContextExcludedModelsReply> {
  return command('config.setSmartContextExcludedModels', { models })
}

// ── 代理配置（update:getProxyConfig / update:setProxyConfig / update:testProxy）──
// 代理配置通过 Electron IPC 直接与 main 进程通信（不走 runtime WS），
// 因为升级模块运行在 main 进程中。
// 使用 lib/ipc.ts 适配层，符合 renderer 对 electronAPI 的唯一适配点规范。

/** 读取代理配置。 */
export async function getProxyConfig(): Promise<IProxyConfig> {
  return getProxyConfigIpc()
}

/** 保存代理配置。 */
export async function setProxyConfig(config: IProxyConfig): Promise<void> {
  await setProxyConfigIpc(config)
}

/** 测试代理连接。 */
export async function testProxy(config: IProxyConfig): Promise<ProxyTestResult> {
  return testProxyIpc(config)
}

// [W4] getSystem/updateSystem（纯前端 localStorage 持久化）已迁 @xyz-agent/core
// domain/settings/system-storage（经 PlatformPort.storage KVStorage）。renderer 壳 useSettingsShell
// providePlatform 注入 LocalStorageAdapter 后，core settings-lifecycle.init 直接读 storage。

// ── 升级设置（update:getSettings / update:setSettings）──
// 预下载开关等升级偏好，通过 Electron IPC 直接与 main 进程通信（不走 runtime WS）。

/** 读取升级设置。 */
export async function getUpdateSettings(): Promise<UpdateSettings> {
  return getUpdateSettingsIpc()
}

/** 保存升级设置（局部更新：只传要修改的字段）。 */
export async function setUpdateSettings(settings: Partial<UpdateSettings>): Promise<void> {
  await setUpdateSettingsIpc(settings)
}
