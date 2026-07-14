<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>{{ t('sidebar.renameDialog.title') }}</DialogTitle>
        <DialogDescription>{{ t('sidebar.renameDialog.desc') }}</DialogDescription>
      </DialogHeader>

      <form class="mt-2 space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="label">
          <FormItem>
            <FormLabel>{{ t('sidebar.renameDialog.nameLabel') }}</FormLabel>
            <FormControl>
              <Input
                v-bind="componentField"
                ref="inputRef"
                :placeholder="t('sidebar.renameDialog.namePlaceholder')"
                autocomplete="off"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" @click="onCancel">
            {{ t('sidebar.renameDialog.cancel') }}
          </Button>
          <Button type="submit" size="sm">
            {{ t('sidebar.renameDialog.confirm') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
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

const schema = computed(() => toTypedSchema(
  z.object({
    label: z.string()
      .min(1, t('sidebar.renameDialog.validationRequired'))
      .max(MAX_LABEL_LENGTH, t('sidebar.renameDialog.validationMaxLength', { max: MAX_LABEL_LENGTH }))
      .regex(/^[a-zA-Z0-9\u4e00-\u9fa5_\- ]+$/, t('sidebar.renameDialog.validationPattern')),
  }),
))

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
