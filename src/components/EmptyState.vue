<script setup lang="ts">
const appName = __APP_NAME__
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-4">
    <!-- 终端风格欢迎语 -->
    <div class="space-y-2 text-center">
      <div class="font-mono text-2xl font-bold text-accent">
        $ {{ appName }}
      </div>
      <div class="text-sm text-text-secondary">
        AI-powered agent
      </div>
    </div>

    <!-- 模拟终端输入行 -->
    <div class="flex items-center gap-2 font-mono text-sm text-text-tertiary">
      <span class="text-accent">&gt;</span>
      <span>开始一段新对话</span>
      <span class="inline-block h-4 w-2 bg-accent animate-cursor-blink" />
    </div>

    <!-- 快捷键提示 -->
    <div class="mt-4 flex gap-3 font-mono text-[11px] text-text-tertiary">
      <span>Enter 发送</span>
      <span class="text-border-default">|</span>
      <span>Shift+Enter 换行</span>
    </div>
  </div>
</template>
