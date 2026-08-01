<script setup lang="ts">
/** 快捷入口 nav 行：icon + label + kbd 标签。
 *  对齐 v6-demo.html .btn-primary / .btn-ghost（aside primary actions 别名，32px 高）。
 *  新建任务 = primary（accent 底白字）· 搜索 = ghost（透明），形成主/次层级。 */

interface Props {
  /** 图标插槽名（lucide）：plus / search */
  icon: 'plus' | 'search'
  label: string
  /** 快捷键标签，如 ⌘N / ⌘K */
  kbd?: string
  /** primary：accent 实色（主操作）；ghost：透明（次操作）；default：普通 nav 行 */
  variant?: 'default' | 'primary' | 'ghost'
}

withDefaults(defineProps<Props>(), { variant: 'default' })
defineEmits<{ (e: 'click'): void }>()

// lucide path 数据（inline SVG，统一 stroke-width 1.75）
const ICONS: Record<Props['icon'], string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
}
</script>

<template>
  <button
    class="nav-item"
    :class="`nav-item--${variant}`"
    type="button"
    @click="$emit('click')"
  >
    <svg
      class="nav-item__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      v-html="ICONS[icon]"
    />
    <span class="nav-item__label">{{ label }}</span>
    <kbd v-if="kbd" class="nav-item__kbd">{{ kbd }}</kbd>
  </button>
</template>

<style scoped>
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
  background: transparent;
  border: 0;
  font-family: inherit;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease),
    color var(--duration-fast) var(--ease);
}
.nav-item:hover {
  background: var(--surface-hover);
  color: var(--neutral-fg);
}
.nav-item__icon {
  width: 15px;
  height: 15px;
  color: var(--neutral-dim);
  flex-shrink: 0;
  transition: color var(--duration-fast) var(--ease);
}
.nav-item:hover .nav-item__icon {
  color: var(--neutral-mid);
}
.nav-item__label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* kbd 保留 border-strong：物理按键语义，§5.1 去 border 不覆盖（spec §1 anno） */
.nav-item__kbd {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--neutral-dim);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
}

/* primary：accent 实色（v6-demo .btn-primary 别名：32px 高 + accent 底 + 白字） */
.nav-item--primary {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  font-weight: 500;
}
.nav-item--primary:hover {
  background: var(--accent-hover);
  color: #fff;
}
.nav-item--primary .nav-item__icon {
  color: #fff;
}
.nav-item--primary:hover .nav-item__icon {
  color: #fff;
}
/* primary kbd 弱化（opacity .7，去边框底色） */
.nav-item--primary .nav-item__kbd {
  background: transparent;
  border: 0;
  color: #fff;
  opacity: 0.7;
}

/* ghost：透明 + 中性字（次操作），与 primary 形成主/次层级 */
.nav-item--ghost {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius);
}
.nav-item--ghost .nav-item__kbd {
  background: transparent;
}
</style>
