/**
 * Session 模块内部共享类型。
 *
 * 叶子模块:仅 `import type`,不引入任何项目内运行时依赖,
 * 因此 interfaces.ts 反向 import 此处的类型不会形成模块环
 * (types.ts ← interfaces.ts 单向)。
 *
 * Facade 内部用完整 ManagedSession(extends IManagedSessionView,
 * 额外持有 adapter / interceptor / unsubUsageListener 等运行时句柄)。
 * 子模块经 ISessionServiceInternal 只看到 IManagedSessionView,
 * 但拿到的是 ManagedSession 实例,可读写字段(lastActiveAt / isGenerating)。
 */
import type { ScannedSessionMeta } from '../ports.js'

/** SendMessage hook:消息发送前触发,可阻止发送。 */
export type SendMessageHook = (sessionId: string, content: string) => Promise<{ blocked: boolean; reason?: string } | null>

/** scanPiSessions 返回的元素类型（经 ISessionStore.scanSessions）。 */
export type ScannedSession = ScannedSessionMeta

/**
 * ManagedSession 的子模块可见视图(不含运行时句柄)。
 * 子模块经此引用更新 lastActiveAt / isGenerating 等可变字段。
 */
export interface IManagedSessionView {
  id: string
  cwd: string
  label: string
  modelId: string
  createdAt: number
  lastActiveAt: number
  tokenCount: number
  isGenerating: boolean
  thinkingLevel?: string
  sessionFilePath?: string
}
