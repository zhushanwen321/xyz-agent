<script setup lang="ts">
/**
 * SettingRow —— v6 设置行原语（label + 12px neutral-mid desc + 右侧 control slot）。
 * 用于 SystemPage 等设置页内的「左标签 + 右控件」行范式。
 * 与 demo .tmp/v6/src/components/settings/SettingRow.vue 范式对齐。
 */
defineProps<{
  label: string
  desc?: string
}>()
</script>

<template>
  <div class="setting-row">
    <div class="sr-left">
      <div class="sr-label">
        <span class="label">{{ label }}</span>
      </div>
      <p v-if="desc" class="desc">{{ desc }}</p>
    </div>
    <div class="sr-right">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 10px 6px;
  min-height: 48px;
}
.setting-row + .setting-row {
  border-top: 1px solid color-mix(in oklch, var(--border) 50%, transparent);
}
.sr-left {
  flex: 1;
  min-width: 0;
}
.sr-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.label {
  font-size: var(--text-base);
  color: var(--neutral-fg);
  font-weight: 500;
}
.desc {
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  margin-top: 2px;
}
.sr-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
</style>
