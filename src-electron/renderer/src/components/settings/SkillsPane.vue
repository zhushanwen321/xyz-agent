<script setup lang="ts">
import { computed } from 'vue'
import { useProviderStore } from '../../stores/provider'
import { Button } from '../../design-system'
import type { ScannedSkillInfo } from '@xyz-agent/shared'
import ScanImportSection from './ScanImportSection.vue'
import SkillSection from './SkillSection.vue'
import SkillModal from './SkillModal.vue'
import { ref } from 'vue'

const providerStore = useProviderStore()
const skills = computed(() => providerStore.skills)
const showModal = ref(false)

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

function handleSkillSave(data: { name: string; description: string; triggers: string[]; sourcePath: string }) {
  providerStore.setSkill({
    id: `skill-${Date.now()}`,
    name: data.name,
    description: data.description,
    enabled: true,
    source: 'manual',
    triggers: data.triggers,
    sourcePath: data.sourcePath || undefined,
  })
  showModal.value = false
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div>
        <div class="font-display text-[22px] font-bold tracking-tight">Skill 配置</div>
        <div class="text-[12px] text-muted mt-1">扫描、导入和管理 AI 技能模块</div>
      </div>
      <Button variant="primary" @click="showModal = true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        手动添加
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
        <span class="text-[13px] font-semibold">已导入</span>
        <span class="text-[10px] text-muted font-medium bg-[var(--hover-bg)] py-[2px] px-[6px] rounded-sm">{{ skills.length }}</span>
      </div>
      <div>
        <SkillSection
          v-for="skill in skills"
          :key="skill.id"
          :skill="skill"
          @toggle-enabled="providerStore.toggleSkill(skill.id)"
          @delete="providerStore.deleteSkillAction(skill.id)"
        />
      </div>
    </div>

    <SkillModal :visible="showModal" @close="showModal = false" @save="handleSkillSave" />
  </div>
</template>
