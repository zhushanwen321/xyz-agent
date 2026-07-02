<template>
  <!--
    薄封装：会话删除的领域确认框。
    复用 ConfirmDialog 原语，仅负责把标题/描述填充为会话语义，
    并把无 payload 的 confirm 回调映射为带 sessionId 的领域事件（供 Sidebar 消费）。
  -->
  <ConfirmDialog
    v-model:open="innerOpen"
    variant="danger"
    title="删除会话"
    :description="confirmDescription"
    confirm-text="删除"
    cancel-text="取消"
    @confirm="onConfirm"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ConfirmDialog } from '@/components/ui/dialog'

const props = defineProps<{
  open: boolean
  sessionId: string
  sessionLabel: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: [sessionId: string]
}>()

/** v-model:open 双向中转（ConfirmDialog 受控 open ↔ 父级 open） */
const innerOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

/** 确认描述：嵌入会话名（引号强调被删对象） */
const confirmDescription = computed(
  () => `确定删除 "${props.sessionLabel}"？此操作不可撤销。`,
)

function onConfirm(): void {
  emit('confirm', props.sessionId)
  emit('update:open', false)
}
</script>
