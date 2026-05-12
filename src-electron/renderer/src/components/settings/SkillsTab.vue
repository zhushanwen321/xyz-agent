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
  <div class="mb-7">
    <div class="text-[13px] font-semibold uppercase tracking-[0.04em] text-muted mb-3">已加载的 SKILL</div>
    <div v-for="skill in skills" :key="skill.name" class="flex items-center gap-3 py-2.5 px-3.5 bg-surface border border-border rounded-sm mb-1.5">
      <span class="font-semibold text-[13px] flex-1">{{ skill.name }}</span>
      <span class="text-xs text-muted flex-[2]">{{ skill.description }}</span>
      <div
        :class="['relative w-9 h-5 rounded-full cursor-pointer shrink-0 transition-[background] duration-200 ease-ease', skill.enabled ? 'bg-accent' : 'bg-border']"
        tabindex="0"
        role="switch"
        :aria-checked="skill.enabled"
        @click="$emit('toggle', skill.name)"
        @keydown.enter="$emit('toggle', skill.name)"
      >
        <span
          class="absolute top-[2px] w-4 h-4 rounded-full bg-white transition-[transform] duration-200 ease-ease"
          :class="skill.enabled ? 'translate-x-4' : 'left-[2px]'"
        />
      </div>
    </div>
    <div v-if="skills.length === 0" class="py-6 text-center text-muted text-sm">暂无已加载的 SKILL</div>
  </div>
</template>

