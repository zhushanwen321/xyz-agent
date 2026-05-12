<script setup lang="ts">
import { ref, computed } from 'vue'
import { useProviderStore } from '../../stores/provider'
import { Button } from '../../design-system'
import type { SkillInfo } from '@xyz-agent/shared'
import SkillImportSection from './SkillImportSection.vue'
import SkillCard from './SkillCard.vue'
import SkillModal from './SkillModal.vue'

const providerStore = useProviderStore()
const skills = computed(() => providerStore.skills)
const expandedId = ref<string | null>(null)
const showModal = ref(false)

function handleSkillSave(data: { name: string; description: string; triggers: string[]; sourcePath: string }) {
  const newSkill: SkillInfo = {
    id: `skill-${Date.now()}`,
    name: data.name,
    description: data.description,
    enabled: true,
    source: 'manual',
    triggers: data.triggers,
    sourcePath: data.sourcePath || undefined,
  }
  providerStore.setSkills([...providerStore.skills, newSkill])
  showModal.value = false
}
</script>

<template>
  <div class="max-w-[860px] mx-auto py-8 px-10">
    <div class="flex items-center justify-between mb-7">
      <div class="font-display text-[22px] font-bold tracking-tight">Skill 配置</div>
      <Button variant="primary" size="sm" @click="showModal = true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        添加 Skill
      </Button>
    </div>

    <SkillImportSection />

    <div class="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted my-5 pb-1.5 border-b border-border">已导入 · {{ skills.length }} 个 Skill</div>

    <SkillCard
      v-for="skill in skills"
      :key="skill.name"
      :skill="skill"
      :expanded="expandedId === skill.name"
      @toggle="expandedId = expandedId === skill.name ? null : skill.name"
      @toggle-enabled="providerStore.setSkills(skills.map(s => s.id === skill.id ? { ...s, enabled: !s.enabled } : s))"
    />

    <SkillModal :visible="showModal" @close="showModal = false" @save="handleSkillSave" />
  </div>
</template>


