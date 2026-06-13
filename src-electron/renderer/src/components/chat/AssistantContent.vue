<!--
  助手消息内容：透传 AgentRunBlock 统一渲染。
  compact/normal 模式均由 AgentRunBlock 内部处理。
-->
<template>
  <AgentRunBlock :message="message" :is-streaming="!!isStreaming" />
</template>

<script setup lang="ts">
import type { Message } from '@xyz-agent/shared'
import AgentRunBlock from './AgentRunBlock.vue'

defineProps<{
  message: Message
  isStreaming?: boolean
}>()
</script>
