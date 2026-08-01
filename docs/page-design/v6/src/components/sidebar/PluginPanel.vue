<script setup lang="ts">
/** PluginPanel：plugin tab 内容（sb-view 浮起层）。
 *  v6 spec §2 A1：一级 plugin tab 内层是二级 tab（plugin 注册的 view），
 *  这里用 l2-tabbar 静态占位（goal/todo/workflow 三个 view 标签 + 内容区）。
 *  卡片列表消费 mock/sessions.ts 的 extensions（tier 分组 + enabled 开关），
 *  version 字段 mock 未提供，组件内静态补。 */

import { ref, computed, reactive } from 'vue'
import { extensions as extData } from '@/mock/sessions'
import UiSwitch from '@/components/settings/UiSwitch.vue'

type PluginIcon = 'target' | 'list' | 'workflow' | 'shield' | 'wrench'
type PluginTier = 'infrastructure' | 'feature'

interface PluginCard {
  name: string
  shortName: string
  desc: string
  icon: PluginIcon
  version: string
  tier: PluginTier
  enabled: boolean
  /** 异常态演示：enabled 但版本不兼容等 */
  error?: boolean
}

/** 二级 tab：plugin 注册 view 的静态占位（spec §2 A1「plugin views」） */
const VIEW_TABS = [
  { id: 'all', label: '全部' },
  { id: 'pi-goal', label: 'goal' },
  { id: 'pi-todo', label: 'todo' },
  { id: 'pi-subagent-workflow', label: 'workflow' },
] as const
type ViewId = (typeof VIEW_TABS)[number]['id']
const activeView = ref<ViewId>('all')

const ICON_MAP: Record<string, PluginIcon> = {
  'pi-goal': 'target',
  'pi-todo': 'list',
  'pi-subagent-workflow': 'workflow',
  'pi-permission': 'shield',
  'my-custom-tool': 'wrench',
}
const VERSION_MAP: Record<string, string> = {
  'pi-goal': '1.4.2',
  'pi-todo': '1.2.0',
  'pi-subagent-workflow': '2.0.1',
  'pi-permission': '0.9.3',
  'my-custom-tool': '0.3.1',
}

const plugins = reactive<PluginCard[]>(
  extData.map((e) => ({
    name: `@zhushanwen/${e.name}`,
    shortName: e.name,
    desc: e.desc,
    icon: ICON_MAP[e.name] ?? 'target',
    version: VERSION_MAP[e.name] ?? '',
    tier: e.tier as PluginTier,
    enabled: e.enabled,
    // my-custom-tool 演示异常态（warn 圆点）
    error: e.name === 'my-custom-tool',
  })),
)

const TIER_GROUPS: { tier: PluginTier; label: string }[] = [
  { tier: 'infrastructure', label: '基础设施' },
  { tier: 'feature', label: '功能扩展' },
]

const visible = computed(() => {
  if (activeView.value === 'all') return plugins
  return plugins.filter((p) => p.shortName === activeView.value)
})
const grouped = computed(() =>
  TIER_GROUPS.map((g) => ({
    ...g,
    items: visible.value.filter((p) => p.tier === g.tier),
  })).filter((g) => g.items.length > 0),
)

function toggleEnabled(p: PluginCard) {
  p.enabled = !p.enabled
}
</script>

