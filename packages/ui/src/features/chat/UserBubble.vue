<template>
  <!--
    UserBubble：用户气泡（展示态/编辑态/pending态 + skill/file/image badge + hover actions）。
    从 Turn.vue 拆出。emit edit-state-change 通知父组件 pinEditing。
  -->
  <!-- user 区：编辑态切 textarea，展示态气泡 + hover actions -->
  <div class="group/user flex flex-col items-end gap-1">
    <!-- 编辑态：编辑后 fork 新会话 -->
    <div
      v-if="isEditingThisUser"
      class="w-full max-w-[76%] rounded-[14px] border border-accent bg-bg-input p-2 shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_22%,transparent)]"
    >
      <Textarea v-model="draftText" class="min-h-[64px] border-0 bg-transparent px-1 text-[length:var(--text-base)] leading-[1.55] focus-visible:ring-0" />
      <div class="mt-1.5 flex items-center justify-between px-1">
        <span class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.message.editAfterReplace') }}</span>
        <div class="flex gap-1.5">
          <Button variant="ghost" size="sm" class="h-7" @click="cancelEdit">{{ t('panel.message.cancel') }}</Button>
          <Button variant="default" size="sm" class="h-7 gap-1" :disabled="!draftText.trim()" @click="submitEdit">
            <ArrowRight class="size-3.5" /> {{ t('panel.composer.send') }}
          </Button>
        </div>
      </div>
    </div>
    <!-- pending 气泡（draft-composer-states S7）：steer/followup 已入队未投递 -->
    <div
      v-else-if="isPendingUser"
      class="max-w-[76%] rounded-[14px_14px_4px_14px] border border-dashed px-[13px] py-[9px] text-[length:var(--text-base)] leading-[1.55] text-neutral-fg whitespace-pre-wrap"
      :class="pendingBubbleClass"
    >
      <span class="mb-1 flex items-center gap-1.5 font-mono text-[length:var(--text-2xs)] font-semibold tracking-wider"
        :class="pendingLabelClass"
      >
        <span class="size-[6px] animate-pulse-accent rounded-full" :class="pendingDotClass" />
        {{ pendingLabel }}
      </span>
      <span>{{ normalizeContent(turn.user!.content) }}</span>
    </div>
    <!-- 展示态气泡 -->
    <div
      v-else
      class="max-w-[76%] rounded-[14px_14px_4px_14px] border border-border-strong bg-[var(--bubble-bg)] px-[13px] py-[9px] text-[length:var(--text-base)] leading-[1.55] text-neutral-fg"
    >
      <template v-for="(seg, i) in userSegments" :key="i">
        <span
          v-if="seg.type === 'skill'"
          class="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--reasoning-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-reasoning transition-colors hover:bg-[color-mix(in_oklch,var(--reasoning)_32%,transparent)]"
          style="vertical-align: middle"
          role="button"
          tabindex="0"
          :title="t('panel.message.viewCommandDoc')"
          @click.stop="openCommandDoc(`/skill:${seg.name}`)"
          @keydown.enter.stop.prevent="openCommandDoc(`/skill:${seg.name}`)"
          @keydown.space.stop.prevent="openCommandDoc(`/skill:${seg.name}`)"
        >
          <component :is="SLASH_ICON_COMPONENTS.star" class="size-[12px] shrink-0" />
          <span>{{ seg.name }}</span>
        </span>
        <span
          v-else-if="seg.type === 'file'"
          class="mr-1 inline-flex cursor-pointer items-center gap-1 rounded-sm bg-[var(--success-soft)] px-1.5 py-px font-mono text-[length:var(--text-sm)] font-medium leading-[1.4] text-success transition-colors hover:bg-[color-mix(in_oklch,var(--success)_32%,transparent)]"
          style="vertical-align: middle"
          role="button"
          tabindex="0"
          :data-testid="`msg-file-badge-${i}`"
          :title="seg.path"
          @click.stop="openFileDetail(seg.path)"
          @keydown.enter.stop.prevent="openFileDetail(seg.path)"
          @keydown.space.stop.prevent="openFileDetail(seg.path)"
        >
          <FileText class="size-[12px] shrink-0" />
          <span>{{ fileBasename(seg.path) }}{{ formatLineRange(seg.lineRange) }}</span>
        </span>
        <ImageThumb
          v-else-if="seg.type === 'image'"
          :path="seg.path"
          :display-name="seg.displayName"
        />
        <MarkdownRenderer v-else-if="seg.type === 'text' && seg.text" :content="seg.text" :session-id="sessionId" />
      </template>
      <MarkdownRenderer v-if="!userSegments.length && typeof turn.user?.content === 'string'" :content="turn.user!.content" :session-id="sessionId" />
    </div>
    <!-- hover actions：复制常驻 hover；编辑仅 AI 停止（非活跃态）时显示。pending 不显示。 -->
    <div
      v-if="!isEditingThisUser && !isPendingUser"
      class="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 group-focus-within/user:opacity-100"
    >
      <Button
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.copy')"
        @click="copy(normalizeContent(turn.user!.content), userCopyKey)"
      >
        <Check v-if="copied === userCopyKey" class="size-3 text-success" />
        <Copy v-else class="size-3" />
      </Button>
      <Button
        v-if="canEdit && !isSessionEditable"
        variant="ghost"
        size="icon"
        class="size-6 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.message.editReplace')"
        @click="startEdit"
      >
        <Pencil class="size-3" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Copy, FileText, Pencil } from '@lucide/vue'
