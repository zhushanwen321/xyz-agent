<script setup lang="ts">
/**
 * MobileSessionList —— 移动端 session 列表（spec P4 §3.2 + C2）。
 *
 * 读 useSessionStore().list 渲染简化移动列表项（label + 选中态）。
 * 点击 emit select(sessionId)。空态显示 + 按钮（emit new-session）。
 * 不复用桌面 SessionList.vue（含 rename/delete/分支桌面操作，移动端砍）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import { useSessionStore } from '@/stores/session'

defineProps<{ selectedId?: string | null }>()
const emit = defineEmits<{
  select: [sessionId: string]
  'new-session': []
}>()

const { t } = useI18n()
const sessionStore = useSessionStore()
const sessions = computed(() => sessionStore.list)
</script>

<template>
  <div class="mobile-session-list flex h-full flex-col" data-testid="mobile-session-list">
    <!-- header + 新建按钮 -->
    <div class="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
      <span class="text-sm font-semibold">{{ t('mobile.shell.tabSessions') }}</span>
      <button
        type="button"
        class="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white"
        data-testid="mobile-new-session-btn"
        @click="emit('new-session')"
      >
        <Plus :size="14" />
        {{ t('mobile.session.new') }}
      </button>
    </div>

    <!-- 空态 -->
    <div
      v-if="sessions.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      data-testid="mobile-session-empty"
    >
      <span class="text-sm text-muted">{{ t('mobile.session.empty') }}</span>
      <button
        type="button"
        class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
        @click="emit('new-session')"
      >
        {{ t('mobile.session.new') }}
      </button>
    </div>

    <!-- 列表 -->
    <ul v-else class="flex-1 overflow-y-auto" data-testid="mobile-session-items">
      <li
        v-for="s in sessions"
        :key="s.id"
        :data-testid="`mobile-session-item-${s.id}`"
        class="cursor-pointer border-b border-border px-4 py-3 text-sm"
        :class="selectedId === s.id ? 'bg-accent-soft text-fg' : 'text-muted'"
        @click="emit('select', s.id)"
      >
        {{ s.label || s.id }}
      </li>
    </ul>
  </div>
</template>
