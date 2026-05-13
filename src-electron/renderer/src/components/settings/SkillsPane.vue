<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProviderStore } from '../../stores/provider'
import { Button } from '../../design-system'
import type { ScannedSkillInfo, SkillInfo } from '@xyz-agent/shared'
import ScanImportSection from './ScanImportSection.vue'
import SkillSection from './SkillSection.vue'
import SkillModal from './SkillModal.vue'

const { t } = useI18n()

const providerStore = useProviderStore()
const skills = computed(() => providerStore.skills)
const showModal = ref(false)
const editingSkill = ref<SkillInfo | null>(null)

const scanSources = [
  { id: 'pi', icon: 'P', label: 'Pi Skills', path: '~/.pi/agent/skills/', defaultActive: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/skills/', defaultActive: false },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/skills/', defaultActive: false },
]

function handleScan(sources: string[]) {
  providerStore.scanSkillsAction(sources)
}

function handleImport(items: ScannedSkillInfo[]) {
  providerStore.importSkills(items)
}

function handleSkillSave(data: { name: string; description: string; content: string }) {
  if (editingSkill.value) {
    providerStore.setSkill({
      ...editingSkill.value,
      name: data.name,
      description: data.description,
      content: data.content,
    })
  } else {
    providerStore.setSkill({
      id: `skill-${Date.now()}`,
      name: data.name,
      description: data.description,
      enabled: true,
      source: 'manual',
      triggers: [],
      content: data.content,
    })
  }
  showModal.value = false
  editingSkill.value = null
}

function openEditModal(skill: SkillInfo) {
  editingSkill.value = skill
  showModal.value = true
}

function openAddModal() {
  editingSkill.value = null
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  editingSkill.value = null
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div>
        <div class="font-display text-[22px] font-bold tracking-tight">{{ t('settings.skillConfig') }}</div>
        <div class="text-[12px] text-muted mt-1">{{ t('settings.skillConfigDesc') }}</div>
      </div>
      <Button variant="primary" @click="openAddModal">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        {{ t('settings.manualAdd') }}
      </Button>
    </div>

    <ScanImportSection
      :sources="scanSources"
      scan-event-type="config.scanSkills"
      scanned-event-type="config.scannedSkills"
      :existing-items="skills.map(s => ({ id: s.id, name: s.name }))"
      :is-scanning="providerStore.isScanningSkills"
      :scanned-results="providerStore.scannedSkills"
      @scan="handleScan"
      @import="handleImport"
    />

    <!-- Imported list -->
    <div v-if="skills.length > 0" class="border border-border rounded-lg overflow-hidden mb-3">
      <div class="flex items-center justify-between py-[10px] px-4 bg-[var(--section-bg)] border-b border-border min-h-[42px]">
        <span class="text-[13px] font-semibold">{{ t('settings.imported') }}</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ skills.length }}</span>
      </div>
      <div>
        <SkillSection
          v-for="skill in skills"
          :key="skill.id"
          :skill="skill"
          @toggle-enabled="providerStore.toggleSkill(skill.id)"
          @edit="openEditModal(skill)"
          @delete="providerStore.deleteSkillAction(skill.id)"
        />
      </div>
    </div>

    <SkillModal :visible="showModal" :skill="editingSkill" @close="closeModal" @save="handleSkillSave" />
  </div>
</template>
