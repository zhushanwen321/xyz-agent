/**
 * file 候选加载（CommandPopover 拆出——script 行数约束）。
 * ADR-0049：fileCandidates 从 watch 清理派迁移到 store 缓存驱动——useFileSearch
 * store 已提供 per-session 缓存，loadCandidates 幂等（缓存命中直接返回），
 * watch(sessionId) 仅触发拉取（不重置任何状态）。fileCandidates 是短暂 UI
 * 显示态（非 per-session 业务状态），session 切换从 store 缓存重新填充，
 * 无跨 session 泄漏（store 分区天然隔离）。
 */
import { onMounted, ref, watch, type Ref } from 'vue'
import { toFileCandidates } from '@xyz-agent/core'
import { useFileSearch } from '@/composables/features/search/useFileSearch'

export function useCommandPopoverFileCandidates(sessionId: Ref<string | undefined>) {
  const { load: loadFileCandidates } = useFileSearch()
  const fileCandidates = ref<ReturnType<typeof toFileCandidates>>([])

  // 异步加载文件候选（store 缓存命中则不重拉；无 session 时不加载）
  async function loadCandidates(): Promise<void> {
    if (!sessionId.value) return // landing 态无 cwd，不加载文件候选
    const nodes = await loadFileCandidates(sessionId.value)
    fileCandidates.value = toFileCandidates(nodes)
  }
  onMounted(() => { void loadCandidates() })
  // sessionId 变化时触发拉取（幂等：store 缓存命中直接返回，不重置任何状态——ADR-0049）
  watch(sessionId, () => { void loadCandidates() })
  return { fileCandidates }
}
