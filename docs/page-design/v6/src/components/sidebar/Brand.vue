<script setup lang="ts">
/** 品牌区：logo（accent 纯色圆 + 白字 x）+ 产品名 + 版本号 + 可升级 badge。
 *  对齐 v6-spec-sidebar.html §1 .sb-brand。 */

interface Props {
  name?: string
  version?: string
  hasUpdate?: boolean
}
withDefaults(defineProps<Props>(), {
  name: 'xyz-agent',
  version: 'v1.4.0',
  hasUpdate: true,
})

const emit = defineEmits<{ (e: 'update-click'): void }>()
</script>

<template>
  <div class="brand">
    <span class="brand__logo">x</span>
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
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff; /* accent-on 文字色，token 未建立，spec §1 显式保留 #fff */
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
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
  gap: 4px;
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
