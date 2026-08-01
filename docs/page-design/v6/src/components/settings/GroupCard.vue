<script setup lang="ts">
import { ref } from 'vue'
/** GroupCard：分组卡片 — bg-card 10px 圆角去 border。
 * group-head（label + 折叠按钮 ghost）+ slot（内容）。*/
withDefaults(
  defineProps<{
    title?: string
    collapsible?: boolean
  }>(),
  { collapsible: false },
)
const collapsed = ref(false)
function toggle() {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <section class="group-card">
    <header v-if="title || $slots.head || collapsible" class="group-head">
      <div class="head-left">
        <slot name="head">
          <h3 v-if="title" class="title">{{ title }}</h3>
        </slot>
      </div>
      <div class="head-right">
        <slot name="actions" />
        <button
          v-if="collapsible"
          class="btn btn-ghost btn-icon collapse-btn"
          :class="{ down: collapsed }"
          :title="collapsed ? '展开' : '折叠'"
          @click="toggle"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
    </header>
    <div v-show="!collapsed" class="group-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.group-card {
  background: var(--bg-card);
  border-radius: 10px;
  overflow: hidden;
}
.group-card + .group-card {
  margin-top: var(--space-4);
}
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 4px 6px 8px;
  min-height: 44px;
}
.head-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.head-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
.title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.collapse-btn {
  width: 28px;
  height: 28px;
}
.collapse-btn svg {
  transition: transform var(--duration-fast) var(--ease);
  transform: rotate(-90deg);
}
.collapse-btn.down svg {
  transform: rotate(0deg);
}
</style>
