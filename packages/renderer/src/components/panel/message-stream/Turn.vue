<template>
  <!--
    展示组件 · 回合（message-stream 单个 turn，draft-message-stream §1）。
    结构：user 气泡（靠右，可编辑分叉）+ assistant 区。
    assistant 区 = turn-meta（已工作按钮 / 工作中态）+ 折叠 trace（thinking/tool/中间 text）+ 收尾 summary。
    - user 气泡下方 hover：复制（常驻）+ 编辑（仅 AI 停止，编辑=fork 新会话）
    - 收尾 summary 下方 hover：复制 + 复制为 MD + fork（modal 确认后 clone+fork 到另一 panel）

    Output Text 中间/收尾拆分（draft §4）：多 assistant 回合，非最后一条 content 折进 trace，
    仅最后一条作收尾 summary 恒显。
  -->
  <div class="flex flex-col gap-3.5">
    <!-- user 区：编辑态切 textarea，展示态气泡 + hover actions -->
    <div v-if="turn.user" class="group/user flex flex-col items-end gap-1">
      <!-- 编辑态：编辑后 fork 新会话 -->
      <div
        v-if="isEditingThisUser"
        class="w-full max-w-[76%] rounded-[14px] border border-accent bg-bg-input p-2 shadow-[0_0_0_3px_rgba(79,142,247,0.18)]"
      >
        <Textarea v-model="draftText" class="min-h-[64px] border-0 bg-transparent px-1 text-[13.5px] leading-[1.55] focus-visible:ring-0" />
        <div class="mt-1.5 flex items-center justify-between px-1">
          <span class="text-[11px] text-subtle">{{ t('panel.message.editAfterReplace') }}</span>
          <div class="flex gap-1.5">
            <Button variant="ghost" size="sm" class="h-7" @click="cancelEdit">{{ t('panel.message.cancel') }}</Button>
            <Button variant="default" size="sm" class="h-7 gap-1" :disabled="!draftText.trim()" @click="submitEdit">
              <ArrowRight class="size-3.5" /> {{ t('panel.composer.send') }}
            </Button>
          </div>
        </div>
      </div>
      <!-- 展示态气泡：右下尖角（user content 走 markdown 渲染；slash 命令前缀渲染为 chip） -->
      <!-- 软换行由 markdown.ts breaks:true 转 <br> 实现（不再用 whitespace-pre-wrap）。
           [HISTORICAL] 曾用 pre-wrap 兑现换行，但会把块级元素间 \n 渲染成空行（见 markdown.ts）。
           例外：pending 气泡用 <span> 纯文本预览（未投递不走 markdown），仍需 pre-wrap 保留换行。 -->
      <!-- pending 气泡（draft-composer-states S7）：steer/followup 已入队未投递，
           虚线边框（1px，对齐设计稿）+ 脉冲圆点 + WHO 标 + 配色（steer 蓝 / followUp 青），投递后转普通气泡。 -->
      <div
        v-else-if="isPendingUser"
        class="max-w-[76%] rounded-[14px_14px_4px_14px] border border-dashed px-[13px] py-[9px] text-[13.5px] leading-[1.55] text-fg whitespace-pre-wrap"
        :class="pendingBubbleClass"
      >
        <span class="mb-1 flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-wider"
          :class="pendingLabelClass"
        >
          <span class="size-[6px] animate-pulse-accent rounded-full" :class="pendingDotClass" />
          {{ pendingLabel }}
        </span>
        <span>{{ turn.user.content }}</span>
      </div>
      <div
        v-else
        class="max-w-[76%] rounded-[14px_14px_4px_14px] border border-border-strong bg-surface-hover px-[13px] py-[9px] text-[13.5px] leading-[1.55] text-fg"
      >
        <!-- slash 命令 chip（与 composer 同款紫色 chip + source icon），后接剩余文本 -->
        <!-- slash 命令 chip（与 composer 同款紫色 chip + source icon），可点击在 drawer 查看文档。
             Button as-child 让 reka-ui Primitive 合并到 span，保留 chip 行内样式 + 按钮语义 -->
        <Button
          v-if="displayChip"
          as-child
          variant="ghost"
          :title="t('panel.message.viewCommandDoc')"
          @click.stop="openCommandDoc(displayChip.name)"
        >
          <span
            class="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--reasoning-soft)] px-1.5 py-px font-mono text-[12px] font-medium leading-[1.4] text-reasoning transition-colors hover:bg-[color-mix(in_oklch,var(--reasoning)_32%,transparent)]"
          >
            <component :is="displayChip.iconComp" class="size-[12px] shrink-0" />
            <span>{{ displayChip.name }}</span>
          </span>
        </Button>
        <MarkdownRenderer v-if="!displayChip || displayChip.rest" :content="displayChip ? displayChip.rest : turn.user.content" :session-id="sessionId" />
      </div>
      <!-- hover actions：复制常驻 hover；编辑仅 AI 停止（非活跃态）时显示。
           pending 气泡不显示 actions（未投递，复制/编辑无意义）。 -->
      <div
        v-if="!isEditingThisUser && !isPendingUser"
        class="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 group-focus-within/user:opacity-100"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-6 text-subtle hover:text-fg"
          :title="t('panel.message.copy')"
          @click="copy(turn.user.content, userCopyKey)"
        >
          <Check v-if="copied === userCopyKey" class="size-3 text-success" />
          <Copy v-else class="size-3" />
        </Button>
        <Button
          v-if="canEdit && !isSessionActive"
          variant="ghost"
          size="icon"
          class="size-6 text-subtle hover:text-fg"
          :title="t('panel.message.editReplace')"
          @click="startEdit"
        >
          <Pencil class="size-3" />
        </Button>
      </div>
    </div>

    <!-- assistant 区：背景融为一体，透明无边框 -->
    <div class="flex flex-col gap-0 self-stretch">
      <!--
        turn-meta：有 assistant 回复即显示（回合级耗时 + working 指示），左对齐收缩（self-start，
        对齐设计稿 align-self:flex-start —— 按钮宽度=内容宽度，hover 背景不撑满整行）。
        顺序：working 态行首脉冲点 → 「已工作/工作中 Xs」→ chevron（完成态有可折叠内容时）→ badge
        - chevron 折叠入口在 elapsed 之后、badge 之前（紧贴耗时，语义为「展开详情」入口）
        - working 态：行首脉冲点 + 禁用点击（trace 由 isWorking 强制展开）
        - 完成态 + 无 foldable：无 chevron，纯展示耗时
      -->
      <!-- turn-meta + hr 包在同一 sticky wrapper：working 态贴顶时两者一起固定，
           与完成态共用同一条 hr（完成态 wrapper 无 sticky 无底色，纯结构占位）。
           底色在 wrapper 上（block 撑满全宽）而非 Button（w-fit 太窄遮不住整行），
           用 --panel-bg（Panel 注入，随 panel 状态变化）不透明遮挡滚动文字。 -->
      <div
        v-if="turn.assistants.length > 0"
        :class="turn.isWorking ? 'sticky top-0 z-[1] bg-[var(--panel-bg,var(--surface))]' : ''"
      >
      <Button
        variant="ghost"
        size="sm"
        class="turn-meta h-auto w-fit items-center justify-start gap-2.5 self-start px-1 py-1 font-sans text-[12px] font-medium transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="[
          !turn.hasFoldable
            ? 'cursor-default hover:text-muted'
            : 'cursor-pointer hover:text-fg',
        ]"
        :disabled="turn.isWorking || !turn.hasFoldable"
        @click="expanded = !expanded"
      >
        <!-- working 态：spinner（更显眼的 streaming 指示），替代原脉冲点 -->
        <Loader2 v-if="turn.isWorking" class="size-3 shrink-0 animate-spin text-accent" />
        <span class="text-[12px] font-medium">
          <span class="lbl" :class="turn.isWorking ? 'text-accent' : 'text-muted'">{{ turn.isWorking ? t('panel.message.thinking') : t('panel.message.worked') }}</span>
          <span class="elapsed font-mono font-medium tracking-[0.01em] text-fg">{{ elapsed }}</span>
        </span>
        <!-- chevron 紧跟耗时（展开/收起 trace 入口），在 badge 之前 -->
        <ChevronRight
          v-if="turn.hasFoldable && !turn.isWorking"
          class="chev size-[9px] text-subtle transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="expanded ? 'rotate-90 text-accent' : ''"
        />
        <span v-if="thinkCount > 0" class="badge badge-think inline-flex items-center gap-1 rounded-full bg-reasoning-soft px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.02em] text-reasoning">
          <Brain class="size-2.5" />{{ t('panel.message.thinkCount', { count: thinkCount }) }}
        </span>
        <span v-if="toolCount > 0" class="badge badge-tool inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.02em] text-info">
          <Wrench class="size-2.5" />{{ t('panel.message.toolCount', { count: toolCount }) }}
        </span>
      </Button>
      <hr class="border-0 border-t border-border" />
      </div>

      <!-- 折叠 trace：working 或 expanded 时展开。
           块按 contentBlocks 真实时序渲染（draft §4：7 类块按真实时序排列）。
           - streaming 态：所有块按时序展开，trace 末尾追加独立光标行（永远在最后一行）
           - complete 态：末位 assistant 的 text 块跳过（已在底部 summary），其余按时序 -->
      <div v-if="showTrace" class="trace mt-1 mb-1 flex flex-col">
        <template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
          <Block
            v-for="(blk, bIdx) in traceBlocks(assistant, aIdx)"
            :key="`${assistant.id}-${blk.kind}-${bIdx}`"
            :type="blk.kind"
            :content="blk.kind === 'text' ? (blk.ref as string) : blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).content : undefined"
            :tool="blk.kind === 'tool' ? (blk.ref as ToolCall) : undefined"
            :collapsed="blk.kind === 'thinking' ? (blk.ref as ThinkingBlock).collapsed : undefined"
            :working="turn.isWorking"
            :session-id="sessionId"
          />
        </template>
      </div>

      <!-- hr 已移入上方 turn-meta sticky wrapper（working/完成态共用，避免 streaming 时双线） -->

      <!-- 收尾 summary：streaming 和 complete 态都渲染（draft §4 收尾位固定不折叠，作回合焦点）。
           streaming 态末位 text 在此实时展示 + 末尾光标；complete 态光标消失仅文本。
           traceBlocks 对末位 assistant 始终跳过 text 块——text 从头到尾只在此位渲染，
           消除停止时从 trace(12.5px/muted) → summary(13.5px/fg) 的样式跳变。
           字号/行高/字体 streaming 与 complete 一致；streaming 时颜色用 muted（偏淡），complete 用 fg。 -->
      <div
        v-if="summaryText"
        class="turn-summary group/ai pt-3 text-[13.5px] leading-7 transition-colors duration-200"
        :class="turn.isWorking ? 'text-muted' : 'text-fg'"
      >
        <MarkdownRenderer :content="summaryText" :session-id="sessionId" />
        <!-- streaming 光标：行内闪烁竖条，紧跟 summary 末尾。
             原 trace 末尾独立 streaming-tail 移入此处（text 已在 summary 位，光标跟随 text）。 -->
        <span v-if="turn.isWorking" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
        <!-- hover actions：复制 / 复制为 MD（常驻）+ fork（仅 AI 停止时）。
           与 user 区一致（Turn.vue:76,90）：容器不守 isSessionActive，fork 单独守卫。 -->
        <div
          v-if="lastAssistant"
          class="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/ai:opacity-100 group-focus-within/ai:opacity-100"
        >
          <Button
            variant="ghost"
            size="icon"
            class="size-6 text-subtle hover:text-fg"
            :title="t('panel.message.copy')"
            @click="copy(summaryText, aiCopyKey)"
          >
            <Check v-if="copied === aiCopyKey" class="size-3 text-success" />
            <Copy v-else class="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="relative size-6 text-subtle hover:text-fg"
            :title="t('panel.message.copyMarkdown')"
            @click="copy(assistantToMarkdown(lastAssistant), aiMdKey)"
          >
            <Check v-if="copied === aiMdKey" class="size-3 text-success" />
            <Copy v-else class="size-3" />
            <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[10px] font-bold leading-[10px] text-white">MD</span>
          </Button>
          <Button
            v-if="!isSessionActive && !isSubagentVirtualId(sessionId)"
            variant="ghost"
            size="icon"
            class="size-6 text-subtle hover:text-fg"
            :title="t('panel.message.forkToOther')"
            @click="openFork"
          >
            <GitFork class="size-3" />
          </Button>
        </div>
      </div>

      <!-- 变更集卡（W10，ADR-0024）：最后一条 assistant 有 fileChanges 时渲染 -->
      <ChangeSetCard
        v-if="changeSetFileChanges.length > 0"
        class="mt-2"
        :file-changes="changeSetFileChanges"
        :status="changeSetStatus"
        :session-id="sessionId"
      />
    </div>

    <!-- fork 确认弹窗（问题 6） -->
    <ForkConfirmModal v-model:open="forkOpen" @confirm="onForkConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Brain, Check, ChevronRight, Copy, GitFork, Loader2, Pencil, Wrench } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { MessageTurn, OrderedBlock } from '@/composables/logic/messageTurns'
