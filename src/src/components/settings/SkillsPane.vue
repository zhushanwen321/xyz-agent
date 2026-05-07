<script setup lang="ts">
import { ref } from 'vue'
import { mockSkills } from '../../mock/data'
import SkillImportSection from './SkillImportSection.vue'
import SkillCard from './SkillCard.vue'

const skills = ref([...mockSkills])
const expandedId = ref<string | null>(null)
</script>

<template>
  <div class="skills-pane">
    <div class="page__hd">
      <div class="page__title">Skill 配置</div>
    </div>

    <SkillImportSection />

    <div class="section-divider">已导入 · {{ skills.length }} 个 Skill</div>

    <SkillCard
      v-for="skill in skills"
      :key="skill.name"
      :skill="skill"
      :expanded="expandedId === skill.name"
      @toggle="expandedId = expandedId === skill.name ? null : skill.name"
      @toggle-enabled="skill.enabled = !skill.enabled"
    />
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
</style>
