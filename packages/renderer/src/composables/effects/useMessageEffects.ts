/**
 * useMessageEffects —— useConnection 的入站副作用回调实现（架构审计 §11.4）。
 *
 * core use-connection 是 headless（零 store / 零 DOM），入站消息的副作用回调
 * （session.exited / message.complete / session.subagents / session.subagentEntriesAppended /
 * session.workflowUpdate / subagent.stream_delta / 全局 error）与 runtime 崩溃清理
 * （finalizeAllStreaming / clearAllPending）统一归位到本层。
 *
 * 本文件是 renderer 层（可 import store），供 useConnection 装配点经
 * setConnectionPorts 注入 core（ConnectionPorts.effects / onRuntimeUnavailable）。
 *
 * 依赖方向：useMessageEffects → stores + useCompletionNotify + i18n + useToast。
 */
import i18n from '@/i18n'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { usePanelStore } from '@/stores/panel'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { handleCompletion } from '@/composables/effects/useCompletionNotify'
import { invalidateStreamSubscription } from '@xyz-agent/core'
import type { InboundEffects } from '@xyz-agent/core'
import { resolveSubagentParentSessionId, subagentVirtualId } from '@xyz-agent/shared'
import type { PiEntry, PiToolCallEntryForm, ServerMessage, ServerMessageMap, SubagentRecord } from '@xyz-agent/shared'

const t = i18n.global.t

/**
 * 处理 session.exited 事件（pi 进程异常退出）。
 *
 * 不能只依赖 session 通道的惰性订阅（ensureStreamSubscription 在首次 send 时建立）：
 * 进程可能在用户首次发消息前就死（如 extension 加载失败 exit(1)），此时无订阅者，
 * dispatchSession 会静默丢弃。因此 routeInbound 对 session.exited 做兜底处理，
 * 保证 markSessionError + markDead + invalidateStreamSubscription + toast 一定执行。
 *
 * invalidateStreamSubscription：失效本地流订阅标记（服务端订阅已随 bus.clearSession
 * 清除），respawn 后 ensureStreamSubscription 才会重挂 events handler + 重发 subscribe。
 */
function handleSessionExited(sessionId: string, payload: { code: number | null; reason: string }): void {
  useChatStore().markSessionError(sessionId, payload.reason)
  useSessionStore().markDead(sessionId)
  // 失效本地流订阅标记：服务端订阅已随 bus.clearSession 清除（pi 死亡），本地幂等标记
  // 不失效则 respawn 后 ensureStreamSubscription 被短路 → 新 turn 的 message.* 丢失
  //（UI 卡「进行中…」）。放 markDead 之后：错误消息/dead 态等 UI 反馈先落地
  invalidateStreamSubscription(sessionId)
  // D6b（integrity-hardening §3.6）：pi 死后清掉该 session 挂起的 ask-user / dialog 分区
  //（对齐 deleteSession 路径 core use-session cleanup hooks 的 extensionUIStore.clearSession 写法）。
  // 不清则切走再切回（restore 起新 pi）后旧请求重弹，作答发给新进程被静默丢弃（M8 幽灵弹窗）。
  useExtensionUIStore().clearSession(sessionId)
  // reason 可能含多行 stderr，toast 只取首行（完整内容在聊天流 error 消息里）
  const shortReason = payload.reason.split('\n')[0]
  useToast().error(t('connection.runtimeExited', { reason: shortReason }))
}

/**
 * 处理带 sessionId、未命中 pending 的 error envelope（D6b）。
 *
 * 典型场景：pi 死后残留弹窗的作答经 sendExtensionUIResponse 发出，runtime 侧「client
 * 不存在」回 error envelope（fire-and-forget 无 msg.id，不走 pending reject）——此前落
 * session 通道被静默丢弃，用户作答石沉大海。现复用 markSessionError（session 级错误
 * 统一入口：追加 error assistant 消息 + finalize）进消息流展示，并 toast 保证切走的
 * session 也可见。
 */
function handleSessionError(sessionId: string, payload: { code?: string; message?: string }): void {
  const text = t('connection.sessionRequestFailed', { message: payload.message ?? 'Unknown error' })
  useChatStore().markSessionError(sessionId, text)
  useToast().error(text)
}

/**
 * 处理 message.complete 事件（session 生成完成）。
 * 算 focusedSid（当前面板聚焦的 session）→ 交给 handleCompletion 链
 * （aborted 过滤 → background work 守卫 → 后台判定 → 未读标记 → 提示音）。
 */
