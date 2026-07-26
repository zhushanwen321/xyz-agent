<template>
  <!--
    展示组件 · turn 导航 rail（IF4，w3 wave）。
    功能：
    - 常驻右侧窄条，hover 弹出全 turn 列表浮层（mini-map + 快速跳转）
    - 窄条上有 viewport indicator 标记当前 turn 在窄条上的纵向位置
    - 浮层内每个节点：状态点（失败红 / 进行中蓝脉冲 / 完成绿）+ 摘要文本 + 跳转 chevron
    - 工具栏：折叠全部 / 展开全部（emit 给父组件统一控展开态）

    设计约束：
    - 纯展示组件，turns/activeTurnIndex/sessionActive 全由父组件传入
    - 不内管 expanded 状态（IF4 契约未含 expanded prop）——
      chevron 统一右指，active 节点 rotate-90（▼）仅表「当前位置」而非展开态
    - 用 xyz-ui Button，禁止原生 button（项目硬规范，pre-commit 检查）
    - 用 @lucide/vue 图标，禁止 emoji
    - 用 Tailwind 语义类 / CSS var，禁止硬编码颜色
  -->
  <div
    v-if="turns.length > 0"
    data-testid="turn-rail"
    class="turn-rail group fixed top-1/2 z-20 h-[340px] w-1.5 -translate-y-1/2 transition-[width] duration-[var(--duration)] ease-[var(--ease)] hover:w-56 before:absolute before:-left-1.5 before:top-0 before:bottom-0 before:w-3 before:content-['']"
    :style="railStyle"
  >
    <!-- 常驻窄条 spine：未 hover 时唯一可见区域。bg-surface-hover 保证在 bg 上明确可见（L1 入口可发现性）。 -->
    <div class="rail-spine absolute bottom-0 left-0 top-0 w-1.5 rounded-full bg-surface-hover" />

    <!-- viewport indicator：标记当前 turn 在窄条上的纵向位置（mini-map 高亮） -->
    <div
      class="rail-viewport absolute left-0 w-1.5 rounded-full border-l-2 border-accent bg-accent/20"
      :style="viewportStyle"
    />

    <!-- hover 展开浮层（常驻 DOM，靠 group-hover 切换可见性，避免 SSR/动画抖动）。
         区分度：bg-bg-elevated（浮起面板语义，与画布 bg 亮度差 Δ17）+ ring 硬边界（不依赖阴影方向）。
         去掉 backdrop-blur（不透明底上零效果）。 -->
    <div
      class="rail-panel absolute bottom-0 left-3 right-0 top-0 translate-x-2 rounded-lg bg-bg-elevated p-2 opacity-0 shadow-2 ring-1 ring-border-strong pointer-events-none transition-all group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto"
    >
      <!-- 节点列表（铺满 rail 浮层，超出靠浮层自身高度滚动） -->
      <div class="rail-list flex max-h-full flex-col gap-0.5 overflow-y-auto">
        <div
          v-for="(turn, idx) in turns"
          :key="turn.index ?? idx"
          data-testid="rail-node"
          class="group/rail-node rail-node relative flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-surface-hover"
          :class="idx === activeTurnIndex ? 'active bg-accent-soft ring-1 ring-inset ring-accent-ring' : ''"
          @click="emit('jump', idx)"
        >
          <!-- 状态点：失败红 / 进行中蓝脉冲 / 完成绿 -->
          <span
            data-testid="rail-dot"
            class="rail-dot size-2 shrink-0 rounded-full"
            :class="dotClass(turn, idx)"
          />
          <!-- 摘要文本（截断，溢出隐藏）。pr-6 给 toggle 按钮让位（absolute right-1） -->
          <span class="flex-1 truncate pr-6 text-[11px] leading-tight text-fg">
            {{ summarizeTurnForRail(turn) || ' ' }}
          </span>
          <!-- 折展 toggle 按钮：hover/focus 浮出（渐进披露），active 节点常驻可见（用户决策）。
               图标语义：ChevronDown=折叠态（向下展开）/ ChevronUp=展开态（向上收起），直观不混语义。
               「当前位置」标记不再借用 chevron 方向，由节点底色 bg-accent-soft + ring 独立承担。 -->
          <Button
            variant="ghost"
            size="icon"
            class="absolute right-1 h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover/rail-node:opacity-100 group-focus-within/rail-node:opacity-100"
            :class="idx === activeTurnIndex ? '!opacity-100' : ''"
            data-testid="rail-toggle"
            :data-expanded="isExpanded(idx)"
            :disabled="sessionActive"
            @click.stop="emit('toggle', idx)"
          >
            <ChevronUp v-if="isExpanded(idx)" class="size-3" />
            <ChevronDown v-else class="size-3" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * script：纯 props/emit + 派生 class 计算，无副作用。
 * 用 computed 缓存 style 对象避免每次 render 重算字符串。
 */
