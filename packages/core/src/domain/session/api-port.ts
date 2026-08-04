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
  /**
   * 迁移 landing 态 tmpdir 图片到 attachments/<sessionId>/（createSessionFlow 的 migrateImages 用）。
   * 签名对齐 renderer api/domains/session.ts（C-W4-1）：
   * - fromPath：源 tmpdir 路径（segment.path）
   * - fileName：磁盘文件全名（segment.fileName，含 uuid 前缀）
   * - 返回 { path }：迁移后 attachments/<sessionId>/ 新路径
   * needsMigrate 是 Segment 字段（迁移判断条件，见 shared/segments.ts），不在此入参——
   * createSessionFlow 内扫描 segment.needsMigrate 命中才调本方法。
   */
  migrateImage(p: { fromPath: string; sessionId: string; fileName: string }): Promise<{ path: string }>
  /**
   * 订阅 config.sessions 广播（bindSessionListBroadcast 用，w3 追加）。
   * runtime 在 create/delete/rename 后 broadcastSessionList 推全量分组；
   * 返回退订函数。对齐 ChatApiPort.streamSubscribe 的「域内订阅放 api port」模式。
   * 壳侧实现：@/api/events.onGlobalType('config.sessions') 并在适配层提取 msg.payload.groups。
   */
  onConfigSessions(handler: (groups: SessionGroup[]) => void): () => void
}
