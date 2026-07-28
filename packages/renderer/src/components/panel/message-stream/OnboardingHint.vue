<template>
  <!--
    OnboardingHint —— 渐进 onboarding 气泡（critique 第 3 轮 Nielsen 第 10 项 Help & Documentation）。

    message-stream 是新用户首次接触 agent 概念（subagent/workflow/fork）的地方。
    此组件为「块内嵌提示条」（方案 A，非浮动 Popover）：inline 渲染在它解释的元素旁，
    用 v-if 控制首次显示，用户点关闭后 localStorage 永久记忆。

    视觉语言复用 BrowserPane.vue 的 guide hint：浅色 accent-soft 背景 + 圆角 + 小字 + ghost X 按钮。
    - 不做自动消失（让用户主动关闭，避免没看清就没了）
    - data-testid: onboarding-{hintKey} / onboarding-{hintKey}-close（E2E 锚点）
  -->
  <div
    v-if="visible"
    class="onboarding-hint mt-1 flex items-start gap-1.5 rounded bg-accent-soft px-2.5 py-1.5 max-w-[280px]"
    :data-testid="`onboarding-${hintKey}`"
  >
    <span class="flex-1 text-[var(--text-xs)] leading-relaxed text-neutral-fg">{{ text }}</span>
    <Button
      variant="ghost"
      size="icon"
      class="onboarding-hint-close size-4 shrink-0 text-neutral-dim hover:text-neutral-fg"
      :data-testid="`onboarding-${hintKey}-close`"
      :title="t('panel.message.onboardingDismiss')"
      @click="dismiss"
    >
      <X class="size-3" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { useOnboarding } from '@/composables/effects/useOnboarding'

const props = defineProps<{
  /** onboarding 概念 key：'subagent' / 'workflow' / 'fork'。决定 localStorage key 与 data-testid 后缀 */
  hintKey: string
  /** 气泡文案（由调用方从 i18n 取后透传，保持本组件无业务耦合） */
  text: string
}>()

const { t } = useI18n()
const { visible, dismiss } = useOnboarding(props.hintKey)
</script>