import { computed } from 'vue'
import { ChevronDown, ChevronUp } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { hasFailedTool } from '@/composables/logic/messageTurns'
import { summarizeTurnForRail } from '@/composables/logic/summarizeTurn'

const props = defineProps<{
  /** 全部 turns（rail 节点列表数据源） */
  turns: MessageTurn[]
  /** 当前激活 turn 的下标（viewport 位置 + 节点高亮依据） */
  activeTurnIndex: number
  /** 会话是否进行中（true 时禁用所有 toggle，避免 streaming 中 toggle 展开态） */
  sessionActive: boolean
  /** 面板右边缘 px（可选）：未传时 rail 贴视口右侧 8px */
  panelRightEdge?: number
  /** 已展开的 turn index 集合（toggle 图标方向依据：展开=ChevronUp / 折叠=ChevronDown） */
  expandedTurns?: Set<number>
}>()

const emit = defineEmits<{
  /** 点击节点文本区 → 跳转到该 turn */
  jump: [turnIndex: number]
  /** 点击节点 toggle → 切换该 turn 的展开态 */
  toggle: [turnIndex: number]
}>()

/**
 * 查询指定 turn（按 railTurns 下标）是否处于展开态。
 * toggle 图标据此切 ChevronUp（展开）/ ChevronDown（折叠）。
 * expandedTurns 缺省时视为全折叠（默认折叠态，符合「默认极简」原则）。
 */
function isExpanded(idx: number): boolean {
  if (!props.expandedTurns) return false
  const turnIdx = props.turns[idx]?.index
  return turnIdx != null && props.expandedTurns.has(turnIdx)
}

/**
 * rail 横向定位：根据 panelRightEdge 算 right 偏移。
 * panelRightEdge 给定时 → 贴面板左侧（避免压住面板内容）；
 * 缺省 → 贴视口右侧 8px（CSS fallback 路径，用于独立预览/无 panel 场景）。
 */
const railStyle = computed(() => ({
  right: props.panelRightEdge ? `calc(100vw - ${props.panelRightEdge}px + 8px)` : '8px',
}))

/** 百分比基数（CSS top/height 用 % 单位，100 是百分比满分母） */
const PERCENT = 100

/**
 * viewport indicator 纵向定位：当前 turn 在窄条上的比例位置 + 比例高度。
 * 防御：turns 为空时本组件不渲染（v-if），但 computed 仍需兜底避免除零。
 */
const viewportStyle = computed(() => {
  const total = props.turns.length || 1
  const topPct = (props.activeTurnIndex / total) * PERCENT
  const heightPct = PERCENT / total
  return {
    top: `${topPct}%`,
    height: `${heightPct}%`,
  }
})

/**
 * 状态点 class 计算（与 dotClassFor 一致的语义，输出 Tailwind 语义类）：
 * - failed（hasFailedTool）→ bg-danger（红色，最显眼的告警色，drives user 复查）
 * - active（sessionActive 且当前激活）→ bg-accent + animate-pulse-accent（蓝脉冲，进行中信号）
 * - 其余 → bg-success（绿，完成态）
 *
 * 优先级：failed > active > ok —— 失败优先于进行中（失败信息更需要被注意到，
 * 即便 turn 正在 streaming，过往的失败也要标记）。
 */
function dotClass(turn: MessageTurn, idx: number): string {
  if (hasFailedTool(turn)) return 'fail bg-danger'
  if (props.sessionActive && idx === props.activeTurnIndex) return 'active bg-accent animate-pulse-accent'
  return 'ok bg-success'
}
</script>
