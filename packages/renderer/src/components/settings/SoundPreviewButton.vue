<script setup lang="ts">
/**
 * SoundPreviewButton —— 提示音试听按钮（SelectItem #action slot 内用）。
 *
 * 固定 size-4 图标按钮，loading 时 Volume2 → Loader2 spinner，尺寸严格一致（不引起布局位移）。
 * 下拉项内的试听入口：始终可见（SelectItem #action 容器已改 absolute + opacity-100）。
 *
 * [HISTORICAL] 不用 :disabled="loading"：
 * 原实现 loading 时设 button disabled，但 disabled 态会改变 cursor/opacity，
 * 且在 reka SelectItem 内 disabled button 的 pointerdown 行为不一致（部分浏览器
 * 不触发 pointerdown，导致 @pointerdown.stop 失效 → 选中该项）。改为 loading 时
 * pointer-events-none + aria-busy，视觉上 spinner 已表明进行中，重入由 previewSound
 * 的 previewingKey 判断兜底。
 */
import { Loader2, Volume2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{
  /** 是否正在播放（loading 态） */
  loading: boolean
  /** hover tooltip 文案（试听） */
  title: string
}>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    :title="title"
    :aria-busy="loading"
    :class="loading
      ? '!h-4 !w-4 !gap-0 !p-0 pointer-events-none text-accent'
      : '!h-4 !w-4 !gap-0 !p-0 text-subtle hover:!bg-transparent hover:text-accent'"
    @click="$emit('click')"
  >
    <Loader2 v-if="loading" class="size-3 animate-spin" />
    <Volume2 v-else class="size-3" />
  </Button>
</template>
