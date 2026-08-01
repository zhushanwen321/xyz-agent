<script setup lang="ts">
/** WorkflowBlock · 工作流块（v6 spec-blocks §11）
 *  - collapsed only：Workflow icon 14px + 「workflow」prefix + name·slug
 *  - running：双环 loader；failed：icon+name 降 neutral-mid */
import { computed } from 'vue'
import { drawerOpen, drawerTab } from '@/composables/useStore'

function openDrawer() {
  drawerTab.value = 'workflow'
  drawerOpen.value = true
}

const props = defineProps<{ data: Record<string, unknown> }>()
const name = computed(() => (props.data.name as string) || '')
const slug = computed(() => (props.data.slug as string) || '')
const state = computed(() => props.data.state as string | undefined)
const running = computed(() => state.value === 'running')
const failed = computed(() => state.value === 'failed')
const dim = computed(() => failed.value)
</script>

<template>
  <div class="wf">
    <div class="wf-hd" @click="openDrawer">
      <svg v-if="running" class="wf-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" opacity="0.35"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>
      <svg v-else class="wf-ico" :class="{ dim }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>
      <span class="wf-prefix" :class="{ dim }">workflow</span>
      <span v-if="name" class="wf-name" :class="{ dim }">{{ name }}</span>
      <template v-if="slug">
        <span class="wf-sep">·</span>
        <span class="wf-slug" :class="{ dim }">{{ slug }}</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wf { padding: 10px 0 8px; transition: opacity var(--duration-fast); }
.wf:hover { opacity: 0.8; }
.wf-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--text-base);
  font-weight: 500;
  cursor: pointer;
}
.wf-ico, .wf-loader {
  width: 14px;
  height: 14px;
  color: var(--neutral-ico);
  flex-shrink: 0;
}
.wf-loader { color: var(--accent); animation: spin 1.4s linear infinite; }
.wf-ico.dim { color: var(--neutral-mid); }
.wf-prefix {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 600;
  color: var(--neutral-fg);
  margin-right: 2px;
}
.wf-prefix.dim { color: var(--neutral-mid); }
.wf-name, .wf-slug {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--accent);
}
.wf-name.dim, .wf-slug.dim { color: var(--neutral-mid); }
.wf-sep { color: var(--neutral-faint); font-size: var(--text-sm); }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
