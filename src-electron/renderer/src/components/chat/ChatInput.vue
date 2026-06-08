<template>
  <div class="panel-input-area relative mx-auto mb-3 shrink-0 max-w-[960px] w-full px-6" data-chat-input>
    <GlobalLoadingBar :is-generating="isGenerating" />
    <QueueComponent :queue-state="queueState" />
    <SlashMenu
      :visible="slashVisible"
      :commands="filteredCommands"
      @close="closeSlashMenu"
      @select="handleSlashSelect"
    />
    <SendModeStatusBar
      :mode="sendMode"
      @update:mode="onModeSwitch"
    />
    <div
      ref="containerRef"
      :class="[
        'bg-surface border-2 border-transparent rounded-sm transition-colors duration-150 ease-ease overflow-visible relative z-10 focus-within:border-accent',
        activeCommand ? 'border-accent' : '',
      ]"
    >
      <!-- Input content: badge on top + textarea below, unified in one area -->
      <div class="px-3.5 pb-1 pt-2">
        <!-- Skill badge inside input area -->
        <div
          v-if="activeCommand"
          :class="[
            'inline-flex items-center gap-1 py-[2px] px-2 rounded-full text-xs font-medium mb-1',
            activeCommand.source === 'builtin'
              ? 'bg-border text-muted'
              : activeCommand.source === 'skill'
              ? 'bg-accent-light text-accent'
              : 'bg-agent-light text-agent',
          ]"
        >
          <span v-if="cmdIcon" class="text-[11px] font-bold leading-none w-[14px] text-center shrink-0">{{ cmdIcon }}</span>
          <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none" class="shrink-0">
            <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="leading-[1.4]">/{{ tagDisplayName }}</span>
          <span class="cursor-pointer ml-0.5 opacity-60 text-sm leading-none hover:opacity-100" @click="clearCommand">&times;</span>
        </div>
        <Textarea
          v-model="text"
          :placeholder="placeholder"
          class="block w-full min-h-[calc(1.45em*2+16px)] max-h-[calc(1.45em*10+16px)] border-none bg-transparent text-fg font-body text-sm leading-[1.45] resize-none outline-none placeholder:text-muted"
          :rows="1"
          no-style
          @keydown="onKeyDown"
          @compositionstart="isComposing = true"
          @compositionend="onCompositionEnd"
        />
      </div>
      <InputToolbar
        :session-id="sessionId"
        :is-streaming="isStreaming"
        :can-send="canSend"
        @select-model="(id: string) => emit('select-model', id)"
        @select-thinking-level="(l: string) => emit('send-command', { type: 'session.setThinkingLevel', payload: { sessionId, level: l } })"
        @send="handleSend"
        @cancel="emit('cancel')"
      />
    </div>
    <SessionStrip :session-id="sessionId" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '../../stores/chat'
import { useProviderStore } from '../../stores/provider'
import { Textarea } from '../../design-system'
import { consumePendingEditorText } from '../../composables/useTree'
import { on } from '../../lib/event-bus'
import SlashMenu from './SlashMenu.vue'
import InputToolbar from './InputToolbar.vue'
import SessionStrip from './SessionStrip.vue'
import SendModeStatusBar from './SendModeStatusBar.vue'
import GlobalLoadingBar from './GlobalLoadingBar.vue'
import QueueComponent from './QueueComponent.vue'
import type { SendMode } from './SendModeStatusBar.vue'
import {
  useSlashCommands,
  type SlashCommand,
  type CommandContext,
} from '../../composables/useSlashCommands'

const props = defineProps<{
  isStreaming: boolean
  isCompacting?: boolean
  sessionId: string
}>()

const emit = defineEmits<{
  send: [payload: { content: string; skillName?: string; subagent?: { agent: string; task: string }; sendMode?: 'send' | 'steer' | 'queue' }]
  cancel: []
  'select-model': [modelId: string]
  'send-command': [payload: { type: string; payload: Record<string, unknown> }]
  'local-action': [payload: { action: string; data?: unknown }]
}>()

const { t } = useI18n()
const chatStore = useChatStore()
const providerStore = useProviderStore()

