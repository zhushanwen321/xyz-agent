// [tc-transport-consolidation u2 桥] settings 域 WS 部分（config/extension 订阅转发 + worktree/
// smart-context 等 RPC）已下沉 @xyz-agent/core/transport/api/domains/settings；本桥为迁移中间态，
// u5 codemod 拆分混合 import（WS 部分改 core 子路径、IPC 部分留本文件路径）后桥段删除。
// 5 个 Electron IPC 函数（代理/升级设置，经 @/lib/ipc 直连 main 进程，不走 runtime WS）是壳平台
// 门面，留壳与桥合并导出——UpdatePage.vue 等混合具名消费零改动。
import type { IProxyConfig, UpdateSettings, ProxyTestResult } from '@xyz-agent/shared'
import {
  getProxyConfig as getProxyConfigIpc,
  setProxyConfig as setProxyConfigIpc,
  testProxy as testProxyIpc,
  getUpdateSettings as getUpdateSettingsIpc,
  setUpdateSettings as setUpdateSettingsIpc,
} from '@/lib/ipc'

export * from '@xyz-agent/core/transport/api/domains/settings'

// [W4] SystemSettings 类型 + SYSTEM_KEY/DEFAULT_SYSTEM/getSystem/updateSystem 持久化已迁
// @xyz-agent/core（domain/settings system-storage + types）。本文件仅保留 settings WS 桥与
// proxy/update 5 个 ipc 函数。SystemSettings 类型消费方改从 @xyz-agent/core import。

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
