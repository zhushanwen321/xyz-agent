<script setup lang="ts">
import { ref, computed } from 'vue'
import { useProviderStore } from '../../stores/provider'
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
  <div class="skills-pane">
    <div class="page__hd">
      <div class="page__title">Skill 配置</div>
      <button class="btn btn--primary" @click="showModal = true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 1v12M1 7h12" />
        </svg>
        添加 Skill
      </button>
    </div>

    <SkillImportSection />

    <div class="section-divider">已导入 · {{ skills.length }} 个 Skill</div>

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

<style scoped>
.skills-pane {
  max-width: 860px;
  padding: 32px 40px;
}

.page__hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
}

.page__title {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.section-divider {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 20px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.2s var(--ease);
  white-space: nowrap;
}

.btn:hover {
  background: var(--accent-light);
  color: var(--accent);
  border-color: var(--accent);
}

.btn--primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn--primary:hover {
  opacity: 0.88;
}
</style>
