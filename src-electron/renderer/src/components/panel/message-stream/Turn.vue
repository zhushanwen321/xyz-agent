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
          <span class="text-[11px] text-subtle">编辑后替换并重新发送</span>
          <div class="flex gap-1.5">
            <Button variant="ghost" size="sm" class="h-7" @click="cancelEdit">取消</Button>
            <Button variant="default" size="sm" class="h-7 gap-1" :disabled="!draftText.trim()" @click="submitEdit">
              <ArrowRight class="size-3.5" /> 发送
            </Button>
          </div>
        </div>
      </div>
      <!-- 展示态气泡：右下尖角（user content 走 markdown 渲染；slash 命令前缀渲染为 chip） -->
      <!-- whitespace-pre-wrap：markdown.ts breaks:false 不把单 \n 转 <br>，
           此处用 CSS 保留软换行，兑现"用户输入的换行在气泡里可见"。
           代码块 <pre> 自带 white-space:pre，不受影响。仅用户气泡加，不影响 assistant。 -->
      <div
        v-else
        class="max-w-[76%] rounded-[14px_14px_4px_14px] border border-border-strong bg-surface-hover px-[13px] py-[9px] text-[13.5px] leading-[1.55] text-fg whitespace-pre-wrap"
      >
        <!-- slash 命令 chip（与 composer 同款紫色 chip + source icon），后接剩余文本 -->
        <!-- slash 命令 chip（与 composer 同款紫色 chip + source icon），可点击在 drawer 查看文档。
             Button as-child 让 reka-ui Primitive 合并到 span，保留 chip 行内样式 + 按钮语义 -->
        <Button
          v-if="slashChip"
          as-child
          variant="ghost"
          title="查看命令文档"
          @click.stop="openCommandDoc(slashChip.name)"
        >
          <span
            class="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--reasoning-soft)] px-1.5 py-px font-mono text-[12px] font-medium leading-[1.4] text-reasoning transition-colors hover:bg-[color-mix(in_oklch,var(--reasoning)_32%,transparent)]"
          >
            <component :is="slashChip.iconComp" class="size-[12px] shrink-0" />
            <span>{{ slashChip.name }}</span>
          </span>
        </Button>
        <MarkdownRenderer v-if="!slashChip || slashChip.rest" :content="slashChip ? slashChip.rest : turn.user.content" :session-id="sessionId" />
      </div>
      <!-- hover actions：复制常驻 hover；编辑仅 AI 停止（isStreaming=false）时显示 -->
      <div
        v-if="!isEditingThisUser"
        class="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-6 text-subtle hover:text-fg"
          title="复制"
          @click="copy(turn.user.content, userCopyKey)"
        >
          <Check v-if="copied === userCopyKey" class="size-3 text-success" />
          <Copy v-else class="size-3" />
        </Button>
        <Button
          v-if="canEdit && !isStreaming"
          variant="ghost"
          size="icon"
          class="size-6 text-subtle hover:text-fg"
          title="编辑（替换并重新发送）"
          @click="startEdit"
        >
          <Pencil class="size-3" />
        </Button>
      </div>
    </div>

    <!-- assistant 区：背景融为一体，透明无边框 -->
    <div class="flex flex-col gap-0 self-stretch">
      <!-- turn-meta：有可折叠块才显示按钮；working 态用脉冲点 -->
      <Button
        v-if="turn.hasFoldable"
        variant="ghost"
        size="sm"
        class="turn-meta h-auto justify-start gap-2.5 rounded-none px-1 py-1 font-sans text-[12.5px] font-medium text-muted transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:text-fg"
        :class="turn.isWorking ? 'cursor-default hover:text-muted' : 'cursor-pointer'"
        :disabled="turn.isWorking"
        @click="expanded = !expanded"
      >
        <ChevronRight
          v-if="!turn.isWorking"
          class="chev size-[9px] text-subtle transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="expanded ? 'rotate-90 text-accent' : ''"
        />
        <span v-else class="working-dot size-[7px] flex-shrink-0 rounded-full bg-accent animate-working-pulse" />
        <span class="text-[12.5px] font-medium">
          <span class="lbl text-muted">{{ turn.isWorking ? '工作中' : '已工作' }}</span>
          <span class="elapsed font-mono font-medium tracking-[0.01em] text-fg">{{ elapsed }}</span>
        </span>
        <span v-if="thinkCount > 0" class="badge badge-think inline-flex items-center gap-1 rounded-full bg-[rgba(167,139,250,0.12)] px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.02em] text-reasoning">
          <Brain class="size-2.5" />思考 ×{{ thinkCount }}
        </span>
        <span v-if="toolCount > 0" class="badge badge-tool inline-flex items-center gap-1 rounded-full bg-[rgba(56,189,248,0.12)] px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.02em] text-info">
          <Wrench class="size-2.5" />工具 ×{{ toolCount }}
        </span>
      </Button>

      <!-- 折叠 trace：working 或 expanded 时展开 -->
      <div v-if="showTrace" class="trace mt-1 mb-1 flex flex-col">
        <template v-for="(assistant, aIdx) in turn.assistants" :key="assistant.id">
          <Block
            v-if="isMidAssistant(aIdx) && assistant.content.trim()"
            type="text"
            :content="assistant.content"
            :session-id="sessionId"
          />
          <Block
            v-for="th in assistant.thinking ?? []"
            :key="`th-${th.id}`"
            type="thinking"
            :content="th.content"
            :collapsed="th.collapsed"
            :working="turn.isWorking"
          />
          <Block
            v-for="tc in assistant.toolCalls ?? []"
            :key="`tc-${tc.id}`"
            type="tool"
            :tool="tc"
            :working="turn.isWorking"
          />
        </template>
      </div>

      <hr v-if="turn.hasFoldable || turn.assistants.length > 0" class="border-0 border-t border-border" />

      <!-- 收尾 summary：仅最后一条 assistant.content，含 hover 复制/复制MD/fork（markdown 渲染） -->
      <div v-if="summaryText" class="turn-summary group/ai pt-3 text-[13.5px] leading-7 text-fg">
        <MarkdownRenderer :content="summaryText" :session-id="sessionId" />
        <span v-if="isStreamingText" class="streaming-cursor ml-0.5 inline-block h-3.5 w-[7px] translate-y-[3px] rounded-[1px] bg-accent align-text-bottom animate-blink" />
        <!-- hover actions：复制 / 复制为 MD / fork（仅 AI 停止时） -->
        <div
          v-if="!isStreaming && lastAssistant"
          class="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/ai:opacity-100"
        >
          <Button
            variant="ghost"
            size="icon"
            class="size-6 text-subtle hover:text-fg"
            title="复制"
            @click="copy(summaryText, aiCopyKey)"
          >
            <Check v-if="copied === aiCopyKey" class="size-3 text-success" />
            <Copy v-else class="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="relative size-6 text-subtle hover:text-fg"
            title="复制为 Markdown"
            @click="copy(assistantToMarkdown(lastAssistant), aiMdKey)"
          >
            <Check v-if="copied === aiMdKey" class="size-3 text-success" />
            <Copy v-else class="size-3" />
            <span class="absolute -right-0.5 -top-0.5 rounded-sm bg-accent px-[3px] text-[8px] font-bold leading-[10px] text-white">MD</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="size-6 text-subtle hover:text-fg"
            title="克隆并分叉到另一面板"
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
      />
    </div>

    <!-- fork 确认弹窗（问题 6） -->
    <ForkConfirmModal v-model:open="forkOpen" @confirm="onForkConfirm" />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ArrowRight, Brain, Check, ChevronRight, Copy, GitFork, Pencil, Wrench } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { countThinking, countToolCalls } from '@/composables/logic/messageTurns'
