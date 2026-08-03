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

// ── 占位步骤（DM1 签名，P1+ 迁入真实实现）─────────────────────────

// P1: coordination/connection-lifecycle 三分支（mock=VITE_MOCK / 远程=profile / 本地=IPC 端口发现）
export async function initConnection(connectionMode: 'mock' | 'local' | 'remote'): Promise<void> {
  console.log(`[bootstrap] initConnection: mode=${connectionMode}`)
}

// P1: 恢复 active session + subscribed sessions（panel 活跃列表注入 ws-client 重连 auth）
export async function restoreSessions(): Promise<void> {
  console.log('[bootstrap] restoreSessions')
}

// P4: 壳向 ExtensionHost 注册挂载点（sidebar.tab / panel.header.action / composer.toolbar / statusbar）
export async function registerMountPoints(): Promise<void> {
  console.log('[bootstrap] registerMountPoints')
}

// P4: 扫描 plugin manifest 注册声明式贡献（views/menus/commands/statusBarItems/slashCommands/configuration）
export async function scanContributions(): Promise<void> {
  console.log('[bootstrap] scanContributions')
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
