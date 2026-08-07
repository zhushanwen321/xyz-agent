<script setup lang="ts">
/**
 * MobileFilesView —— 移动端只读文件树（spec P4 §3.2 + D6 + C1）。
 *
 * 读 useFileTreeStore tree（fileApi.tree(sessionId) 填充）渲染缩进树节点 + 展开/折叠。
 * 点击文件节点调 fileTreeStore.selectFile(path)（驱动 DetailPane 经 useDetailPane watch 加载内容）
 * 并 emit select(path)（让 FilesTab 切到 detail 视图）。无新建/删除/重命名按钮（AC7 只读断言）。
 * 不引入桌面 FileView/FileTreeRow（含右键/拖拽/新建删除，spec D6 砍）。
 *
 * 数据加载（对齐 renderer FileView.vue）：onMounted + watch(sessionId) 调 useFileTree().loadTree(sid)
 * 触发 fileApi.tree RPC。MobileShell 不挂载桌面 Sidebar，故不能依赖 Sidebar 的 selectSession 触发加载，
 * 本组件自行驱动首加载（sessionId 非空时）。loadTree 内部已缓存复用，重复调用幂等无额外 RPC。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFileTreeStore } from '@/stores/fileTree'
import { useFileTree } from '@/composables/features/useFileTree'
import MobileFileTreeNode from './MobileFileTreeNode.vue'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ select: [path: string] }>()

const { t } = useI18n()
const fileTreeStore = useFileTreeStore()
const { loadTree } = useFileTree()

const tree = computed(() => fileTreeStore.getTree(props.sessionId) ?? [])
/** 本地展开集合（简化版，移动端 P4 用本地状态） */
const expanded = ref<Set<string>>(new Set())

/**
 * 切 session 触发 loadTree（首加载）。与 renderer FileView.vue 同模式：
 * immediate watch（mount 即首次触发）+ 后续 sessionId 变化重触发。
 * loadTree 内部缓存复用（getTree 有值时 rehydrate 后直接返回），不重复发 RPC。
 * sessionId 为空时不调（避免无谓 RPC；空串非合法 session）。
 */
watch(
  () => props.sessionId,
  (sid) => {
    if (sid) void loadTree(sid)
  },
  { immediate: true },
)

function toggle(path: string): void {
  const next = new Set(expanded.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }
  expanded.value = next
}

function onSelect(path: string): void {
  // 写入 store.selectedPath → useDetailPane watch 触发 DetailPane 加载该文件内容（spec D6 文件内容查看）。
  fileTreeStore.selectFile(path)
  emit('select', path)
}
</script>

<template>
  <div class="mobile-files-view flex h-full flex-col" data-testid="mobile-files-view">
    <!-- header -->
    <div class="flex shrink-0 items-center border-b border-border px-4 py-3">
      <span class="text-sm font-semibold">{{ t('mobile.shell.tabFiles') }}</span>
    </div>

    <!-- 树 -->
    <div class="flex-1 overflow-y-auto p-2" data-testid="mobile-files-tree">
      <div v-if="tree.length === 0" class="p-4 text-center text-sm text-subtle" data-testid="mobile-files-empty">
        {{ t('mobile.files.empty') }}
      </div>
      <ul v-else class="flex flex-col">
        <MobileFileTreeNode
          v-for="node in tree"
          :key="node.path"
          :node="node"
          :level="0"
          :expanded="expanded"
          @toggle="toggle"
          @select="onSelect"
        />
      </ul>
    </div>
  </div>
</template>
