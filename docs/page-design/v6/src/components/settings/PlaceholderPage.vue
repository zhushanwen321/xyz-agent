<script setup lang="ts">
import { computed } from 'vue'
import { settingsPage, type SettingsPage } from '@/composables/useStore'
import GroupCard from './GroupCard.vue'

/** PlaceholderPage：spec 未补全页面的占位（terminal/preset/worktree/update/system/skill）。
 * 空态三要素（spec §7）：①dashed 圆形容器 + 图标 ②标题 + desc ③Primary 入口（回首页）。*/
const props = defineProps<{ page: SettingsPage }>()

const LABELS: Record<string, string> = {
  skill: '技能',
  agent: '代理',
  terminal: '终端',
  preset: '预设',
  worktree: '工作区',
  update: '更新',
  system: '系统',
}
const title = computed(() => LABELS[props.page] ?? '设置')

function goHome() {
  settingsPage.value = 'provider'
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1 class="title">{{ title }}</h1>
      <p class="desc">此页面 spec 待补，当前为占位。</p>
    </header>
    <GroupCard>
      <div class="empty-state">
        <div class="es-ico-wrap">
          <svg class="es-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </div>
        <p class="es-title">该模块尚未设计。</p>
        <p class="es-desc">此模块的规格仍在设计中，敬请期待。你可以先回到供应商页继续配置。</p>
        <button class="btn btn-default btn-default-size" type="button" @click="goHome">回首页</button>
      </div>
    </GroupCard>
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: var(--space-6);
}
.title {
  font-size: 18px;
  font-weight: 700;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
/* 空态（spec §7）：dashed 圈 + 图标 + 标题 + desc + Primary 入口 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-12) var(--space-4);
  text-align: center;
}
.es-ico-wrap {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 999px;
  border: 2px dashed var(--border-strong);
  color: var(--neutral-dim);
}
.es-icon {
  width: 28px;
  height: 28px;
}
.es-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--neutral-fg);
}
.es-desc {
  font-size: 12px;
  color: var(--neutral-mid);
  max-width: 320px;
}
.empty-state .btn {
  margin-top: var(--space-2);
}
</style>
