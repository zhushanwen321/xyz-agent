<template>
  <div class="relative mx-auto mb-3 shrink-0 max-w-[960px] w-full px-6" data-chat-input>
    <SlashMenu
      :visible="slashVisible"
      :commands="filteredCommands"
      @close="closeSlashMenu"
      @select="handleSlashSelect"
    />
    <div
      ref="containerRef"
      :class="[
        'bg-surface border border-border rounded shadow-xs transition-colors duration-150 ease-ease overflow-visible relative z-10 focus-within:border-accent focus-within:shadow-sm',
        activeCommand ? 'border-accent' : '',
      ]"
    >
      <!-- Command/Skill 标签栏 -->
      <div v-if="activeCommand" class="flex pt-2 px-3.5">
        <div
          :class="[
            'inline-flex items-center gap-1 py-[2px] px-2 rounded-full text-xs font-medium',
            activeCommand.source === 'builtin'
              ? 'bg-border text-muted'
              : 'bg-accent-light text-accent',
          ]"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="leading-[1.4]">/{{ activeCommand.name }}</span>
          <span class="cursor-pointer ml-0.5 opacity-60 text-sm leading-none hover:opacity-100" @click="clearCommand">&times;</span>
        </div>
      </div>
      <Textarea
        v-model="text"
    :placeholder="placeholder"
        class="block w-full min-h-[calc(1.45em*2+16px)] max-h-[calc(1.45em*10+16px)] pt-[10px] pb-2 px-3.5 border-none bg-transparent text-fg font-body text-sm leading-[1.45] resize-none outline-none placeholder:text-muted"
        :rows="1"
        no-style
        @keydown="onKeyDown"
        @compositionstart="isComposing = true"
        @compositionend="onCompositionEnd"
      />
      <div class="flex items-center gap-1 px-2 pb-1.5">
        <ModelPicker :current-model="currentModel" @select="(id) => emit('select-model', id)" />
        <div class="flex-1"></div>
        <Button
          v-if="isStreaming"
          variant="ghost"
          class="inline-flex items-center justify-center h-7 px-2 border-none rounded-xs bg-transparent text-muted text-xs font-body cursor-pointer transition-all duration-150 ease-ease gap-1 shrink-0 font-bold text-[11px] w-7 h-7 hover:bg-danger-light hover:text-danger"
          @click="emit('cancel')"
          :title="t('chat.stop')"
        >■</Button>
        <Button
          v-else
          variant="primary"
          class="bg-accent text-white w-7 h-7 rounded-xs disabled:opacity-40 disabled:cursor-default hover:opacity-88"
          :disabled="!canSend"
          @click="handleSend"
          :title="t('chat.send')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { useProviderStore } from '../../stores/provider'
import { Textarea, Button } from '../../design-system'
import ModelPicker from './ModelPicker.vue'
import SlashMenu from './SlashMenu.vue'
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
  send: [payload: { content: string; skillName?: string }]
  cancel: []
  'select-model': [modelId: string]
  'send-command': [payload: { type: string; payload: Record<string, unknown> }]
  'local-action': [payload: { action: string; data?: unknown }]
}>()

const { t } = useI18n()
const settingsStore = useSettingsStore()
const providerStore = useProviderStore()
const {
  mergeSkillCommands,
  filterCommands,
  initDefaultCommands,
} = useSlashCommands()

initDefaultCommands()

const text = ref('')
const isComposing = ref(false)
const activeCommand = ref<SlashCommand | null>(null)

// activeCommand 存在时动态展示 skill 专属提示，否则用默认 placeholder
const placeholder = computed(() => {
  if (activeCommand.value?.action.type === 'skill') {
    return activeCommand.value.argumentHint
    ? '编辑参数后发送…'
    : '输入附加文本…'
  }
  return t('chat.inputPlaceholder')
  })

const containerRef = ref<HTMLElement | null>(null)

const currentModel = computed(() => settingsStore.defaultModel)

// 合并内置命令 + skill 命令
const allCommands = computed(() =>
  mergeSkillCommands(providerStore.skills)
)

const canSend = computed(() => {
  const trimmed = text.value.trim()
  return (trimmed.length > 0 || activeCommand.value !== null) && !props.isStreaming && !props.isCompacting
})

// Slash command 状态
const slashVisible = ref(false)
const slashFilter = ref('')

const filteredCommands = computed(() =>
  filterCommands(allCommands.value, slashFilter.value)
)

watch(text, (val) => {
  if (val.startsWith('/')) {
    slashVisible.value = true
    slashFilter.value = val.slice(1)
  } else {
    slashVisible.value = false
    slashFilter.value = ''
  }
})

function closeSlashMenu() {
  slashVisible.value = false
}

function clearCommand() {
  activeCommand.value = null
  text.value = ''
}

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
  // protocol 和 local 类型命令直接执行，不需要标签确认步骤
  // skill 类型需要参数输入，保留标签
  if (cmd.action.type === 'protocol' || cmd.action.type === 'local') {
    activeCommand.value = cmd
    handleSend()
    // 执行后聚焦 textarea，确保后续输入正常
    nextTick(() => {
      const ta = containerRef.value?.querySelector<HTMLTextAreaElement>('textarea')
      ta?.focus()
    })
  } else {
  activeCommand.value = cmd
  // skill 有 argumentHint 时预填文本，用户可直接编辑
  if (cmd.action.type === 'skill' && cmd.argumentHint) {
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
      case 'local':
        cmd.action.handler(buildCommandContext())
        break
      case 'protocol':
        emit('send-command', {
          type: cmd.action.messageType,
          payload: { sessionId: props.sessionId },
        })
        break
      case 'skill': {
        const prefix = `/skill:${cmd.name}`
        const content = trimmed ? `${prefix} ${trimmed}` : prefix
        emit('send', { content, skillName: cmd.name })
        break
      }
    }
    clearCommand()
  } else {
    emit('send', { content: trimmed })
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

  if (e.key === 'Enter' && !e.shiftKey && !isComposing.value) {
    e.preventDefault()
    if (slashVisible.value) return // SlashMenu 处理 Enter
    handleSend()
  }
}

function onCompositionEnd() {
  isComposing.value = false
}

function resizeTextarea() {
  const el = containerRef.value?.querySelector<HTMLTextAreaElement>('textarea')
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 140) + 'px'
}

watch(text, () => nextTick(resizeTextarea))
</script>
