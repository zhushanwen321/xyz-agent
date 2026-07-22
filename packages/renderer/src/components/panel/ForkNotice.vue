<template>
  <!--
    展示组件 · Fork 反馈行（FR-12，spec §3）。
    fork 成功后在主线对话流插一条 transient 反馈行（非 banner，遵循架构约定 #3）。

    规范（spec §3）：
    - 容器：info-soft 底 + border + radius + padding 7px 11px
    - 图标：GitFork（14px，info 色）
    - 文案：「已 fork 到后台 · [分支名]」或「已在新分支提问 · [预览]」
    - 查看链接：accent 色，点击跳转到该分支
    - 关闭 ×：subtle 色 + hover fg
    - 动效：notice-in 200ms（从 -4px translateY 淡入）

    降级：sessionDeleted=true 时分支已删，「查看」降级为纯文本不可点（spec §4 Key States）。
    用 xyz-ui Button 组件，禁止原生 HTML 表单元素（关闭/查看均走 Button）。
  -->
  <div class="fork-notice flex items-center gap-2 rounded-[var(--radius)] border border-border bg-info-soft px-[11px] py-[7px] animate-notice-in">
    <GitFork class="size-3.5 shrink-0 text-info" />
    <span class="min-w-0 flex-1 text-[12.5px] leading-snug text-fg">
      {{ prefix }}<span v-if="label" class="font-[550] font-medium">{{ label }}</span>
    </span>
    <!-- 查看链接：sessionDeleted 时降级为纯文本 span（不可点，无交互语义） -->
    <Button
      v-if="!sessionDeleted"
      variant="ghost"
      size="sm"
      class="h-auto shrink-0 p-0 text-[12px] text-accent hover:bg-accent-soft hover:text-accent-hover"
      data-testid="fork-notice-view"
      @click="emit('view')"
    >
      {{ t('panel.forkNotice.view') }}
    </Button>
    <span
      v-else
      class="shrink-0 text-[12px] text-subtle"
      data-testid="fork-notice-view"
    >
      {{ t('panel.forkNotice.view') }}
    </span>
    <!-- 关闭 × -->
    <Button
      variant="ghost"
      size="icon"
      class="size-5 shrink-0 text-subtle hover:bg-surface-hover hover:text-fg"
      :title="t('panel.forkNotice.dismiss')"
      @click="emit('dismiss')"
    >
      <X class="size-3" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    /** 分支名（纯后台 fork）或提问预览（fork-ask）。无则只显示前缀文案。 */
    branchName?: string
    /** fork-ask 的提问预览（优先于 branchName 展示）。 */
    preview?: string
    /** 源分支是否已删除——true 时「查看」降级为纯文本不可点（spec §4）。 */
    sessionDeleted?: boolean
  }>(),
  { sessionDeleted: false },
)

const emit = defineEmits<{
  /** 点击「查看」：跳转到分支 session（仅 sessionDeleted=false 时触发）。 */
  view: []
  /** 点击关闭 ×：移除反馈行。 */
  dismiss: []
}>()

/** 前缀文案：有 preview → fork-ask 文案；否则 fork 后台文案。 */
const prefix = computed(() =>
  props.preview
    ? t('panel.forkNotice.askedPrefix')
    : t('panel.forkNotice.forkedPrefix'),
)

/** 加粗展示的分支名 / 提问预览。 */
const label = computed(() => props.preview || props.branchName || '')
</script>
