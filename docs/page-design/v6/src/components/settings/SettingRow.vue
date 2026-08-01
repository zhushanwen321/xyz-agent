<script setup lang="ts">
/** SettingRow：设置行 — label + 12px neutral-mid desc + 右侧 control 右对齐（slot）。*/
defineProps<{
  label: string
  desc?: string
  /** 标题旁额外插槽（如 dirty badge）*/
  badge?: boolean
}>()
</script>

<template>
  <div class="setting-row">
    <div class="sr-left">
      <div class="sr-label">
        <span class="label">{{ label }}</span>
        <slot name="badge" />
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
  padding: var(--space-3) var(--space-4);
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
