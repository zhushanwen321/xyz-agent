<script setup lang="ts">
import { ref } from 'vue'
import { Button, Input } from '../../design-system'

const sources = ref([
  { id: 'pi', icon: 'P', label: 'Pi Skills', path: '~/.pi/agent/skills/', active: true },
  { id: 'claude', icon: 'C', label: 'Claude Code', path: '~/.claude/skills/', active: false },
  { id: 'agents', icon: 'A', label: 'Agents', path: '~/.agents/skills/', active: false },
])
</script>

<template>
  <div class="import-section">
    <div class="import-section__title">导入 Skill</div>
    <div class="import-paths">
      <div
        v-for="src in sources"
        :key="src.id"
        :class="['import-path', { active: src.active }]"
        @click="src.active = !src.active"
      >
        <span :class="['import-path__icon', `import-path__icon--${src.id}`]">{{ src.icon }}</span>
        <span>
          <span class="import-path__label">{{ src.label }}</span><br>
          <span class="import-path__path">{{ src.path }}</span>
        </span>
      </div>
    </div>
    <div class="custom-path">
      <Input class="custom-path__input" placeholder="自定义路径，如 ~/my-project/.skills/" />
      <Button variant="ghost" size="sm">扫描</Button>
    </div>
  </div>
</template>

<style scoped>
.import-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 24px;
}

.import-section__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}

.import-paths {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.import-path {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s var(--ease);
  font-size: 13px;
  user-select: none;
}

.import-path:hover {
  border-color: var(--accent);
  background: var(--accent-light);
}

.import-path.active {
  border-color: var(--accent);
  background: var(--accent-light);
  color: var(--accent);
}

.import-path__icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}

.import-path__icon--pi {
  background: var(--accent);
}

.import-path__icon--claude {
  background: oklch(60% 0.15 280);
}

.import-path__icon--agents {
  background: var(--success);
}

.import-path__label {
  font-weight: 500;
}

.import-path__path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}

.custom-path {
  display: flex;
  gap: 8px;
  align-items: center;
}

.custom-path__input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s var(--ease);
}

.custom-path__input:focus {
  border-color: var(--accent);
}

.custom-path__input::placeholder {
  color: var(--muted);
}
</style>
