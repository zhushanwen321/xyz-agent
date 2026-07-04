<template>
  <!--
    展示组件 · system 提示行（W07-C）。
    渲染 bashExecution / compactionSummary / branchSummary 三类 system 消息。
    不冒充 user/assistant：弱化样式（居中、小字、图标 + 一行摘要），
    作流转过程的元信息提示（执行记录 / 压缩 / 分支）。
  -->
  <div class="system-notice flex items-center justify-center gap-1.5 py-1.5 text-center">
    <component :is="icon" class="size-3 shrink-0 text-muted" />
    <span class="text-[11.5px] leading-snug text-muted">{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
import { Terminal, GitBranch, Archive } from '@lucide/vue'
import type { Component } from 'vue'
import type { Message } from '@xyz-agent/shared'

const props = defineProps<{
  message: Message
}>()

/** 按消息类型选图标 + 摘要文案（纯函数，props 不变则结果不变） */
const { icon, text } = resolveNotice(props.message)

function resolveNotice(message: Message): { icon: Component; text: string } {
  if (message.bashExecution) {
    const exec = message.bashExecution
    const cmdLabel = exec.command ? `$ ${exec.command}` : 'bash 执行'
    const exitLabel = formatExit(exec.exitCode, exec.cancelled)
    const truncLabel = exec.truncated ? ' · 输出已截断' : ''
    return { icon: Terminal, text: `${cmdLabel}${exitLabel}${truncLabel}` }
  }
  if (message.compactionSummary) {
    const tokens = message.compactionSummary.tokensBefore
    const tokLabel = tokens !== undefined ? `（${tokens} tokens）` : ''
    return { icon: Archive, text: `上下文已压缩${tokLabel}` }
  }
  if (message.branchSummary) {
    const from = message.branchSummary.fromId
    const fromLabel = from ? `（自 ${from}）` : ''
    return { icon: GitBranch, text: `已创建分支${fromLabel}` }
  }
  // 兜底：纯 system 文本
  return { icon: Archive, text: message.content }
}

/** exitCode 摘要：0→成功，非 0→失败码，cancelled→已取消 */
function formatExit(exitCode?: number, cancelled?: boolean): string {
  if (cancelled) return ' · 已取消'
  if (exitCode === undefined) return ''
  return exitCode === 0 ? ' · exit 0' : ` · exit ${exitCode}`
}
</script>