// ── Per-session reactive state from store ──
const sessionState = computed(() => chatStore.getSessionState(props.sessionId))
const isGenerating = computed(() => sessionState.value.isGenerating)
const queueState = computed(() => sessionState.value.queueState)
const {
  mergeSkillCommands,
  filterCommands,
  initDefaultCommands,
  initNativeCommands,
} = useSlashCommands()

initDefaultCommands()
initNativeCommands()

// ── Pending text: persisted per session ──
const storeText = computed(() => chatStore.getPendingText(props.sessionId))
const text = ref(storeText.value || '')
onUnmounted(() => { chatStore.setPendingText(text.value || undefined, props.sessionId) })
onMounted(() => {
  text.value = storeText.value || ''
  const editorText = consumePendingEditorText(props.sessionId)
  if (editorText) text.value = editorText
})
// Sync to store on each change
watch(text, (val) => { chatStore.setPendingText(val || undefined, props.sessionId) })

const isComposing = ref(false)
const activeCommand = ref<SlashCommand | null>(null)
const isAltPressed = ref(false)
const isCtrlPressed = ref(false)

watch(() => props.sessionId, (newSid, oldSid) => {
  if (newSid !== oldSid) {
    if (oldSid) chatStore.setPendingText(text.value || undefined, oldSid)
    text.value = chatStore.getPendingText(newSid)
    nextTick(() => {
      const editorText = consumePendingEditorText(newSid)
      if (editorText) text.value = editorText
    })
  }
})
// Same-session navigate: event-driven
const unsubEditorText = on('editor-text-pending', () => {
  nextTick(() => {
    const editorText = consumePendingEditorText(props.sessionId)
    if (editorText) text.value = editorText
  })
})
onUnmounted(() => { unsubEditorText?.() })

// ── Send Mode ──
const manualMode = ref<SendMode | null>(null)

const sendMode = computed<SendMode>(() => {
  // Manual override from Mode Switcher click
  if (manualMode.value) return manualMode.value
  // Ctrl/Cmd+Enter forces steer (interrupt AI)
  if (isCtrlPressed.value) return 'steer'
  // When AI is streaming, auto-queue instead of steering
  if (props.isStreaming) return 'queue'
  // Alt+Enter always queues
  if (isAltPressed.value) return 'queue'
  return 'send'
})

function onModeSwitch(mode: SendMode) {
  // If user explicitly selected the auto-detected mode, clear override
  const autoDetect: SendMode = (isCtrlPressed.value && 'steer')
    || (props.isStreaming && 'queue')
    || (isAltPressed.value && 'queue')
    || 'send'
  manualMode.value = mode === autoDetect ? null : mode
}

// ── Modifier key detection ──
function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Alt') isAltPressed.value = true
  if (e.key === 'Control' || e.key === 'Meta') isCtrlPressed.value = true
}
function onGlobalKeyUp(e: KeyboardEvent) {
  if (e.key === 'Alt') isAltPressed.value = false
  if (e.key === 'Control' || e.key === 'Meta') isCtrlPressed.value = false
}
function onWindowBlur() {
  isAltPressed.value = false
  isCtrlPressed.value = false
}
onMounted(() => {
  document.addEventListener('keydown', onGlobalKeyDown)
  document.addEventListener('keyup', onGlobalKeyUp)
  window.addEventListener('blur', onWindowBlur)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeyDown)
  document.removeEventListener('keyup', onGlobalKeyUp)
  window.removeEventListener('blur', onWindowBlur)
})

const placeholder = computed(() => {
  if (activeCommand.value?.action.type === 'skill') {
    return activeCommand.value.argumentHint ? '编辑参数后发送…' : '输入附加文本…'
  }
  return t('chat.inputPlaceholder')
})

const cmdIcon = computed(() => {
  if (!activeCommand.value) return ''
  switch (activeCommand.value.source) {
    case 'agent': return 'A'
    case 'skill': return 'S'
    default: return ''
  }
})

const tagDisplayName = computed(() => {
  if (!activeCommand.value) return ''
  const name = activeCommand.value.source === 'agent'
    ? activeCommand.value.name.replace(/^agent:/, '')
    : activeCommand.value.name
  return name
})

