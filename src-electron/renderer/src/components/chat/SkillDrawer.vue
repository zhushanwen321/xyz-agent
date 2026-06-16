<template>
  <Transition name="skill-drawer">
    <div v-if="visible" class="skill-drawer">
      <div class="skill-drawer__header">
        <!-- eslint-disable-next-line taste/no-native-html-elements -- small icon close button, xyz-ui Button too heavy for this drawer header -->
        <button class="skill-drawer__close" aria-label="关闭" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
        </button>
        <span class="skill-drawer__title">{{ skillName }}</span>
      </div>
      <div v-if="loading" class="skill-drawer__loading">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
        <span class="text-muted text-xs font-mono">加载中...</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else class="skill-drawer__body msg__body" v-html="renderedContent"></div>
    </div>
  </Transition>
  <Transition name="skill-backdrop">
    <div v-if="visible" class="skill-drawer__backdrop" @click="$emit('close')"></div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { renderLightweight, renderFull } from '../../lib/markdown'
import { useSettingsStore } from '../../stores/settings'
import { api } from '../../api'

const props = defineProps<{
  visible: boolean
  skillName: string
  skillLocation?: string
  panelId?: string
}>()

defineEmits<{
  close: []
}>()

const settings = useSettingsStore()
const loading = ref(false)
const renderedContent = ref('')

// readFile 经 api 走 id 匹配的 pending，直接 await 结果（替代手动 requestId + 事件监听）
watch(() => props.visible, async (vis) => {
  if (!vis) return

  if (!props.skillLocation) {
    renderedContent.value = '<p class="skill-drawer__empty">无 Skill 内容可显示</p>'
    return
  }
  loading.value = true
  try {
    const result = await api.system.readFile({ path: props.skillLocation }) as { content?: string; error?: string }
    if (result.error) {
      renderedContent.value = '<p class="skill-drawer__empty">加载失败: ' + result.error + '</p>'
    } else if (result.content) {
      const content = result.content
      const theme = settings.theme === 'dark' ? 'dark' : settings.theme === 'light' ? 'light'
        : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      renderFull(content, theme, { codeTheme: theme }).then(html => {
        renderedContent.value = html
      }).catch(() => {
        renderedContent.value = renderLightweight(content)
      })
    }
  } catch (e) {
    renderedContent.value = '<p class="skill-drawer__empty">加载失败: ' + (e instanceof Error ? e.message : '未知错误') + '</p>'
  } finally {
    loading.value = false
  }
}, { immediate: true })
</script>

<style scoped>
.skill-drawer {
  position: absolute;
  inset: 0;
  background: var(--surface);
  z-index: 30;
  display: flex;
  flex-direction: column;
}
.skill-drawer__header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.skill-drawer__close {
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent; cursor: pointer;
  color: var(--muted); border-radius: var(--radius);
  transition: all 0.12s ease;
}
.skill-drawer__close:hover { background: var(--hover-bg); color: var(--fg); }
.skill-drawer__title {
  font-size: 12px; font-weight: 600;
  font-family: var(--font-mono);
  color: var(--accent);
}
.skill-drawer__loading {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
}
.skill-drawer__body {
  flex: 1; overflow-y: auto; padding: 14px 16px;
  font-size: 12px; line-height: 1.7;
}
.skill-drawer__empty {
  color: var(--muted);
}

.skill-drawer__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.08);
  z-index: 29;
  cursor: pointer;
}

/* Transitions */
.skill-drawer-enter-active,
.skill-drawer-leave-active {
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.skill-drawer-enter-from,
.skill-drawer-leave-to {
  transform: translateX(100%);
}

.skill-backdrop-enter-active,
.skill-backdrop-leave-active {
  transition: opacity 0.2s ease;
}
.skill-backdrop-enter-from,
.skill-backdrop-leave-to {
  opacity: 0;
}
</style>
