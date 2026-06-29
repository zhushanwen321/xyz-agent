<template>
  <!--
    DetailPane —— 文件预览面板（#6，UC-6，对齐 draft-detail-pane.html）。
    文件内容 / diff 预览，挂在 SideDrawer detail tab。

    [NFR-AC-S4] 禁 v-html：内容用 <pre> + {{ }} 文本插值渲染，XSS 安全（T6.10）。
    data-testid 标注供 E2E 选择器。

    数据来源：useDetailPane（watch selectedPath → openPreview → git.getDiff / file.read）。
  -->
  <div class="flex h-full flex-col" data-testid="detail-pane">
    <!-- header：文件名 + view toggle（Diff/预览，仅 hasGitChange 时显 toggle） -->
    <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
      <FileText class="size-3.5 shrink-0 text-subtle" />
      <span class="flex-1 truncate font-mono text-[11px] text-fg">{{ fileName }}</span>
      <!-- view toggle：有 git 改动时可切换 diff/preview -->
      <div v-if="state.hasGitChange" class="flex gap-0.5" data-testid="detail-view-toggle">
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[10.5px]"
          :class="state.viewMode === 'diff' ? 'bg-accent-soft text-accent' : 'text-muted'"
          title="显示 git diff"
          @click="onToggleView('diff')"
        >Diff</Button>
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[10.5px]"
          :class="state.viewMode === 'preview' ? 'bg-accent-soft text-accent' : 'text-muted'"
          title="显示文件原始内容"
          @click="onToggleView('preview')"
        >预览</Button>
      </div>
    </div>

    <!-- 加载态（骨架，AC-6.6/T6.7：异步返回前非空白） -->
    <div
      v-if="state.status === 'loading'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4"
      data-testid="detail-loading"
    >
      <Loader2 class="size-4 animate-spin text-subtle opacity-60" />
      <p class="text-[11px] text-subtle opacity-60">加载中...</p>
    </div>

    <!-- 错误态（AC-6.4/T6.4：权限/不存在 → 错误态） -->
    <div
      v-else-if="state.status === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-error"
    >
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="text-[11.5px] text-muted">无法预览此文件</p>
      <p class="font-mono text-[10.5px] text-subtle opacity-70">{{ state.error }}</p>
    </div>

    <!-- 空态（无选中文件） -->
    <div
      v-else-if="state.status === 'idle' || !state.path"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-empty"
    >
      <FileText class="size-6 text-subtle opacity-40" />
      <p class="text-[11.5px] text-subtle opacity-55">点击文件树中的文件预览内容</p>
    </div>

    <!-- 二进制文件占位（AC-6.5/T6.6：binary=true） -->
    <div
      v-else-if="state.binary"
      class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="detail-binary"
    >
      <ImageIcon class="size-6 text-subtle opacity-50" />
      <p class="text-[11.5px] text-muted">二进制文件</p>
      <p class="font-mono text-[10px] text-subtle opacity-60">无法显示差异</p>
    </div>

    <!-- 内容区：diff patch 或文件内容（禁 v-html，<pre> + 文本插值，XSS 安全） -->
    <div v-else class="min-h-0 flex-1 overflow-auto" data-testid="detail-content">
      <!-- 截断提示（>1MB，AC-6.5/T6.5） -->
      <div
        v-if="state.truncated"
        class="border-b border-warning/30 bg-warning/8 px-2 py-1 text-[10px] text-warning"
        data-testid="detail-truncated"
      >
        文件超过 1MB，已截断显示
      </div>
      <pre class="whitespace-pre-wrap break-all p-2 font-mono text-[11px] leading-[1.5] text-fg/90">{{ state.content }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FileText, Loader2, AlertCircle, Image as ImageIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useDetailPane, type DetailViewMode } from '@/composables/features/useDetailPane'

const props = defineProps<{
  /** widget 订阅的 session 标识（与 SideDrawer sessionId 一致，useDetailPane watch 用） */
  sessionId: string | null
}>()

const { state, toggleView } = useDetailPane(
  computed(() => props.sessionId),
)

/** 文件名（basename，从 state.path 取） */
const fileName = computed(() => {
  if (!state.value.path) return '未选择文件'
  const parts = state.value.path.split('/')
  return parts[parts.length - 1] ?? state.value.path
})

function onToggleView(mode: DetailViewMode): void {
  void toggleView(mode)
}
</script>
