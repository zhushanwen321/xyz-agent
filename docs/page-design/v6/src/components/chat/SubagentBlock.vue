<script setup lang="ts">
/** SubagentBlock · 子代理块（v6 spec-blocks §10）
 *  - collapsed only：Bot icon 14px + 「subagent」prefix + name·slug + (model·thinking)
 *  - running：双环 loader；failed：icon+agent 降 neutral-mid */
import { computed } from 'vue'
import { drawerOpen, drawerTab } from '@/composables/useStore'

function openDrawer() {
  drawerTab.value = 'subagent'
  drawerOpen.value = true
}

const props = defineProps<{ data: Record<string, unknown> }>()
const name = computed(() => (props.data.name as string) || '')
const slug = computed(() => (props.data.slug as string) || '')
const model = computed(() => (props.data.model as string) || '')
const thinking = computed(() => (props.data.thinking as string) || '')
const state = computed(() => props.data.state as string | undefined)
const running = computed(() => state.value === 'running')
const failed = computed(() => state.value === 'failed')
const dim = computed(() => failed.value)
</script>

<template>
  <div class="sa">
    <div class="sa-hd" @click="openDrawer">
      <svg v-if="running" class="sa-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" opacity="0.35"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>
      <svg v-else class="sa-ico" :class="{ dim }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
      <span class="sa-prefix" :class="{ dim }">subagent</span>
      <span class="sa-agent" :class="{ dim }">{{ name }}</span>
      <template v-if="slug">
        <span class="sa-sep">·</span>
        <span class="sa-slug" :class="{ dim }">{{ slug }}</span>
      </template>
      <span v-if="model" class="sa-model">({{ model }}<span v-if="thinking" class="think-x"> · thinking {{ thinking }}</span>)</span>
    </div>
  </div>
</template>

<style scoped>
.sa { padding: 10px 0 8px; transition: opacity var(--duration-fast); }
.sa:hover { opacity: 0.8; }
.sa-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--text-base);
  font-weight: 500;
  cursor: pointer;
}
.sa-ico, .sa-loader {
  width: 14px;
  height: 14px;
  color: var(--neutral-ico);
  flex-shrink: 0;
}
.sa-loader { color: var(--accent); animation: spin 1.4s linear infinite; }
.sa-ico.dim { color: var(--neutral-mid); }
.sa-prefix {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--neutral-fg);
  letter-spacing: 0.04em;
}
.sa-prefix.dim { color: var(--neutral-mid); }
.sa-agent, .sa-slug {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--accent);
}
.sa-agent.dim, .sa-slug.dim { color: var(--neutral-mid); }
.sa-sep { color: var(--neutral-faint); font-size: var(--text-sm); }
.sa-model {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
.think-x { color: var(--neutral-dim); }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
