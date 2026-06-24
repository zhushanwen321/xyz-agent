/**
 * Extension 域 —— 订阅（onExtensions）+ 动作（toggle）+ 安装多步流（install/Dir/Git/finish/cancel）。
 *
 * 安装多步流（D-4 内联候选选择，issues.md #5 方案 A）：
 * - npm：install(source) → runtime 直接装，config.extensions 推回 → onExtensions 刷新（单步）
 * - dir/git：installDir/installGit → runtime 发现候选回 extension.discovered → UI 内联展开
 *   → finishInstall(selected) → config.extensions 推回 → onExtensions 刷新（多步）
 * - cancelInstall(tempDir) → 清理临时目录（放弃安装）
 *
 * 契约见 contract.md §2.5 / code-architecture.md §3.2/§4.3。
 *
 * 依赖方向：events（订阅）+ transport + pending（请求/动作）。
 */
import type { ExtensionInfo, ExtensionDiscoveredPayload } from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

export function onExtensions(handler: (extensions: ExtensionInfo[]) => void): () => void {
  return events.onGlobalType('config.extensions', (msg) => {
    handler(msg.payload.extensions)
  })
}

export function toggle(name: string, enabled: boolean): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.toggle', id, payload: { name, enabled } })
  return result
}

/** npm 包名直装（单步：runtime 装完推 config.extensions，onExtensions 刷新） */
export function install(source: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.install', id, payload: { source } })
  return result
}

export function uninstall(name: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.uninstall', id, payload: { name } })
  return result
}

/** 本地目录安装（多步第一步）：runtime 复制到 tempDir + 发现候选，回 extension.discovered */
export function installDir(path: string): Promise<ExtensionDiscoveredPayload> {
  const id = pending.create()
  const result = pending.register<ExtensionDiscoveredPayload>(id)
  transport.send({ type: 'extension.installDir', id, payload: { path } })
  return result
}

/** Git URL 安装（多步第一步）：runtime clone 到 tempDir + 发现候选，回 extension.discovered */
export function installGitRepository(url: string): Promise<ExtensionDiscoveredPayload> {
  const id = pending.create()
  const result = pending.register<ExtensionDiscoveredPayload>(id)
  transport.send({ type: 'extension.installGit', id, payload: { url } })
  return result
}

/** 完成安装（多步第二步）：把选中候选从 tempDir 复制到 extensions/，runtime 推 config.extensions */
export function finishInstall(tempDir: string, selected: string[]): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.finishInstall', id, payload: { tempDir, selected } })
  return result
}

/** 放弃安装：清理 tempDir（回 extension.installCancelled） */
export function cancelInstall(tempDir: string): Promise<void> {
  const id = pending.create()
  const result = pending.register<void>(id)
  transport.send({ type: 'extension.cancelInstall', id, payload: { tempDir } })
  return result
}