import { assistantToMarkdown } from '@/composables/logic/messageFormat'
import ChangeSetCard from './ChangeSetCard.vue'
import { useCopy } from '@/composables/effects/useCopy'
import { useChat } from '@/composables/features/useChat'
import { useChatStore } from '@/stores/chat'
import { useCommandStore } from '@/stores/command'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { useSidebar } from '@/composables/features/useSidebar'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import Block from './Block.vue'
import ForkConfirmModal from './ForkConfirmModal.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

/** 时间格式化常量（elapsed 计算） */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const SEC_PAD_WIDTH = 2

const props = defineProps<{
  turn: MessageTurn
  /** Turn 所在 session（fork 源，双 panel standby 场景不能依赖全局 activeId） */
  sessionId: string
  /** 该 user 是否可编辑（仅当前 session 最后一条 user，避免编辑中间 user 丢失其后对话） */
  canEdit?: boolean
}>()

const chat = useChatStore()
const { isStreaming } = storeToRefs(chat)
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

/** 全局流式态（当前活跃 session）：streaming 时禁编辑/fork */
// isStreaming 来自 storeToRefs（上）

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

/** working 或 expanded 时展开 trace */
const expanded = ref(false)
const showTrace = computed(() => props.turn.isWorking || expanded.value)

/**
 * 工作耗时：working 态 live 计时（setInterval 每秒重算 now-firstTs），
 * 完成态静态（lastTs-firstTs）。watch isWorking true→false 复位 expanded + 停表。
 */
const elapsed = ref(formatElapsed())
let elapsedTimer: ReturnType<typeof setInterval> | null = null

function formatElapsed(): string {
  const as = props.turn.assistants
  if (as.length === 0) return '0s'
  const first = as[0].timestamp
  const end = props.turn.isWorking ? Date.now() : as[as.length - 1].timestamp
  const secs = Math.max(1, Math.round((end - first) / MS_PER_SEC))
  const m = Math.floor(secs / SEC_PER_MIN)
  const s = secs % SEC_PER_MIN
  return m > 0 ? `${m}m ${String(s).padStart(SEC_PAD_WIDTH, '0')}s` : `${s}s`
}

function stopElapsedTimer(): void {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
}

function startElapsedTimer(): void {
  stopElapsedTimer()
  elapsed.value = formatElapsed()
  elapsedTimer = setInterval(() => {
    elapsed.value = formatElapsed()
  }, MS_PER_SEC)
}

if (props.turn.isWorking) startElapsedTimer()

watch(
  () => props.turn.isWorking,
  (nw, old) => {
    if (old && !nw) {
      // 完成：复位折叠态（自动收起成一行 meta）+ 停表定格
      expanded.value = false
      stopElapsedTimer()
      elapsed.value = formatElapsed()
    } else if (!old && nw) {
      startElapsedTimer()
    }
  },
)

onUnmounted(stopElapsedTimer)

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
 */
const summaryText = computed(() => {
  const as = props.turn.assistants
  const last = as[as.length - 1]
  return last?.content?.trim() ? last.content : ''
})

/** 该 assistant 是否为「中间产出」（非最后一条）→ content 折进 trace 而非收尾 */
function isMidAssistant(idx: number): boolean {
  return idx < props.turn.assistants.length - 1
}

/** 最后一条 assistant 是否仍 streaming（光标） */
const isStreamingText = computed(() => {
  const last = props.turn.assistants[props.turn.assistants.length - 1]
  return props.turn.isWorking && last?.status === 'streaming'
})
</script>
