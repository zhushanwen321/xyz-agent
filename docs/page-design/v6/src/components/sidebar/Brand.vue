<script setup lang="ts">
/** 品牌区：太极双鱼 logo（旋转）+ 产品名 + 版本号 + 可升级 badge。
 *  对齐 v6-spec-sidebar.html §1 .sb-brand。 */

import TaijiLogo from '@/components/icons/TaijiLogo.vue'

interface Props {
  name?: string
  version?: string
  hasUpdate?: boolean
}
withDefaults(defineProps<Props>(), {
  name: '太极',
  version: 'v1.4.0',
  hasUpdate: true,
})

const emit = defineEmits<{ (e: 'update-click'): void }>()
</script>

<template>
  <div class="brand">
    <TaijiLogo class="brand__logo" :size="28" :duration="8" />
    <span class="brand__text">
      <span class="brand__name">{{ name }}</span>
      <span class="brand__ver">{{ version }}</span>
    </span>
    <button
      v-if="hasUpdate"
      class="brand__update"
      type="button"
      title="有新版本可升级"
      @click="emit('update-click')"
    >
      <svg
        class="brand__update-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
      <span class="brand__update-label">可升级</span>
    </button>
  </div>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 14px;
}
.brand__logo {
  color: var(--neutral-fg); /* logo 用 currentColor，中性 fg 保证暗/亮主题均可见 */
  flex-shrink: 0;
  line-height: 0; /* 消除 svg 基线间隙 */
}
.brand__text {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
  min-width: 0;
}
.brand__name {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
  line-height: 1.1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.brand__ver {
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
}
.brand__update {
  margin-left: auto;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--text-2xs);
  color: var(--accent);
  background: transparent;
  border: 0;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease);
}
.brand__update:hover {
  color: color-mix(in oklch, var(--accent) 80%, transparent);
}
/* 文字右上角 7px danger 红点 */
.brand__update-label::after {
  content: '';
  position: absolute;
  top: -2px;
  right: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
}
.brand__update-icon {
  width: 12px;
  height: 12px;
}
</style>
