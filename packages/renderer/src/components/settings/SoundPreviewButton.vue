<script setup lang="ts">
/**
 * SoundPreviewButton —— 提示音试听按钮（SelectItem #action slot 内用）。
 *
 * 固定 size-4 图标按钮，loading 时 Volume2 → Loader2 spinner，尺寸不变（不引起布局位移）。
 * 下拉项内的试听入口：hover 该项时显现（由 SelectItem #action 容器的 opacity 控制），
 * 点击试听该声音，不触发 SelectItem 选中（#action 容器层 @click.stop 兜底）。
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
    :disabled="loading"
    class="!h-4 !w-4 !gap-0 !p-0 text-subtle hover:!bg-transparent hover:text-accent disabled:text-accent disabled:opacity-100"
    @click="$emit('click')"
  >
    <Loader2 v-if="loading" class="size-3 animate-spin" />
    <Volume2 v-else class="size-3" />
  </Button>
</template>
