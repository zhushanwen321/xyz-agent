<!--
  PresenceList —— 在线设备列表（P5 lease/presence）。

  数据源：usePresenceStore.connections（runtime presence.update / auth.ok presence 全量替换）。
  显示：每个在线设备一行（设备名 + 活跃 session 指示 + 「正在操作」标记 isOperating）。

  最小实现（spec §4.2）：图标 + deviceName 文本 + 占用指示器，点击无操作
  （P5 不做「点击切换到对方的 active session」，留给未来）。

  渲染约束：用 CSS 变量颜色（text-muted/bg-surface-hover）+ lucide 图标，无原生 HTML 表单 / Emoji / 硬编码颜色。
  空态（仅自己在线 / 无其他设备）不渲染（v-if connections.length > 1 才显示，避免单设备时占空间）。
-->
<template>
  <div v-if="showList" class="presence-list px-1 py-1" data-testid="presence-list">
    <div class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-subtle">
      {{ t('sidebar.onlineDevices') }}
    </div>
    <ul class="flex flex-col gap-px">
      <li
        v-for="conn in connections"
        :key="conn.clientId"
        class="flex items-center gap-2 rounded-md px-2 py-1 text-[12px]"
        :class="conn.isOperating ? 'bg-surface-hover text-fg' : 'text-muted'"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="conn.isOperating ? 'bg-warning' : 'bg-success'"
          :title="conn.isOperating ? t('sidebar.operating') : t('sidebar.online')"
        />
        <span class="flex-1 truncate">{{ conn.deviceName || conn.clientId }}</span>
        <span v-if="conn.isOperating" class="text-[10px] text-warning">{{ t('sidebar.operating') }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { usePresenceStore } from '@/stores/presence'

const { t } = useI18n()
const presenceStore = usePresenceStore()
const { connections } = storeToRefs(presenceStore)

/**
 * 仅当多于 1 个在线设备时显示列表（单设备=只有自己，无需占空间）。
 * 多设备时显示完整列表（含自己），让用户知道谁在线、谁在操作。
 */
const showList = computed(() => connections.value.length > 1)
</script>