<template>
  <div class="plugin-panel">
    <!-- 二级 tab 栏（spec §2 A1：plugin 注册 view 的标签行 + 内容区） -->
    <div class="l2-tabbar" role="tablist">
      <button
        v-for="t in VIEW_TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="l2-tab"
        :class="{ 'l2-tab--active': activeView === t.id }"
        :aria-selected="activeView === t.id"
        @click="activeView = t.id as ViewId"
      >{{ t.label }}</button>
    </div>

    <!-- 内容区：tier 分组的卡片列表 -->
    <div v-if="grouped.length > 0" class="plugin-panel__list">
      <template v-for="g in grouped" :key="g.tier">
        <div class="group-head">
          <span class="group-head__title">{{ g.label }}</span>
          <span class="group-head__count">{{ g.items.length }}</span>
        </div>
        <div v-for="p in g.items" :key="p.name" class="plugin-card">
          <!-- target icon（goal） -->
          <svg
            v-if="p.icon === 'target'"
            class="plugin-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          <!-- list-check icon（todo） -->
          <svg
            v-else-if="p.icon === 'list'"
            class="plugin-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="3 7 4 8 6 6" />
            <polyline points="3 14 4 15 6 13" />
            <line x1="10" y1="7" x2="20" y2="7" />
            <line x1="10" y1="14" x2="20" y2="14" />
            <line x1="3" y1="20" x2="20" y2="20" />
          </svg>
          <!-- git-branch icon（workflow） -->
          <svg
            v-else-if="p.icon === 'workflow'"
            class="plugin-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <!-- shield icon（permission） -->
          <svg
            v-else-if="p.icon === 'shield'"
            class="plugin-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          </svg>
          <!-- wrench icon（custom） -->
          <svg
            v-else
            class="plugin-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          <div class="plugin-card__main">
            <div class="plugin-card__name-row">
              <span class="plugin-card__name">{{ p.name }}</span>
              <span v-if="p.version" class="plugin-card__version">{{ p.version }}</span>
            </div>
            <div class="plugin-card__desc">{{ p.desc }}</div>
          </div>
          <span
            class="plugin-card__status"
            :class="p.error ? 'error' : p.enabled ? 'ok' : 'off'"
            :title="p.error ? '异常' : p.enabled ? '已启用' : '已禁用'"
          ></span>
          <UiSwitch
            :checked="p.enabled"
            :aria-label="'启用 ' + p.name"
            @update:checked="toggleEnabled(p)"
          />
        </div>
      </template>
    </div>

    <!-- 空态 -->
    <div v-else class="plugin-panel__empty">
      <svg
        class="plugin-panel__empty-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"
        />
      </svg>
      <span class="plugin-panel__empty-text">未发现插件扩展</span>
    </div>
  </div>
</template>

<style scoped>
.plugin-panel {
  /* sb-view 浮起层：surface 底色 + radius */
  background: var(--surface);
  border-radius: var(--radius);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 二级 tab 栏（spec §2 A1 plugin views 占位） */
.l2-tabbar {
  display: flex;
  gap: 2px;
  padding: 2px 4px 6px;
}
.l2-tab {
  height: 24px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--neutral-mid);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.l2-tab:hover {
  color: var(--neutral-fg);
}
.l2-tab--active {
  background: var(--bg-elevated);
  color: var(--neutral-fg);
}

/* 组头：normal-case 11px 中性（参照 SessionList group-head 范式） */
.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 2px;
}
.group-head__title {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--neutral-dim);
}
.group-head__count {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  opacity: 0.6;
}

.plugin-panel__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plugin-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease);
}
.plugin-card:hover {
  background: var(--surface-hover);
}
.plugin-card__icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--neutral-mid);
}
.plugin-card__main {
  min-width: 0;
  flex: 1;
}
.plugin-card__name-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.plugin-card__name {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.35;
  color: var(--neutral-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 版本号：mono 10px neutral-dim */
.plugin-card__version {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  flex-shrink: 0;
}
.plugin-card__desc {
  margin-top: 1px;
  font-size: var(--text-2xs);
  line-height: 1.3;
  color: var(--neutral-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 状态圆点：7px · enabled=success / disabled=neutral-dim / 异常=warn */
.plugin-card__status {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 5px;
}
.plugin-card__status.ok {
  background: var(--success);
}
.plugin-card__status.off {
  background: var(--neutral-dim);
}
.plugin-card__status.error {
  background: var(--warn);
}

/* 空态 */
.plugin-panel__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 8px;
}
.plugin-panel__empty-icon {
  width: 28px;
  height: 28px;
  color: var(--neutral-faint);
}
.plugin-panel__empty-text {
  font-size: var(--text-xs);
  color: var(--neutral-dim);
}
</style>
