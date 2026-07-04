<template>
  <!--
    展示组件 · Fork 确认弹窗（问题 6：AI 收尾 fork → clone+fork 新 session 到另一 panel）。
    确认后由父组件调 useSidebar.forkSession。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[380px]">
      <DialogHeader>
        <DialogTitle>克隆并分叉会话</DialogTitle>
        <DialogDescription>
          将创建一个新会话，复制到该回复为止的对话历史，并在另一个面板打开。当前会话不受影响。
        </DialogDescription>
      </DialogHeader>

      <div class="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="emit('update:open', false)">取消</Button>
        <Button variant="default" size="sm" @click="onConfirm">克隆并分叉</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
}>()

function onConfirm(): void {
  // 父组件 fork 完成后通过 v-model:open=false 关闭弹窗
  emit('confirm')
}
</script>