import { countThinking, countToolCalls, expandAssistantBlocks } from '@/composables/logic/messageTurns'
import type { ThinkingBlock, ToolCall, Message } from '@xyz-agent/shared'
import { assistantToMarkdown } from '@/composables/logic/messageFormat'
import ChangeSetCard from './ChangeSetCard.vue'
import { useCopy } from '@/composables/effects/useCopy'
import { useChat } from '@/composables/features/useChat'
import { useChatStore } from '@/stores/chat'
import { useCommandStore } from '@/stores/command'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { useSidebar } from '@/composables/features/useSidebar'
import { isSubagentVirtualId } from '@/stores/subagent'
import { useTurnElapsed } from '@/composables/panel/useTurnElapsed'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import Block from './Block.vue'
import ForkConfirmModal from './ForkConfirmModal.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = defineProps<{
  turn: MessageTurn
  /** Turn 所在 session（fork 源，双 panel standby 场景不能依赖全局 activeId） */
  sessionId: string
  /** 该 user 是否可编辑（仅当前 session 最后一条 user，避免编辑中间 user 丢失其后对话） */
  canEdit?: boolean
}>()

const { t } = useI18n()
const chat = useChatStore()
const { editAndResend } = useChat()
const { forkSession } = useSidebar()
const { open: openDrawer } = useSideDrawer()
const commandStore = useCommandStore()

