/**
 * Extension 域 —— 订阅（onExtensions/onWidget/onStatus）+ 动作（toggle）+ 安装多步流。
 *
 * 安装多步流（D-4 内联候选选择，issues.md #5 方案 A）：
 * - npm：install(source) → runtime 直接装，config.extensions 推回 → onExtensions 刷新（单步）
 * - dir/git：installDir/installGit → runtime 发现候选回 extension.discovered → UI 内联展开
 *   → finishInstall(selected) → config.extensions 推回 → onExtensions 刷新（多步）
 * - cancelInstall(tempDir) → 清理临时目录（放弃安装）
 *
 * widget 订阅（issues.md #11 方案 A / code-architecture §4.9 / NFR §性能）：
 * - 走 session 通道（D-7），按 sessionId 路由
 * - onWidget：pi extension setWidget → runtime 推 extension:widget（payload {sessionId, widgetKey, lines}）
 *   runtime **每次推送全量 lines**（非增量、非分片，已 grep 确认 event-adapter.ts:383 setWidget），
 *   故无需分片重组；前端只做 1000 行截断（NFR「前端最多保留 1000 行」），保留最新尾部。
 *   runtime 保证 widget 输出不会超过 1MB（全量推送，非分片）。
 *
 * 契约见 contract.md §2.5 / code-architecture.md §3.2/§4.3/§4.9。
 *
 * 依赖方向：events（订阅）+ transport + pending（请求/动作）。
 */
import type {
  ExtensionInfo,
  ExtensionDiscoveredPayload,
  ExtensionWidgetPayload,
  ExtensionStatusPayload,
} from '@xyz-agent/shared'
import * as transport from '../transport'
import * as pending from '../pending'
import * as events from '../events'

/** widget 显示缓冲行数上限（NFR Issue #11 性能：前端最多保留 1000 行，超出截断保留尾部最新） */
export const WIDGET_MAX_LINES = 1000

export type OnWidgetHandler = (payload: ExtensionWidgetPayload) => void
export type OnStatusHandler = (payload: ExtensionStatusPayload) => void

/**
 * 订阅指定 session 的 extension:widget 推送，返回取消函数。
 *
 * runtime 每次 setWidget 推送全量 lines（已确认无分片协议），handler 收到截断后的尾部最新 lines。
 */
export function onWidget(sessionId: string, handler: OnWidgetHandler): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type !== 'extension:widget') return
    // events.on 无 per-type 泛型收窄（非 onGlobalType），payload 为联合宽类型，按契约窄断言取字段。
    const payload = msg.payload as ExtensionWidgetPayload
    // 防御性校验：events.on 按 sessionId 路由，但 payload.sessionId 可能因 bug 不一致
    if (payload.sessionId !== sessionId) return
    handler({
      sessionId: payload.sessionId,
      widgetKey: payload.widgetKey,
      lines: truncateLines(payload.lines),
    })
  })
}

/** 订阅指定 session 的 extension:status 推送（状态栏文本），返回取消函数 */
export function onStatus(sessionId: string, handler: OnStatusHandler): () => void {
  return events.on(sessionId, (msg) => {
    if (msg.type !== 'extension:status') return
    const payload = msg.payload as ExtensionStatusPayload
    // 防御性校验：events.on 按 sessionId 路由，但 payload.sessionId 可能因 bug 不一致
    if (payload.sessionId !== sessionId) return
    handler({
      sessionId: payload.sessionId,
      statusKey: payload.statusKey,
      text: payload.text,
    })
  })
}

/** 保留最新尾部 WIDGET_MAX_LINES 行（前端缓冲上限，NFR Issue #11） */
function truncateLines(lines: string[]): string[] {
  if (lines.length <= WIDGET_MAX_LINES) return lines
  return lines.slice(lines.length - WIDGET_MAX_LINES)
}

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
