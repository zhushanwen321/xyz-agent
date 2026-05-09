<script setup lang="ts">
import ImportSection, { type ImportSource } from './shared/ImportSection.vue'

const sources: ImportSource[] = [
  { id: 'pi', icon: 'P', label: 'Pi Skills', path: '~/.pi/agent/skills/', active: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/skills/', active: false },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/skills/', active: false },
]
</script>

<template>
  <ImportSection
    title="导入 Skill"
    :sources="sources"
    custom-placeholder="自定义路径，如 ~/my-project/.skills/"
  />
</template>
