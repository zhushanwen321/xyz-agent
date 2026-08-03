/**
 * spike 临时占位 store —— chatStore（per-session，DM3）。
 *
 * 经 useSessionScopedState 工厂建 per-session 分区（ADR-0049）。
 * PoC 验证链路用，非业务逻辑（D6）。core 包建立后由继任者结构替换。
 * IF6 签名：{ messages, isStreaming, appendDelta, appendMessage, finalize }
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import { useSessionScopedState } from '../use-session-scoped-state'
import type { PlaceholderMessage } from '../types'

/** chat 占位 state 形状（init 返回 reactive 容器，useSessionScopedState 响应式契约） */
interface ChatPartition {
  messages: PlaceholderMessage[]
  isStreaming: boolean
}

export function createChatState(sid: Ref<string | null>) {
  const state = useSessionScopedState(sid, () => ({
    messages: [] as PlaceholderMessage[],
    isStreaming: false,
  }))

  return {
    /** 当前 sid 分区的 messages（只读 computed） */
    messages: computed(() => state.current.value.messages),
    /** 当前 sid 分区的 isStreaming（只读 computed） */
    isStreaming: computed(() => state.current.value.isStreaming),
    /** 累加 delta 到指定 id 的 message content（操作当前 sid 分区） */
    appendDelta(id: string, delta: string): void {
      state.update((s: ChatPartition) => {
        const msg = s.messages.find((m) => m.id === id)
        if (msg) msg.content += delta
      })
    },
    /** 追加一条 message（操作当前 sid 分区） */
    appendMessage(msg: PlaceholderMessage): void {
      state.update((s: ChatPartition) => {
        s.messages.push(msg)
      })
    },
    /** 结束 streaming（操作当前 sid 分区） */
    finalize(): void {
      state.update((s: ChatPartition) => {
        s.isStreaming = false
      })
    },
    /** 显式指定 sid 分区操作（WS handler 防 M1 竞态，透传 useSessionScopedState.updateFor） */
    updateFor(targetSid: string, updater: (s: ChatPartition) => void): void {
      state.updateFor(targetSid, updater)
    },
  }
}
