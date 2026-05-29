<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { Dialog, Button, Toggle } from '../../design-system'

// ── Permission metadata ────────────────────────────────────────

interface PermissionMeta {
  label: string
  risk: 'low' | 'medium' | 'high'
}

const PERMISSION_DESCRIPTIONS: Record<string, PermissionMeta> = {
  'fs.read': { label: 'Read file system', risk: 'low' },
  'fs.write': { label: 'Write file system', risk: 'medium' },
  'network.request': { label: 'Send network requests', risk: 'medium' },
  'clipboard.read': { label: 'Read clipboard', risk: 'medium' },
  'clipboard.write': { label: 'Write clipboard', risk: 'low' },
  'shell.execute': { label: 'Execute shell commands', risk: 'high' },
  'env.read': { label: 'Read environment variables', risk: 'low' },
  'process.spawn': { label: 'Spawn child processes', risk: 'high' },
  'system.info': { label: 'Access system information', risk: 'low' },
}

function getPermissionMeta(perm: string): PermissionMeta {
  return PERMISSION_DESCRIPTIONS[perm] ?? { label: perm, risk: 'medium' as const }
}

function riskColor(risk: PermissionMeta['risk']): string {
  switch (risk) {
    case 'high': return 'var(--danger)'
    case 'medium': return 'var(--warning)'
    case 'low': return 'var(--accent)'
  }
}

function riskBg(risk: PermissionMeta['risk']): string {
  switch (risk) {
    case 'high': return 'var(--danger-light)'
    case 'medium': return 'var(--warning-light)'
    case 'low': return 'var(--accent-light)'
  }
}

// ── Props & Emits ──────────────────────────────────────────────

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

// ── Selection state ────────────────────────────────────────────

const selectedPermissions = ref<Set<string>>(new Set())

// Reset selection when dialog opens with new permissions
watch(() => props.visible, (open) => {
  if (open) {
    selectedPermissions.value = new Set(props.requestedPermissions)
  }
})

const allSelected = computed(() =>
  props.requestedPermissions.length > 0
  && selectedPermissions.value.size === props.requestedPermissions.length,
)

function isSelected(perm: string): boolean {
  return selectedPermissions.value.has(perm)
}

function togglePermission(perm: string) {
  const next = new Set(selectedPermissions.value)
  if (next.has(perm)) {
    next.delete(perm)
  } else {
    next.add(perm)
  }
  selectedPermissions.value = next
}

function selectAll() {
  selectedPermissions.value = new Set(props.requestedPermissions)
}

function selectNone() {
  selectedPermissions.value = new Set()
}

// ── Actions ────────────────────────────────────────────────────

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
    :title="`${pluginName} — Permission Request`"
    @update:open="handleCancel"
  >
    <p class="text-sm leading-relaxed mb-4" style="color: var(--muted)">
      Plugin "{{ pluginName }}" requests the following permissions. You can approve or deny each item.
    </p>

    <!-- Batch actions -->
    <div class="flex items-center gap-2 mb-3">
      <Button variant="ghost" size="sm" :disabled="allSelected" @click="selectAll">Select All</Button>
      <Button variant="ghost" size="sm" :disabled="selectedPermissions.size === 0" @click="selectNone">Deselect All</Button>
    </div>

    <!-- Permission list -->
    <div class="flex flex-col gap-1.5 mb-5">
      <div
        v-for="perm in requestedPermissions"
        :key="perm"
        class="flex items-center justify-between px-3 py-2 rounded-sm border text-sm"
        :style="{
          borderColor: isSelected(perm) ? riskColor(getPermissionMeta(perm).risk) : 'var(--border)',
          background: isSelected(perm) ? riskBg(getPermissionMeta(perm).risk) : 'transparent',
        }"
      >
        <div class="flex items-center gap-2 min-w-0">
          <!-- High-risk warning icon -->
          <svg
            v-if="getPermissionMeta(perm).risk === 'high'"
            class="shrink-0"
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2"
            style="color: var(--danger)"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div class="min-w-0">
            <div class="font-medium text-[var(--fg)] truncate">{{ getPermissionMeta(perm).label }}</div>
            <div class="text-[10px] text-muted font-mono">{{ perm }}</div>
          </div>
        </div>
        <Toggle
          :checked="isSelected(perm)"
          @update:checked="togglePermission(perm)"
        />
      </div>
    </div>

    <!-- Action buttons -->
    <div class="flex justify-end gap-2">
      <Button variant="outline" size="sm" @click="handleCancel">Deny All</Button>
      <Button variant="primary" size="sm" :disabled="selectedPermissions.size === 0" @click="handleConfirm">
        Approve ({{ selectedPermissions.size }})
      </Button>
    </div>
  </Dialog>
</template>
