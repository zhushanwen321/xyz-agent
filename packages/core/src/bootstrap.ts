// bootstrap —— 应用启动编排入口（IF1 契约）。
//
// 显式 await 串联五步，无隐式 import 顺序依赖（AC6）。P0 骨架阶段：后四步为占位（DM1），
// P1+ 真实实现迁入对应域目录后，bootstrap.ts 编排不动。
//
// 时序链（renderer-rebuild-architecture.md §11.0.3）：
//   providePlatform(port) → initConnection(mode) → restoreSessions() →
//   registerMountPoints() → scanContributions()
//
// ES1 失败语义：任一步 reject/throw 由 await 自然中断后续并向上抛出（不吞错、不包装，
// 保留原 stack）。启动失败必须可见，壳捕获后展示降级 UI。
import type { PlatformPort } from './platform/port'
// namespace import：bootstrap 内部经 portNs.providePlatform() 调用，使单测 vi.spyOn(portNs,
// 'providePlatform') 走属性访问可靠（不依赖 ESM live binding 细节）。
import * as portNs from './platform/port'
import type { MountPointRegistry } from './extension-host/mount-point-registry'
import type { ContributionRegistry } from './extension-host/contribution-registry'

// ── 占位步骤（DM1 签名，P1+ 迁入真实实现）─────────────────────────

// P1: coordination/connection-lifecycle 三分支（mock=VITE_MOCK / 远程=profile / 本地=IPC 端口发现）
// 真实实现归 core/transport/use-connection（§10.2 迁移中）——保持占位：连接模式驱动由壳装配。
export async function initConnection(connectionMode: 'mock' | 'local' | 'remote'): Promise<void> {
  console.log(`[bootstrap] initConnection: mode=${connectionMode}`)
}

// P1: 恢复 active session + subscribed sessions（panel 活跃列表注入 ws-client 重连 auth）
// [TODO §12.1] core 无 SessionService（grep 零命中）——实现依赖缺失，保持占位，等 session 域下沉后实现。
export async function restoreSessions(): Promise<void> {
  console.log('[bootstrap] restoreSessions (TODO: core SessionService missing)')
}

// ExtensionHost 注册表注入点（对齐 subscription-state 注入模式：core 定义注入函数，壳装配时 set，
// 未注入 warn 降级不抛错——ES2 防御，单测可不注入直接测其他步骤）。
let mountRegistryImpl: MountPointRegistry | undefined
let contributionRegistryImpl: ContributionRegistry | undefined

/** 壳装配时注入 ExtensionHost 注册表（§12.1 wiring）。未注入时 registerMountPoints/scanContributions warn 降级。 */
export function setExtensionRegistries(registries: {
  mountPoints: MountPointRegistry
  contributions: ContributionRegistry
}): void {
  mountRegistryImpl = registries.mountPoints
  contributionRegistryImpl = registries.contributions
}

// P4: 壳向 ExtensionHost 注册挂载点（sidebar.tab / panel.header.action / composer.toolbar / statusbar）
export async function registerMountPoints(): Promise<void> {
  if (!mountRegistryImpl) {
    console.warn('[bootstrap] registerMountPoints: registry not injected, skip (setExtensionRegistries)')
    return
  }
  // Tier 1 挂载点（§12.1，对齐 audit §12.1 步骤 1）：sidebar tab / panel header action / composer toolbar / statusbar
  mountRegistryImpl.register('sidebar.tab')
  mountRegistryImpl.register('panel.header.action')
  mountRegistryImpl.register('composer.toolbar')
  mountRegistryImpl.register('statusbar')
}

// P4: 扫描 plugin manifest 注册声明式贡献（views/menus/commands/statusBarItems/slashCommands/configuration）
export async function scanContributions(): Promise<void> {
  if (!contributionRegistryImpl) {
    console.warn('[bootstrap] scanContributions: registry not injected, skip (setExtensionRegistries)')
    return
  }
  contributionRegistryImpl.registerBuiltin()
  // loadExternal：external plugin descriptors 经 runtime 透传（s3 通道未完成，ERR5 降级——空数组 no-op）
  contributionRegistryImpl.loadExternal([])
}

// bootstrap 内部步骤表（命名导出，供单测 vi.spyOn(bootstrapSteps, '<fn>') 验证 ES1 顺序 + reject 中断）。
// 聚合为对象使 spy 走属性访问（可靠），不依赖 ESM live binding 细节。
export const bootstrapSteps = {
  initConnection,
  restoreSessions,
  registerMountPoints,
  scanContributions,
}

export interface BootstrapOptions {
  platform: PlatformPort
  connectionMode: 'mock' | 'local' | 'remote'
}

// bootstrap —— 启动编排入口（IF1）。显式 await 串联五步。
// 注意：五步均为显式 await，无隐式 import 副作用（TC4 grep gate 验证）。
export async function bootstrap(options: BootstrapOptions): Promise<void> {
  await portNs.providePlatform(options.platform)
  await bootstrapSteps.initConnection(options.connectionMode)
  await bootstrapSteps.restoreSessions()
  await bootstrapSteps.registerMountPoints()
  await bootstrapSteps.scanContributions()
}