/** 点击用户气泡 slash chip → 打开 drawer Doc tab 展示命令/skill 文档 */
function openCommandDoc(commandName: string): void {
  openDrawer('doc', { commandName })
}

/**
 * 用户气泡 slash 命令检测：content 以已知 slash 命令开头（如 /commit）时，
 * 渲染 composer 同款 chip（icon + 紫色底）+ 命令名后的剩余文本。
 * slash chip 发送时被 getText 扁平化为纯文本（/commit），此处从 command store
 * 解析回 icon（SSOT：与选择框/chip 同源），不改 Message 协议。
 * 匹配规则：content 以 command.name 开头，且其后是空格或字符串结束（避免 /co 误命中 /commit）。
 */
const slashChip = computed(() => {
  const content = props.turn.user?.content ?? ''
  if (!content.startsWith('/')) return null
  const commands = commandStore.getCommands(props.sessionId)
  // 取最长匹配（避免 /commit 命中 /c）：按 name 长度降序
  const matched = commands
    .filter((c) => content === c.name || content.startsWith(c.name + ' '))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (!matched) return null
  const rest = content.slice(matched.name.length).trim()
  const iconComp = SLASH_ICON_COMPONENTS[matched.icon as keyof typeof SLASH_ICON_COMPONENTS] ?? SLASH_ICON_COMPONENTS.wrench
  return { name: matched.name, rest, iconComp }
})

