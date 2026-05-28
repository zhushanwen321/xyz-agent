<script setup lang="ts">
import { ref, watch } from 'vue'
import { Dialog, Button, Toggle } from '../../design-system'

interface Props {
  pluginId: string
  pluginName: string
  requestedPermissions: string[]
  visible: boolean
}

const props = withDefaults(defineProps<Props>(), {
  pluginId: '',
  pluginName: '',
  requestedPermissions: () => [],
  visible: false,
})

const emit = defineEmits<{
  confirm: [permissions: string[]]
  cancel: []
}>()

const selectedPermissions = ref<Set<string>>(new Set())

watch(() => props.visible, (open) => {
  if (open) {
    selectedPermissions.value = new Set(props.requestedPermissions)
  }
})

function togglePermission(perm: string) {
  const next = new Set(selectedPermissions.value)
  if (next.has(perm)) {
    next.delete(perm)
  } else {
    next.add(perm)
  }
  selectedPermissions.value = next
}

function handleConfirm() {
  emit('confirm', Array.from(selectedPermissions.value))
}

function handleCancel() {
  emit('cancel')
}
</script>

<template>
  <Dialog
    :open="visible"
    :title="`${pluginName} — 权限请求`"
    @update:open="handleCancel"
  >
    <p class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
      插件 "{{ pluginName }}" 请求以下权限。您可以选择批准或拒绝每一项。
    </p>

    <div class="flex flex-col gap-1.5 mb-5">
      <div
        v-for="perm in requestedPermissions"
        :key="perm"
        class="flex items-center justify-between px-3 py-2 rounded-sm border text-sm"
        :style="{
          borderColor: selectedPermissions.has(perm) ? 'var(--accent)' : 'var(--border)',
          background: selectedPermissions.has(perm) ? 'var(--accent-light)' : 'transparent',
        }"
      >
        <span style="color: var(--fg)">{{ perm }}</span>
        <Toggle
          :checked="selectedPermissions.has(perm)"
          @update:checked="togglePermission(perm)"
        />
      </div>
    </div>

    <div class="flex justify-end gap-2">
      <Button variant="outline" size="sm" @click="handleCancel">拒绝</Button>
      <Button variant="primary" size="sm" @click="handleConfirm">批准选中</Button>
    </div>
  </Dialog>
</template>
