/**
 * SessionApiPort —— domain/session 访问后端的唯一通道（TC2 契约）。
 *
 * 端口注入模式：core 定义接口类型，壳层（renderer）把现 api/domains/session 适配注入
 * （与 PlatformPort 同模式：core 定义接口、壳注入实现）。core 不 import @/api。
 * P1 完成后 api domains 迁 core/transport 时只需换注入实现，domain 侧零改动。
 *
 * 契约边界：getHistory 不在此端口（属 chat 域）——selectSession 的 hydrate
 * 经 ChatApiPort（w3 use-session 的 ChatHydratePort 注入回调）承接。
 */
import type { SessionGroup, SessionSummary, BatchDeleteResult } from '@xyz-agent/shared'

/**
 * session 后端操作端口。
 * 壳侧实现：renderer 现 api/domains/session（pending/events/request/domains 原样继承，是好地基不动）。
 */
export interface SessionApiPort {
  /** 拉取 session 分组列表（loadSessions 用，填 store.groups） */
  list(): Promise<SessionGroup[]>
  /** 切换 session（selectSession 用；hydrate 不在此端口） */
  switchSession(id: string): Promise<void>
  /** 新建 session（createSessionFlow 用；返回含 cwd 用于 INV-7 降级比对） */
  create(cwd: string, label: string, presetId?: string): Promise<SessionSummary>
  /** 重命名 session（乐观更新后调） */
  rename(id: string, label: string): Promise<void>
  /** 删除单个 session（deleteSession 用） */
  remove(id: string): Promise<void>
  /** 按 cwd 批量删除（deleteFolder 用；返回 deleted/failed 列表） */
  removeByCwd(cwd: string): Promise<BatchDeleteResult>
  /** 迁移 session 图片到 attachments/<sessionId>/（createSessionFlow 的 migrateImages 用） */
  migrateImage(p: { path: string; sessionId: string; needsMigrate: boolean }): Promise<unknown>
  /**
   * 订阅 config.sessions 广播（bindSessionListBroadcast 用，w3 追加）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组；
   * 返回退订函数。对齐 ChatApiPort.streamSubscribe 的「域内订阅放 api port」模式。
   * 壳侧实现：@/api/events.onGlobalType('config.sessions') 并在适配层提取 msg.payload.groups。
   */
  onConfigSessions(handler: (groups: SessionGroup[]) => void): () => void
}