/**
 * skill badge 检测：从 pi 返回的消息含 skillName 字段时（<skill> 标签已由 message-converter 解析），
 * 渲染为紫色 badge（star icon + /skill:xxx），点击打开 drawer Doc tab 展示 SKILL.md。
 * 与 slashChip 互斥：skillName 优先（pi 解析的权威数据），无 skillName 时走原 slashChip 逻辑。
 */
const skillChip = computed(() => {
  const skillName = props.turn.user?.skillName
  if (!skillName) return null
  return {
    name: `/skill:${skillName}`,
    rest: props.turn.user?.content ?? '',
    iconComp: SLASH_ICON_COMPONENTS.star,
  }
})

/** 合并 skillChip 和 slashChip：skillName 优先 */
const displayChip = computed(() => skillChip.value ?? slashChip.value)

/**
 * [W7] 本 turn 所属 session 是否活跃（流式/派发空窗期）——per-session，替代全局 isGenerating。
 * standby panel 的 Turn 不会被 active panel 的流式态误伤；编辑/fork 仅在本 session 活跃时禁用。
 */
const isSessionActive = computed(() => chat.isActive(props.sessionId))

/**
 * pending user 气泡（draft-composer-states S7）：steer/followup 已入队 pi 但未投递。
 * isPendingUser 判定 status==='pending'；pending 配色/文案按 sendMode 区分（steer 蓝/followUp 青）。
 */
const isPendingUser = computed(
  () => !!props.turn.user && props.turn.user.status === 'pending',
)
/** steer → accent 蓝（追加当前回合）；follow-up → info 青（回合后新轮）。draft §pending-bubble 同族 */
const isSteerMode = computed(() => props.turn.user?.sendMode === 'steer')
const pendingBubbleClass = computed(() =>
  isSteerMode.value
    ? 'border-[var(--accent)] bg-accent-soft'
    : 'border-info bg-info-soft',
)
const pendingLabelClass = computed(() => (isSteerMode.value ? 'text-accent' : 'text-info'))
const pendingDotClass = computed(() => (isSteerMode.value ? 'bg-accent' : 'bg-info'))
const pendingLabel = computed(() => (isSteerMode.value ? t('panel.queue.steerLabel') : t('panel.queue.followupLabel')))

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

