<script setup lang="ts">
interface Skill {
  name: string
  description: string
  enabled: boolean
}

defineProps<{
  skills: Skill[]
}>()

defineEmits<{
  toggle: [name: string]
}>()
</script>

<template>
  <div class="settings-section">
    <div class="settings-section__title">已加载的 SKILL</div>
    <div v-for="skill in skills" :key="skill.name" class="skill-row">
      <span class="skill-row__name">{{ skill.name }}</span>
      <span class="skill-row__desc">{{ skill.description }}</span>
      <div :class="['skill-row__toggle', { on: skill.enabled }]" @click="$emit('toggle', skill.name)"></div>
    </div>
    <div v-if="skills.length === 0" class="settings-section__empty">暂无已加载的 SKILL</div>
  </div>
</template>

<style scoped>
.settings-section__empty {
  padding: 24px 0;
  text-align: center;
  color: var(--muted);
  font-size: var(--font-sm, 0.875rem);
}
</style>
