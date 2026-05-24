<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input } from '../../design-system'
import type { ScannedSkillInfo, ScannedAgentInfo } from '@xyz-agent/shared'

export interface SourceOption {
  id: string
  icon: string
  label: string
  path: string
  defaultActive?: boolean
}

const props = defineProps<{
  sources: SourceOption[]
  scanEventType: string
  scannedEventType: string
  existingItems: Array<{ id: string; name: string }>
  isScanning: boolean
  scannedResults: ScannedSkillInfo[] | ScannedAgentInfo[]
}>()

const emit = defineEmits<{
  scan: [sources: string[]]
  import: [selectedItems: ScannedSkillInfo[] | ScannedAgentInfo[]]
}>()

const activeSources = ref<Set<string>>(
  new Set(props.sources.filter(s => s.defaultActive).map(s => s.id)),
)

const customPaths = ref<Array<{ id: string; icon: string; label: string; path: string }>>([])
const customPathInput = ref('')

const selectedItems = ref<Set<string>>(new Set())

const allSourcePaths = computed(() => {
  const paths: string[] = []
  for (const s of props.sources) {
    if (activeSources.value.has(s.id)) paths.push(s.path)
  }
  for (const c of customPaths.value) {
    if (activeSources.value.has(c.id)) paths.push(c.path)
  }
  return paths
})

const activeCount = computed(() => activeSources.value.size)

function toggleSource(id: string) {
  if (activeSources.value.has(id)) {
    activeSources.value.delete(id)
  } else {
    activeSources.value.add(id)
  }
}

function addCustomPath() {
  const path = customPathInput.value.trim()
  if (!path) return
  const id = `custom-${Date.now()}`
  customPaths.value.push({
    id,
    icon: 'C',
    label: path.split('/').filter(Boolean).pop() ?? 'Custom',
    path,
  })
  activeSources.value.add(id)
  customPathInput.value = ''
}

function handleScan() {
  emit('scan', allSourcePaths.value)
}

function toggleSelect(id: string) {
  if (selectedItems.value.has(id)) {
    selectedItems.value.delete(id)
  } else {
    selectedItems.value.add(id)
  }
}

const importableItems = computed(() =>
  (props.scannedResults as Array<ScannedSkillInfo | ScannedAgentInfo>).filter(i => !i.alreadyImported),
)

const allImportableSelected = computed(() =>
  importableItems.value.length > 0 && importableItems.value.every(i => selectedItems.value.has(i.id)),
)

function toggleSelectAll() {
  if (allImportableSelected.value) {
    for (const item of importableItems.value) {
      selectedItems.value.delete(item.id)
    }
  } else {
    for (const item of importableItems.value) {
      selectedItems.value.add(item.id)
    }
  }
}

const selectedImportCount = computed(() => {
  let count = 0
  for (const id of selectedItems.value) {
    const item = (props.scannedResults as Array<ScannedSkillInfo | ScannedAgentInfo>).find(i => i.id === id)
    if (item && !item.alreadyImported) count++
  }
  return count
})

function handleImport() {
  const selected = (props.scannedResults as Array<ScannedSkillInfo | ScannedAgentInfo>).filter(
    i => selectedItems.value.has(i.id) && !i.alreadyImported,
  )
  if (selected.length === 0) return
  emit('import', selected)
  selectedItems.value.clear()
}

const { t } = useI18n()

const sourceTypeLabels = computed<Record<string, string>>(() => ({
  pi: 'Pi',
  claude: 'Claude',
  agents: t('settings.sourceTypeAgents'),
  custom: t('settings.sourceTypeCustom'),
}))
</script>