const containerRef = ref<HTMLElement | null>(null)

const canSend = computed(() => {
  if (props.isCompacting) return false
  const trimmed = text.value.trim()
  return trimmed.length > 0 || activeCommand.value !== null
})

// 合并内置命令 + skill 命令
const allCommands = computed(() =>
  mergeSkillCommands(providerStore.skills, providerStore.agents)
)

// Slash command 状态
const slashVisible = ref(false)
const slashFilter = ref('')

const filteredCommands = computed(() =>
  filterCommands(allCommands.value, slashFilter.value)
)

watch(text, (val) => {
  if (activeCommand.value) return
  if (val.startsWith('/')) { slashVisible.value = true; slashFilter.value = val.slice(1) }
  else { slashVisible.value = false; slashFilter.value = '' }
})

function closeSlashMenu() { slashVisible.value = false }

function clearCommand() { activeCommand.value = null; text.value = '' }

// 构建 CommandContext，供 local 类型命令使用
function buildCommandContext(): CommandContext {
  return {
    sessionId: props.sessionId,
    getAllCommands: () => allCommands.value,
    onLocalAction: (action, data) => emit('local-action', { action, data }),
  }
}

function handleSlashSelect(cmd: SlashCommand) {
  text.value = ''
  slashVisible.value = false
  if (cmd.action.type === 'protocol' || cmd.action.type === 'local' || cmd.action.type === 'native') {
    activeCommand.value = cmd
    handleSend()
    nextTick(() => containerRef.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
  } else {
    activeCommand.value = cmd
    if (cmd.action.type === 'agent') {
      text.value = ''
      nextTick(() => {
        slashVisible.value = false
        containerRef.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
      })
    } else if (cmd.action.type === 'skill' && cmd.argumentHint) {
      text.value = cmd.argumentHint
    }
  }
}

function handleSend() {
  if (!canSend.value) return
  const trimmed = text.value.trim()

  if (activeCommand.value) {
    const cmd = activeCommand.value
    switch (cmd.action.type) {
      case 'local': cmd.action.handler(buildCommandContext()); break
      case 'protocol': emit('send-command', { type: cmd.action.messageType, payload: { sessionId: props.sessionId } }); break
      case 'skill': {
        const prefix = `/skill:${cmd.name}`
        emit('send', { content: trimmed ? `${prefix} ${trimmed}` : prefix, skillName: cmd.name })
        break
      }
      case 'agent': {
        const agentName = cmd.action.agentName
        const taskContent = trimmed.startsWith(`/agent:${agentName}`)
          ? trimmed.slice(`/agent:${agentName}`.length).trim() : trimmed
        emit('send', { content: trimmed || '', subagent: { agent: agentName, task: taskContent } })
        break
      }
      case 'extension': emit('send', { content: `/${cmd.action.commandName} ${trimmed}`.trim() }); break
      case 'native': {
        const content = trimmed ? `/${cmd.action.commandName} ${trimmed}` : `/${cmd.action.commandName}`
        emit('send', { content })
        break
      }
    }
    clearCommand()
  } else {
    const payload = { content: trimmed, sendMode: sendMode.value }
    emit('send', payload)
    manualMode.value = null
  }
  text.value = ''
  slashVisible.value = false
  nextTick(resizeTextarea)
}

function onKeyDown(e: KeyboardEvent) {
  // Slash menu 打开时，让 SlashMenu 处理导航键
  if (slashVisible.value && ['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) {
    return
  }

  // Bypass isComposing for modifier-key combos (macOS dead-key workaround)
  if (e.key === 'Enter' && !e.shiftKey && (!isComposing.value || e.altKey || e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    if (slashVisible.value) return // SlashMenu 处理 Enter
    handleSend()
  }
}

function onCompositionEnd() { isComposing.value = false }

const TEXTAREA_MAX_HEIGHT = 140

function resizeTextarea() {
  const el = containerRef.value?.querySelector<HTMLTextAreaElement>('textarea')
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px'
}

watch(text, () => nextTick(resizeTextarea))
</script>
