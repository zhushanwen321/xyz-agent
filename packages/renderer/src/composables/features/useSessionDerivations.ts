/**
 * useSessionDerivations —— session 派生状态轻量 composable（R2 features 层）。
 *
 * 重构动机（2026-07-02 架构返工 C3）：useSidebar 曾吞 5 个关注点
 * （session CRUD + 启动编排 initApp + 派生状态 derivedStatus/sessionDigest + 命令时序修补 +
 * 文件树预触发），8 个消费者各只用一部分。其中 derivedStatus / sessionDigest 是纯派生计算，
 * 被多个「只需派生状态、不需要 session CRUD 巨型闭包」的消费者（Sidebar/PanelContainer/Overview）共用。
 *
 * 本 composable 把派生职责从 useSidebar 抽离，让只用派生状态的消费者改依赖本轻量 composable，
 * 不再拉入 useSidebar 的 session CRUD 巨型闭包（消除不必要的依赖耦合）。
 *
 * 派生逻辑本体（deriveStatus 纯函数）在 composables/logic/sessionStatus.ts（与 DOT_CLASS 同源，
 * 5 态 SSOT 聚合）；本 composable 只做「读 chat/session store → 包成响应式 ComputedRef」的薄包装。
 *
 * 为什么是 features 层而非 store 内：stores 互不 import，派生需同时读 chat store（消息分区）+
 * session store（activeId），无法放在单个 store 内（R2 铁律：stores 间禁止互相 import）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { deriveStatus } from '@/composables/logic/sessionStatus'
import type { DerivedStatus } from '@/types'

/**
 * session 鸟瞰摘要（Overview 卡片用）。
 * - summary：末条 assistant 文本（content），无则空串（卡片不渲染摘要区）
 * - turnCount：user 消息数（回合 = user + 其后 assistant 序列）
 */
export interface SessionDigest {
  summary: string
  turnCount: number
}

export function useSessionDerivations() {
  const chat = useChatStore()
  const session = useSessionStore()

  /**
   * 响应式派生指定 session 的状态点（D6）。
   * 读 chat store 分区末尾消息 + 全局 isStreaming（当前活跃 session 的流式态）。
   * 计算逻辑与重构前完全一致（deriveStatus 纯函数未改）。
   */
  function derivedStatus(id: string): ComputedRef<DerivedStatus> {
    return computed(() => {
      const isActiveStreaming = chat.isGenerating(id) && session.activeId === id
      return deriveStatus(id, chat, isActiveStreaming)
    })
  }

  /**
   * 响应式派生指定 session 的鸟瞰摘要（Overview 卡片用）。
   * - summary：末条 assistant 文本（content），无则空串（卡片不渲染摘要区）
   * - turnCount：user 消息数（回合 = user + 其后 assistant 序列）
   * 文件改动数无 mock 数据源（runtime file-changes 未联调），不臆造，卡片隐藏该指标。
   * 计算逻辑与重构前完全一致。
   */
  function sessionDigest(id: string): ComputedRef<SessionDigest> {
    return computed(() => {
      const msgs = chat.getMessages(id)
      let lastAssistant = ''
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i].role === 'assistant') {
          lastAssistant = msgs[i].content
          break
        }
      }
      const turnCount = msgs.filter((m) => m.role === 'user').length
      return { summary: lastAssistant, turnCount }
    })
  }

  return {
    derivedStatus,
    sessionDigest,
  }
}