/** working 或 expanded 时展开 trace */
const expanded = ref(false)
const showTrace = computed(() => props.turn.isWorking || expanded.value)

/**
 * 工作耗时 live 计时（提取至 useTurnElapsed composable，纯计时关注点）。
 * 完成回调：isWorking true→false 时复位折叠态（自动收起成一行 meta）。
 */
const { elapsed } = useTurnElapsed(
  () => props.turn.assistants,
  () => props.turn.isWorking,
  () => {
    expanded.value = false
  },
)

/** 最后一条 assistant（收尾 summary + MD 复制 + fork 的目标消息） */
const lastAssistant = computed(() => {
  const as = props.turn.assistants
  return as[as.length - 1] ?? null
})

/** 变更集卡（W10）：最后一条 assistant 的 fileChanges + store 里的变更集状态 */
const changeSetFileChanges = computed(() => lastAssistant.value?.fileChanges ?? [])
const changeSetStatus = computed(() => {
  const msg = lastAssistant.value
  if (!msg) return undefined
  return chat.getChangeSetStatus(props.sessionId, msg.id)
})

/** 复制反馈：复用 useCopy composable（单一真相源） */
const { copied, copy } = useCopy()
const userCopyKey = computed(() => `user-${props.turn.user?.id ?? props.turn.index}`)
const aiCopyKey = computed(() => `ai-${props.turn.index}`)
const aiMdKey = computed(() => `md-${props.turn.index}`)

/* ── 编辑（= fork）：编辑 user 消息后 fork 新会话 ── */
const editingUserId = ref<string | null>(null)
const draftText = ref('')
const isEditingThisUser = computed(
  () => !!props.turn.user && editingUserId.value === props.turn.user.id,
)

function startEdit(): void {
  if (!props.turn.user) return
  editingUserId.value = props.turn.user.id
  draftText.value = props.turn.user.content
}

function cancelEdit(): void {
  editingUserId.value = null
}

async function submitEdit(): Promise<void> {
  const user = props.turn.user
  if (!user) return
  const text = draftText.value.trim()
  if (!text) return
  editingUserId.value = null
  // 原地替换语义（非 fork）：截断该 user（含）及其后 → appendUser 新文本 → 重新发送
  await editAndResend(props.sessionId, user.id, text)
}

/* ── fork modal：clone+fork 到另一 panel ── */
const forkOpen = ref(false)

function openFork(): void {
  forkOpen.value = true
}

async function onForkConfirm(): Promise<void> {
  forkOpen.value = false
  const msg = lastAssistant.value
  if (!msg) return
  // includeFrom=true：保留到该 assistant（含）；openInStandby：打开另一 panel
  await forkSession(props.sessionId, msg.id, { includeFrom: true, openInStandby: true })
}

/**
 * 收尾 summary：仅最后一条 assistant.content（draft §4：收尾位固定不折叠，作回合焦点）。
 * streaming 态 text 不在此显示（在 trace 内按真实时序展示，见 traceBlocks），
 * 模板已用 `v-if="summaryText && !turn.isWorking"` 守卫；此处仅提供文本。
 */
const summaryText = computed(() => {
  const as = props.turn.assistants
  const last = as[as.length - 1]
  return last?.content?.trim() ? last.content : ''
})

/** 最后一条 assistant 的索引（streaming 光标 / complete 跳过末位 text 用） */
const lastAssistantIdx = computed(() => props.turn.assistants.length - 1)

/**
 * 取某条 assistant 在 trace 内应渲染的有序块（draft §4：按真实时序）。
 * - 末位 assistant：始终跳过 text 块（text 在底部 summary 位渲染，streaming 带 cursor / complete 终态），
 *   trace 只保留 thinking/tool 过程。
 * - 非末位 assistant：全部块按时序（中间 text 作为过程性信息保留）。
 * 消除停止时 text 从 trace(12.5px/muted) → summary(13.5px/fg) 的样式跳变。
 */
function traceBlocks(msg: Message, idx: number): OrderedBlock[] {
  const blocks = expandAssistantBlocks(msg)
  if (idx === lastAssistantIdx.value) {
    return blocks.filter((b) => b.kind !== 'text')
  }
  return blocks
}

/**
 * streaming 光标已移到 trace 末尾独立元素（见模板 streaming-tail），
 * 不再按块判定。保留 lastAssistantIdx 供 traceBlocks 的 complete 态跳过末位 text 使用。
 */
</script>
