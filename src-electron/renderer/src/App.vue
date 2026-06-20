<template>
  <!-- L0 Shell 挂载点。traffic light 安全区在 AsideRegion 内（padding-top:52px，spec §三）。 -->
  <AppShell />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import { useConnection } from '@/composables/useConnection'

// 应用挂载即初始化连接（mock 模式 200ms 直进 connected；真 runtime 走端口发现）。
const { init, teardown } = useConnection()
onMounted(() => { void init() })
onBeforeUnmount(() => teardown())
</script>
