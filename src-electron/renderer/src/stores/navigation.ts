/**
 * Navigation store —— 导航历史栈（D1：状态驱动路由，无 vue-router）。
 *
 * 模式参考 main worktree navigation.ts：entries[] + pointer + back/forward +
 * 分支截断（splice pointer+1）+ MAX_ENTRIES=50 上限（超限丢最早）。
 * 扩展：加 'overview' 第三 view（chat/overview/settings）。
 *
 * 依赖方向：无（stores 间禁止互相 import）。
 * 骨架阶段：state/getter 合法初始值，action throw。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { NavEntry } from '@/types'

/** 历史栈容量上限（D1） */
export const MAX_ENTRIES = 50

export const useNavigationStore = defineStore('navigation', () => {
  const entries = ref<NavEntry[]>([])
  const pointer = ref(-1)

  const current = computed<NavEntry | null>(
    () => (pointer.value >= 0 && pointer.value < entries.value.length)
      ? entries.value[pointer.value]
      : null,
  )

  const canBack = computed(() => pointer.value > 0)
  const canForward = computed(() => pointer.value < entries.value.length - 1)

  /** 入栈（超 MAX_ENTRIES 丢最早、分支截断）—— 实现阶段填 */
  function push(entry: NavEntry): void {
    throw new Error(`not implemented: push(${entry.view})`)
  }

  function back(): void {
    throw new Error('not implemented')
  }

  function forward(): void {
    throw new Error('not implemented')
  }

  return { entries, pointer, current, canBack, canForward, push, back, forward }
})
