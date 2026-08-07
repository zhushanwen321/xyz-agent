<script setup lang="ts">
/**
 * MobileFileDetail —— 移动端文件内容查看（spec P4 D6 + §二 目录结构 + §九 E2E）。
 *
 * 薄包装：移动端 header（返回按钮 + 文件名）+ 复用桌面 DetailPane（已 copy 到 mobile-renderer）。
 *
 * 数据流（对齐 renderer SideDrawer detail tab）：
 *   MobileFilesView 点文件 → fileTreeStore.selectFile(path)
 *   → useDetailPane watch selectedPath → openPreview → DetailPane 渲染内容（code/markdown/image/diff）
 *
 * 图片走 file.signUrl（spec D6）：DetailPane 内 useDetailImage 远程模式现签 + httpOrigin 拼 src，
 * 已 copy 自 renderer（composables/panel/useDetailImage.ts），零改动。
 *
 * 移动端简化：不做桌面 DetailPane 的 hover tooltip（hover-card 移动端不友好），
 * 但保留完整渲染能力（code/markdown/image/diff），文件名显示在 header。
 * 文件名取自 fileTreeStore.selectedPath（basename），无选中时显示空态提示。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft } from '@lucide/vue'
import { useFileTreeStore } from '@/stores/fileTree'
import DetailPane from '@/components/panel/DetailPane.vue'

defineProps<{ sessionId: string }>()
const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const fileTreeStore = useFileTreeStore()

/** 当前选中文件名（basename，从 store.selectedPath 取）。无选中为空串。 */
const fileName = computed(() => {
  const path = fileTreeStore.selectedPath
  if (!path) return ''
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
})

function onBack(): void {
  emit('back')
}
</script>

<template>
  <div class="mobile-file-detail flex h-full flex-col" data-testid="mobile-file-detail">
    <!-- header：返回按钮 + 文件名 -->
    <div
      class="flex shrink-0 items-center gap-2 border-b border-border px-2 py-3"
      data-testid="mobile-file-detail-header"
    >
      <button
        type="button"
        class="flex items-center gap-1 border-0 bg-transparent py-1 text-sm text-muted"
        data-testid="mobile-file-detail-back"
        :aria-label="t('mobile.files.back')"
        @click="onBack"
      >
        <ArrowLeft :size="18" />
      </button>
      <span class="truncate text-sm font-semibold">{{ fileName }}</span>
    </div>

    <!-- DetailPane：复用桌面完整文件内容渲染（code/markdown/image via signUrl/diff） -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <DetailPane :session-id="sessionId" />
    </div>
  </div>
</template>
