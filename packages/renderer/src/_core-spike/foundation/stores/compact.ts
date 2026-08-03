/**
 * spike 临时占位 store —— compactStore（per-session，DM3）。
 *
 * 经 useSessionScopedState 工厂建 per-session 分区（ADR-0049）。
 * PoC 验证链路用，非业务逻辑（D6）。core 包建立后由继任者结构替换。
 * IF6/DM3 签名：{ lastCompactedAt: number|null, setCompacted }
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import { useSessionScopedState } from '../use-session-scoped-state'

/** compact 占位 state 形状（init 返回 reactive 容器，useSessionScopedState 响应式契约） */
interface CompactPartition {
  lastCompactedAt: number | null
}

export function createCompactState(sid: Ref<string | null>) {
  const state = useSessionScopedState(sid, () => ({
    lastCompactedAt: null as number | null,
  }))

  return {
    /** 当前 sid 分区的 lastCompactedAt（只读 computed） */
    lastCompactedAt: computed(() => state.current.value.lastCompactedAt),
    /** 设置 compact 时间戳（操作当前 sid 分区） */
    setCompacted(at: number): void {
      state.update((s: CompactPartition) => {
        s.lastCompactedAt = at
      })
    },
    /** 显式指定 sid 分区操作（WS handler 防 M1 竞态，透传 useSessionScopedState.updateFor） */
    updateFor(targetSid: string, updater: (s: CompactPartition) => void): void {
      state.updateFor(targetSid, updater)
    },
  }
}