import { Button, Textarea } from '@xyz-agent/ui'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import type { Segment } from '@xyz-agent/shared'
import { normalizeContent } from '@xyz-agent/shared'
import { rebuildSegmentsWithEditedText } from '../../lib/segment-rebuild'
import { useCopy } from './composables/useCopy'
import { SLASH_ICON_COMPONENTS } from './slash-icons'
import { useChatViewDeps } from './chat-view-deps'
import ImageThumb from './ImageThumb.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    sessionId: string
    canEdit?: boolean
    isSessionEditable?: boolean
  }>(),
  { canEdit: false, isSessionEditable: false },
)

const emit = defineEmits<{
  'edit-state-change': [{ editing: boolean }]
}>()

const { t } = useI18n()
const { editAndResend, openDrawer, onFileClick } = useChatViewDeps()

/** 点击 skill badge → 打开 drawer Doc tab */
function openCommandDoc(commandName: string): void {
  openDrawer('doc', { commandName })
}

/** 点击 file badge → 打开 drawer Detail tab */
function openFileDetail(path: string): void {
  onFileClick(path)
  openDrawer('detail', { filePath: path })
}

/** file badge 行范围后缀 */
function formatLineRange(lineRange?: [number, number]): string {
  if (!lineRange) return ''
  const [s, e] = lineRange
  return s === e ? `:L${s}` : `:L${s}-L${e}`
}

/** file badge 显示名：路径末段 */
function fileBasename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** user message 的 content segments */
const userSegments = computed<Segment[]>(() => {
  const content = props.turn.user?.content
  if (Array.isArray(content)) return content
  return []
})

/**
 * pending user 气泡：steer/followup 已入队 pi 但未投递。
 */
const isPendingUser = computed(
  () => !!props.turn.user && props.turn.user.status === 'pending',
)
const isSteerMode = computed(() => props.turn.user?.sendMode === 'steer')
const pendingBubbleClass = computed(() =>
  isSteerMode.value
    ? 'border-[var(--accent)] bg-accent-soft'
    : 'border-info bg-info-soft',
)
const pendingLabelClass = computed(() => (isSteerMode.value ? 'text-accent' : 'text-info'))
const pendingDotClass = computed(() => (isSteerMode.value ? 'bg-accent' : 'bg-info'))
const pendingLabel = computed(() => (isSteerMode.value ? t('panel.queue.steerLabel') : t('panel.queue.followupLabel')))

/** 复制反馈 */
const { copied, copy } = useCopy()
const userCopyKey = computed(() => `user-${props.turn.user?.id ?? props.turn.index}`)

/* ── 编辑（= fork）：编辑 user 消息后 fork 新会话 ── */
const editingUserId = ref<string | null>(null)
const draftText = ref('')
const isEditingThisUser = computed(
  () => !!props.turn.user && editingUserId.value === props.turn.user.id,
)

watch(isEditingThisUser, (editing) => {
  emit('edit-state-change', { editing })
})

function startEdit(): void {
  if (!props.turn.user) return
  editingUserId.value = props.turn.user.id
  draftText.value = normalizeContent(props.turn.user.content)
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
  const segments = rebuildSegmentsWithEditedText(user.content, text)
  await editAndResend(props.sessionId, user.id, segments)
}
</script>
