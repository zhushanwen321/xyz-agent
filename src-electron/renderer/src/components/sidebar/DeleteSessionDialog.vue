<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>删除会话</DialogTitle>
        <DialogDescription>
          确定删除 <span class="font-medium text-fg">"{{ sessionLabel }}"</span>？此操作不可撤销。
        </DialogDescription>
      </DialogHeader>

      <div class="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="emit('update:open', false)">
          取消
        </Button>
        <Button variant="danger" size="sm" @click="onConfirm">
          删除
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  open: boolean
  sessionId: string
  sessionLabel: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: [sessionId: string]
}>()

function onConfirm(): void {
  emit('confirm', props.sessionId)
  emit('update:open', false)
}
</script>
