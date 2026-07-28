<script setup lang="ts">
/**
 * MobileFilesView —— 移动端只读文件树（spec P4 §3.2 + D6 + C1）。
 *
 * 读 useFileTreeStore tree（fileApi.tree(sessionId) 填充）渲染缩进树节点 + 展开/折叠。
 * 点击文件节点 emit select(path)。无新建/删除/重命名按钮（AC7 只读断言）。
 * 不引入桌面 FileView/FileTreeRow（含右键/拖拽/新建删除，spec D6 砍）。
 *
 * P4 简化：只渲染树 + 展开/折叠，文件内容 detail 留 P9（spec §十.2）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFileTreeStore } from '@/stores/fileTree'
import MobileFileTreeNode from './MobileFileTreeNode.vue'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ select: [path: string] }>()

const { t } = useI18n()
const fileTreeStore = useFileTreeStore()

const tree = computed(() => fileTreeStore.getTree(props.sessionId) ?? [])
/** 本地展开集合（简化版，移动端 P4 用本地状态） */
const expanded = ref<Set<string>>(new Set())

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
