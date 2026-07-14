<template>
  <!--
    展示组件 · Fork 确认弹窗（问题 6：AI 收尾 fork → clone+fork 新 session 到另一 panel）。
    确认后由父组件调 useSidebar.forkSession。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[380px]">
      <DialogHeader>
        <DialogTitle>{{ t('panel.forkConfirm.title') }}</DialogTitle>
        <DialogDescription>
          {{ t('panel.forkConfirm.desc') }}
        </DialogDescription>
      </DialogHeader>

      <div class="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="emit('update:open', false)">{{ t('panel.forkConfirm.cancel') }}</Button>
        <Button variant="default" size="sm" @click="onConfirm">{{ t('panel.forkConfirm.confirm') }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const { t } = useI18n()

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
