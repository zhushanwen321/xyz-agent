<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>重命名会话</DialogTitle>
        <DialogDescription>修改会话的显示名称</DialogDescription>
      </DialogHeader>

      <form class="mt-2 space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="label">
          <FormItem>
            <FormLabel>名称</FormLabel>
            <FormControl>
              <Input
                v-bind="componentField"
                ref="inputRef"
                placeholder="输入会话名称"
                autocomplete="off"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" @click="onCancel">
            取消
          </Button>
          <Button type="submit" size="sm">
            确认
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { useSessionStore } from '@/stores/session'

const props = defineProps<{
  open: boolean
  sessionId: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: [payload: { sessionId: string; label: string }]
}>()

const session = useSessionStore()
const inputRef = ref<InstanceType<typeof Input> | null>(null)

const MAX_LABEL_LENGTH = 60

const schema = toTypedSchema(
  z.object({
    label: z.string()
      .min(1, '请输入名称')
      .max(MAX_LABEL_LENGTH, `名称不能超过 ${MAX_LABEL_LENGTH} 个字符`)
      .regex(/^[a-zA-Z0-9\u4e00-\u9fa5_\- ]+$/, '仅允许中文、英文、数字、空格、横线和下划线'),
  }),
)

const { handleSubmit, resetForm } = useForm({
  validationSchema: schema,
})

function currentLabel(): string {
  return session.list.find((s) => s.id === props.sessionId)?.label ?? ''
}

function focusInput(): void {
  nextTick(() => {
    const el = inputRef.value?.$el as HTMLInputElement | undefined
    el?.focus()
    el?.select()
  })
}

function onOpenChange(value: boolean): void {
  emit('update:open', value)
  if (value) {
    resetForm({ values: { label: currentLabel() } })
    focusInput()
  }
}

function onCancel(): void {
  emit('update:open', false)
}

const onSubmit = handleSubmit((values) => {
  emit('confirm', { sessionId: props.sessionId, label: values.label.trim() })
  emit('update:open', false)
})

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetForm({ values: { label: currentLabel() } })
      focusInput()
    }
  },
  { immediate: true },
)
</script>
