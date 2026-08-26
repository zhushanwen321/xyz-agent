/**
 * slash 命令投递闭环（拉 + 推两路，CommandPopover 拆出——script 行数约束）。
 * - 拉：useCommandSync 挂载 / 切 session 主动补拉（skill 消失缺陷的帧丢失兜底，
 *   ADR-0049 reply.sessionId 分区写入）。浮层打开拉取不经此——open 边沿统一由
 *   command-popover-open-fetch 承接（带 1s 节流）；双路并存会重复 RPC
 *   （dev-0.9.9 补拉闭环 × dev-0.9.8 符号系统 open-fetch 合并产物）。
 * - 推：订阅 session.commands（D8 走 session 通道）→ 写 commandStore（跨组件重建持久化）。
 *   FM4 修复（ADR-0049）：使用 useSessionEvents 注入的第二参数 sid（订阅时捕获，
 *   不随 props.sessionId 变化），消除切 sid 时序竞态导致的跨分区污染。
 */
import { type Ref } from 'vue'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import { useCommandSync } from '@/composables/panel/useCommandSync'
import type { RawCommand } from '@xyz-agent/core'

export function useCommandPopoverDelivery(sessionId: Ref<string | undefined>): void {
  const commandStore = useCommandStore()
  useCommandSync(sessionId)
  const onMessage = useSessionEvents(sessionId)
  onMessage('session.commands', (msg, sid) => {
    const cmds = msg.payload.commands as RawCommand[]
    commandStore.applyCommands(sid, cmds)
  })
}
