<template>
  <div class="chat-input-wrap">
    <SlashMenu
      :visible="slashVisible"
      :commands="filteredCommands"
      @close="closeSlashMenu"
      @select="handleSlashSelect"
    />
    <div class="chat-input-container">
      <!-- Command/Skill 标签栏 -->
      <div v-if="activeCommand" class="skill-tag-bar">
        <div
          :class="[
            'skill-tag',
            activeCommand.source === 'builtin' ? 'skill-tag--cmd' : 'skill-tag--sk'
          ]"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="skill-tag__name">/{{ activeCommand.name }}</span>
          <span class="skill-tag__close" @click="clearCommand">&times;</span>
        </div>
      </div>
      <Textarea
        v-model="text"
        :placeholder="t('chat.inputPlaceholder')"
        class="chat-input-textarea"
        :rows="1"
        no-style
        @keydown="onKeyDown"
        @compositionstart="isComposing = true"
        @compositionend="onCompositionEnd"
      />
      <div class="chat-input-toolbar">
        <ModelPicker :current-model="currentModel" @select="(id) => emit('select-model', id)" />
        <div class="tb-spacer"></div>
        <Button
          v-if="isStreaming"
          variant="ghost"
          class="tb-btn tb-btn--stop"
          @click="emit('cancel')"
          :title="t('chat.stop')"
        >■</Button>
        <Button
          v-else
          variant="primary"
          class="tb-btn tb-btn--send"
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

const currentModel = computed(() => settingsStore.defaultModel)

// 合并内置命令 + skill 命令
const allCommands = computed(() =>
  mergeSkillCommands(providerStore.skills)
)

const canSend = computed(() => {
  const trimmed = text.value.trim()
  return (trimmed.length > 0 || activeCommand.value !== null) && !props.isStreaming
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
  // 统一设为 tag，等用户发送时再执行
  activeCommand.value = cmd
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
  const el = document.querySelector<HTMLTextAreaElement>('.chat-input-textarea textarea')
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 140) + 'px'
}

watch(text, () => nextTick(resizeTextarea))
</script>

<style scoped>
.chat-input-wrap {
  position: relative;
  margin: 0 auto 12px;
  flex-shrink: 0;
  max-width: 960px;
  width: 100%;
  padding: 0 24px;
}

.chat-input-container {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
  transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
  overflow: visible;
  position: relative;
  z-index: 10;
}

.chat-input-container:focus-within {
  border-color: var(--accent);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

/* skill 标签激活时边框 accent */
.chat-input-container:has(.skill-tag-bar) {
  border-color: var(--accent);
}

.chat-input-textarea {
  display: block;
  width: 100%;
  min-height: calc(1.45em * 2 + 16px);
  max-height: calc(1.45em * 10 + 16px);
  padding: 10px 14px 8px;
  border: none;
  background: transparent;
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.45;
  resize: none;
  outline: none;
}

.chat-input-textarea::placeholder {
  color: var(--muted);
}

.chat-input-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 6px;
}

/* Skill 标签栏 */
.skill-tag-bar {
  display: flex;
  padding: 8px 14px 0;
}

.skill-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 100px;
  background: var(--accent-light);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
}

.skill-tag__name {
  line-height: 1.4;
}

.skill-tag__close {
  cursor: pointer;
  margin-left: 2px;
  opacity: 0.6;
  font-size: 14px;
  line-height: 1;
}

.skill-tag__close:hover {
  opacity: 1;
}

/* CMD tag: 用 border/muted 中性配色，和 popup 里的 command tag 一致 */
.skill-tag--cmd {
  background: var(--border);
  color: var(--muted);
}

/* Toolbar buttons */
.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: all 0.15s var(--ease);
  gap: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}

.tb-btn:hover {
  background: var(--accent-light);
  color: var(--accent);
}

.tb-btn svg {
  width: 14px;
  height: 14px;
}

.tb-btn--send {
  background: var(--accent);
  color: white;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
}

.tb-btn--send:disabled {
  opacity: 0.4;
  cursor: default;
}

.tb-btn--send:not(:disabled):hover {
  opacity: 0.88;
}

.tb-btn--stop {
  font-weight: 700;
  font-size: 11px;
  width: 28px;
  height: 28px;
}

.tb-btn--stop:hover {
  background: var(--danger-light);
  color: var(--danger);
}

.tb-spacer {
  flex: 1;
}
</style>
