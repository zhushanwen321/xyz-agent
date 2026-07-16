<template>
  <!--
    展示组件 · system 提示行（W07-C）。
    渲染 bashExecution / compactionSummary / branchSummary 三类 system 消息。
    不冒充 user/assistant：弱化样式（居中、小字、图标 + 一行摘要），
    作流转过程的元信息提示（执行记录 / 压缩 / 分支）。
  -->
  <div class="system-notice flex min-w-0 items-center gap-2 py-1">
    <span class="h-px flex-1 bg-border" />
    <component :is="icon" class="size-3 shrink-0 text-muted" />
    <span class="min-w-0 truncate text-[11px] leading-snug text-muted">{{ text }}</span>
    <span class="h-px flex-1 bg-border" />
  </div>
</template>

<script setup lang="ts">
import { GitBranch, Archive } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import type { Message } from '@xyz-agent/shared'

const { t } = useI18n()

const props = defineProps<{
  message: Message
}>()

/** 按消息类型选图标 + 摘要文案（纯函数，props 不变则结果不变） */
const { icon, text } = resolveNotice(props.message)

function resolveNotice(message: Message): { icon: Component; text: string } {
  if (message.compactionSummary) {
    const tokens = message.compactionSummary.tokensBefore
    const tokLabel = tokens !== undefined ? t('panel.message.compactedTokens', { tokens: formatTokens(tokens) }) : ''
    return { icon: Archive, text: t('panel.message.compacted', { tokens: tokLabel }) }
  }
  if (message.branchSummary) {
    const from = message.branchSummary.fromId
    return { icon: GitBranch, text: from ? t('panel.message.branchCreated', { from }) : t('panel.message.branchCreatedNoFrom') }
  }
  // 兜底：纯 system 文本
  return { icon: Archive, text: message.content }
}

/** K 格式阈值（>= 此值显示 K，如 237186 → 237.2K，< 此值显原数） */
const K_THRESHOLD = 1000

/** token 数 → K 格式：237186 → 237.2K，13400 → 13.4K，<1000 原数 */
function formatTokens(n: number): string {
  if (n < K_THRESHOLD) return String(n)
  const k = n / K_THRESHOLD
  return `${k.toFixed(1).replace(/\.0$/, '')}K`
}
</script>
