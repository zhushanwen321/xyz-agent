// [tc-transport-consolidation 终态] settings 域 WS 部分（config/extension 订阅转发 + worktree/
// smart-context 等 RPC）真源在 @xyz-agent/core/transport/api/domains/settings，消费方直接 import
// core 子路径。本文件是纯 Electron IPC 平台门面——仅保留代理/升级设置 5 个函数（经 @/lib/ipc
// 直连 main 进程，不走 runtime WS；升级模块运行在 main 进程中，使用 lib/ipc.ts 适配层，
// 符合 renderer 对 electronAPI 的唯一适配点规范）。
import type { IProxyConfig, UpdateSettings, ProxyTestResult } from '@xyz-agent/shared'
import {
  getProxyConfig as getProxyConfigIpc,
  setProxyConfig as setProxyConfigIpc,
  testProxy as testProxyIpc,
  getUpdateSettings as getUpdateSettingsIpc,
  setUpdateSettings as setUpdateSettingsIpc,
} from '@/lib/ipc'

// ── 代理配置（update:getProxyConfig / update:setProxyConfig / update:testProxy）──

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