<template>
  <div class="border border-border rounded-sm overflow-hidden mb-3">
    <div class="flex items-center py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
      <span class="text-[13px] font-semibold">{{ t('settings.scanAndImport') }}</span>
    </div>

    <!-- Source chips -->
    <div class="flex flex-wrap gap-2 px-4 pt-3 pb-1.5">
      <div
        v-for="src in sources"
        :key="src.id"
        :class="[
          'flex items-center gap-2 py-1.5 px-3 border rounded-sm text-xs cursor-pointer transition-all duration-120 select-none',
          activeSources.has(src.id)
            ? 'border-[var(--accent)] bg-[var(--accent-light)] text-[var(--accent)] font-medium'
            : 'border-border bg-surface hover:border-[oklch(80%_0.01_70)] hover:bg-[var(--hover-bg)]',
        ]"
        @click="toggleSource(src.id)"
      >
        <span
          :class="[
            'w-[22px] h-[22px] rounded-sm text-[10px] font-bold flex items-center justify-center shrink-0 transition-colors duration-120',
            activeSources.has(src.id)
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--accent-light)] text-[var(--accent)]',
          ]"
        >{{ src.icon }}</span>
        <div class="min-w-0">
          <div class="font-medium leading-tight">{{ src.label }}</div>
          <div :class="['font-mono text-[10px] whitespace-normal', activeSources.has(src.id) ? 'text-[oklch(60%_0.05_28)]' : 'text-muted']">{{ src.path }}</div>
        </div>
      </div>

      <!-- Custom paths -->
      <div
        v-for="src in customPaths"
        :key="src.id"
        :class="[
          'flex items-center gap-2 py-1.5 px-3 border rounded-sm text-xs cursor-pointer transition-all duration-120 select-none',
          activeSources.has(src.id)
            ? 'border-[var(--accent)] bg-[var(--accent-light)] text-[var(--accent)] font-medium'
            : 'border-border bg-surface hover:border-[oklch(80%_0.01_70)] hover:bg-[var(--hover-bg)]',
        ]"
        @click="toggleSource(src.id)"
      >
        <span
          :class="[
            'w-[22px] h-[22px] rounded-sm text-[10px] font-bold flex items-center justify-center shrink-0',
            activeSources.has(src.id)
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--accent-light)] text-[var(--accent)]',
          ]"
        >{{ src.icon }}</span>
        <div class="min-w-0">
          <div class="font-medium leading-tight">{{ src.label }}</div>
          <div class="font-mono text-[10px] text-muted whitespace-normal">{{ src.path }}</div>
        </div>
      </div>
    </div>

    <!-- Custom path input -->
    <div class="flex gap-1.5 px-4 py-1.5 items-center">
      <Input
        v-model="customPathInput"
        :placeholder="t('settings.customPathPlaceholder')"
        class="flex-1 font-mono text-[11px]"
        @keydown.enter="addCustomPath"
      />
      <Button variant="outline" size="sm" @click="addCustomPath">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 1v10M1 6h10" />
        </svg>
        {{ t('common.create') }}
      </Button>
    </div>

    <!-- Scan action bar -->
    <div class="flex items-center justify-between px-4 py-1 pb-3">
      <div class="text-[11px] text-muted flex items-center gap-1.5">
        <template v-if="isScanning">
          <span class="w-3.5 h-3.5 border-2 border-border border-t-[var(--accent)] rounded-full animate-spin shrink-0" />
          {{ t('settings.scanning') }}
        </template>
        <template v-else>{{ t('settings.selectedSources', { n: activeCount }) }}</template>
      </div>
      <Button variant="outline" size="sm" :disabled="isScanning || activeCount === 0" @click="handleScan">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="7" cy="7" r="3.5" />
          <path d="M7 5v4.5M7 10.5v.5" />
        </svg>
        {{ t('settings.scan') }}
      </Button>
    </div>

    <!-- Scan results -->
    <div v-if="scannedResults.length > 0" class="border-t border-border animate-[fadeIn_200ms_ease-out]">
      <!-- Select all row -->
      <div
        v-if="importableItems.length > 0"
        class="flex items-center gap-2.5 py-[7px] px-4 text-xs border-b border-[var(--divider)] bg-[var(--hover-bg)] select-none"
      >
        <div
          :class="[
            'w-4 h-4 rounded-sm border-[1.5px] flex items-center justify-center shrink-0 transition-all duration-120 cursor-pointer',
            allImportableSelected
              ? 'bg-[var(--accent)] border-[var(--accent)]'
              : 'border-border bg-surface',
          ]"
          @click="toggleSelectAll"
        >
          <template v-if="allImportableSelected">
            <svg width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="white" stroke-width="2">
              <path d="M1 2.5l2 2 4-4" />
            </svg>
          </template>
        </div>
        <span class="text-muted text-[11px]">{{ t('settings.selectAll') }}</span>
      </div>
      <div
        v-for="item in scannedResults"
        :key="item.id"
        :class="[
          'flex items-center gap-2.5 py-2 px-4 text-xs border-b border-[var(--divider)] last:border-b-0 transition-colors duration-120',
          item.alreadyImported ? 'opacity-40' : 'hover:bg-[var(--hover-bg)]',
        ]"
      >
        <!-- Checkbox -->
        <div
          :class="[
            'w-4 h-4 rounded-sm border-[1.5px] flex items-center justify-center shrink-0 transition-all duration-120',
            item.alreadyImported
              ? 'opacity-40 cursor-not-allowed border-border'
              : selectedItems.has(item.id)
                ? 'bg-[var(--accent)] border-[var(--accent)] cursor-pointer'
                : 'border-border cursor-pointer bg-surface',
          ]"
          @click="!item.alreadyImported && toggleSelect(item.id)"
        >
          <template v-if="selectedItems.has(item.id) && !item.alreadyImported">
            <svg width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="white" stroke-width="2">
              <path d="M1 2.5l2 2 4-4" />
            </svg>
          </template>
        </div>

        <!-- Info -->
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-xs flex items-center gap-1.5">
            {{ item.name }}
            <span class="text-[9px] py-[1px] px-[5px] rounded-sm bg-[var(--section-bg)] text-muted font-medium">{{ sourceTypeLabels[item.sourceType] ?? item.sourceType }}</span>
          </div>
          <div class="text-[11px] text-muted truncate">{{ item.description }}</div>
        </div>

        <!-- Imported badge -->
        <span v-if="item.alreadyImported" class="text-[9px] py-[1px] px-[5px] rounded-sm bg-[var(--success-light)] text-[var(--success)] font-semibold shrink-0">{{ t('settings.imported') }}</span>
      </div>

      <!-- Import action bar -->
      <div v-if="importableItems.length > 0" class="flex items-center justify-end py-2 px-4 gap-2.5 border-t border-border bg-[var(--section-bg)]">
        <span class="text-[11px] text-muted">{{ t('settings.selectedCount', { n: selectedImportCount }) }}</span>
        <Button variant="primary" size="sm" :disabled="selectedImportCount === 0" @click="handleImport">
          {{ t('settings.importSelected') }}
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 6h10M7 2l4 4-4 4" />
          </svg>
        </Button>
      </div>
    </div>
  </div>
</template>