function handleMessageComplete(sessionId: string, payload: { sessionId?: string; stopReason?: string }): void {
  const panelStore = usePanelStore()
  const focusedSid =
    panelStore.panels.find((p) => p.id === panelStore.activePanelId)?.sessionId ?? null
  handleCompletion(sessionId, payload.stopReason ?? 'stop', focusedSid)
}

/** 处理 session.subagents 事件（subagent 终态推送兜底，非活跃 session 也生效）。 */
function handleSubagents(sessionId: string, subagents: SubagentRecord[]): void {
  useSubagentStore().applyRecords(sessionId, subagents)
}

/**
 * 处理 session.subagentEntriesAppended 事件（E-4，relay tee 产出的 entry 帧兜底）。
 *
 * 帧先于 drawer 打开到达时也写分区（分区惰性创建，§6.1）——消费不依赖 drawer 生命周期，
 * virtualId 经 shared 工厂构造（INVAR-1.1），写入 chatStore 虚拟分区（store 不互 import：
 * 本层是既有跨 store 协调层，同 handleSessionExited 先例）。
 */
function handleSubagentEntries(
  sessionId: string,
  subagentId: string,
  entries: Array<PiEntry | PiToolCallEntryForm>,
): void {
  useChatStore().applySubagentEntries(subagentVirtualId(sessionId, subagentId), entries)
}

/** 处理 session.workflowUpdate 事件（workflow 增量信号兜底）。update 锚定 protocol SSOT（MF-4）。 */
function handleWorkflowUpdate(sessionId: string, update: ServerMessageMap['session.workflowUpdate']['update']): void {
  useWorkflowStore().triggerWorkflowReload(sessionId, update.status ?? 'unknown')
}

/**
 * [idle-refresh] 处理 subagent.stream_delta 帧（docs/design/timeout-streaming-ui-idle.md §5.1 D1 桥接）。
 *
 * sync subagent/workflow 编排期父 session 的 message.* 帧构造性为零（生产端不消费
 * onUpdate），子代理活跃信号走本帧旁路——core routeInbound FALLBACK 按 type 识别后
 * 经 InboundEffects 调用本回调。解析 payload.sessionId（shared 纯函数双形态归一：
 * relay tee 通道三段式虚拟 id `subagent:<mainSessionId>:<subagentId>` → 提取父 sid；
 * 旧 widget 通道主 sid 原样）后刷新父 session 的 streaming idle timer，防「子面板
 * 在打字、父气泡被判无进展」。sessionId 缺失（坏形状帧）no-op——解析是纯字符串
 * 函数无失败形态，无 id 即无可刷新目标。
 */
function handleSubagentStreamDelta(frame: ServerMessage): void {
  const sid = (frame.payload as { sessionId?: string } | null)?.sessionId
  if (typeof sid !== 'string' || !sid) return
  useChatStore().refreshStreamingTimer(resolveSubagentParentSessionId(sid))
}

/** 全局 error 兜底（无 sessionId 无 id 的 server-push error → toast 提示）。 */
function handleGlobalError(message: string): void {
  useToast().error(message)
}

/**
 * runtime 崩溃 / 重启用尽清理（T5）。
 *
 * runtime 崩溃 = pi 子进程没了 = 流不可能继续。重置 chat 活跃态 + 清理 extension UI
 * pending，避免 UI 卡「思考中」+ in-flight Promise 永挂（runtime 重启后是全新实例，
 * ask-user 的 Promise 永远不会被 resolve）。
 *
 * @param reason 'restart'（崩溃重启中）/ 'disconnect'（重启用尽，FinalizeReason）
 */
export function handleRuntimeUnavailable(reason: 'restart' | 'disconnect'): void {
  useChatStore().finalizeAllStreaming(reason)
  useExtensionUIStore().clearAllPending()
}

/**
 * 工厂：构建 InboundEffects 回调集（供 useConnection 装配点注入 core）。
 * 函数引用稳定（模块级定义），重复调用返回同一组行为。
 */
export function createInboundEffects(): InboundEffects {
  return {
    onSessionExited: handleSessionExited,
    onMessageComplete: handleMessageComplete,
    onSubagents: handleSubagents,
    onSubagentEntries: handleSubagentEntries,
    onSubagentStreamDelta: handleSubagentStreamDelta,
    onWorkflowUpdate: handleWorkflowUpdate,
    onGlobalError: handleGlobalError,
    onSessionError: handleSessionError,
  }
}
