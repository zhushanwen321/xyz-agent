<template>
  <!--
    展示组件 · 单会话卡片（overview/spec.md §Session 卡片信息结构 / draft-overview §2）。
    Session Item 的「鸟瞰放大版」——复用同一信息原子，密度上调一档：
    头部（状态点 + 标题 + 分支 pill）/ 摘要（末条 assistant，2 行 ellipsis）/ 指标行（文件·回合·时间）。
    点卡片 → emit('open', id)（容器载入该 session 回 workspace）。
    DEFERRED（spec §9）：后台 agent 进度聚合（flow-3 联动）、未读/错误角标、卡片右键菜单。
    状态点 5 态（D6）与 SessionItem 同源（running/waiting 脉冲）。
    hover = surface-hover + border-strong；active（当前激活 session）= Card-Active inset ring（弃左竖条）。
  -->
  <div
    class="session-card group flex cursor-pointer flex-col gap-2.5 rounded-lg border p-3.5 transition-colors"
    :class="
      active
        ? 'border-transparent bg-surface-2 ring-1 ring-inset ring-accent'
        : 'border-border bg-surface hover:border-border-strong hover:bg-surface-hover'
    "
    @click="emit('open', session.id)"
  >
    <!-- 头部：状态点 + 标题 + 分支 pill -->
    <div class="flex items-center gap-2">
      <span class="size-2 mt-1 shrink-0 rounded-full" :class="dotClass" />
      <span class="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">
        {{ session.label }}
      </span>
      <span
        v-if="session.gitBranch"
        class="max-w-[120px] shrink-0 truncate rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent"
      >
        {{ session.gitBranch }}
      </span>
    </div>

    <!-- 摘要：末条 assistant 文本（2 行 ellipsis）。空 session 不渲染，留白让头部呼吸。 -->
    <p
      v-if="summary"
      class="line-clamp-2 text-[12px] leading-[1.5] text-muted"
    >
      {{ summary }}
    </p>

    <!-- 指标行：改动/回合计数 + 时间（右对齐）。靠间距与顶部 border 分隔（draft 同款）。 -->
    <div class="mt-auto flex items-center gap-3.5 border-t border-border pt-2.5 font-mono text-[11px] text-subtle">
      <span v-if="hasMetrics" class="flex items-center gap-1">
        <FilePen class="size-[11px]" />
        <span class="text-success">{{ addCount }}</span>
        <span v-if="delCount" class="text-danger">−{{ delCount }}</span>
      </span>
      <span v-if="turnCount" class="flex items-center gap-1">{{ turnCount }} 回合</span>
      <span class="ml-auto">{{ timeLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 状态点 class 映射（D6 五态），与 SessionItem §状态点 同源。
 * running/waiting 带 pulse（@keyframes 见 scoped style，Tailwind 无对应工具类）。
 * done/stopped/error 静态语义色（design-tokens SSOT 色，走 CSS 变量不硬编码）。
 */
import { computed } from 'vue'
import { FilePen } from '@lucide/vue'
import type { SessionSummary } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { DOT_CLASS } from '@/composables/logic/sessionStatus'

const props = defineProps<{
  session: SessionSummary
  /** 当前激活 session（Card-Active inset ring） */
  active: boolean
  /** 派生状态点（D6），由容器注入 useSessionDerivations.derivedStatus */
  status: DerivedStatus
  /** 末条 assistant 文本摘要（无则空，卡片不渲染摘要区） */
  summary?: string
  /** 改动行数（+N），0 时隐藏指标 */
  addCount?: number
  /** 删除行数（−N），0 时隐藏 */
  delCount?: number
  /** 消息回合数，0 时隐藏 */
  turnCount?: number
}>()

const emit = defineEmits<{
  open: [sessionId: string]
}>()

/** 状态点语义类：背景色 + 脉冲动画（DOT_CLASS 收敛到 logic/sessionStatus SSOT） */
const dotClass = computed(() => DOT_CLASS[props.status])

/** 是否渲染改动指标（任一计数 > 0） */
const hasMetrics = computed(() => (props.addCount ?? 0) > 0 || (props.delCount ?? 0) > 0)

const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))
</script>

