<template>
  <!--
    容器组件 · composer（panel/spec.md zone ④，draft-composer-states）。
    v1 主路径 4 态：
      S1 空 → S2 输入中 → S5 发送中（spinner）→ S6 流式中（stop + steer/followUp）
    DEFERRED：
      S3/S4（@/#// 附件浮层 G2-002）、S7-S9 双队列视图/失败回退/已排队多条。
    steer/followUp：活跃态（isGenerating/派发空窗期）时 ⏎ 追加 steer，Alt+⏎ 追加 followUp，都不打断当前回合。

    [W4 迁移] 壳改写：消费 composer-shell.ts（core dispatch/context/model-thinking deps 组装 +
    视觉派生），ComposerInput 从 ui 包渲染（D5 占位：壳内硬编码渲染，P4 ExtensionHost 前不走
    contribution 路由）。子组件（CommandPopover/AddMenu/ModelSelect 等）留壳，不在本 wave 范围。
  -->
  <div class="composer mx-auto w-full max-w-[var(--content-max-w)]">
    <!-- retry/queue 指示位（spec C10，#13，composer 上方独立行）：
         auto_retry_end / message_start 到达时 store 自动清 → state=undefined → 组件 v-if 消失 -->
    <RetryIndicator :state="retryState" />
    <CompactQueueBadge :session-id="sessionId" />
    <!-- 命令浮层（§2d @/#//）：anchor = composer-box（slot），reka-ui Popover portal body。
         composer-box 内 focus 算 inside 不触发 dismiss，键盘路由见 onKeydown -->
    <CommandPopover
      ref="commandPopoverRef"
      v-model:open="cmdOpen"
      :type="cmdType"
      :session-id="sessionId ?? undefined"
      :variant="variant"
      :project-skills="landingProjectSkills"
      :global-skills="landingGlobalSkills"
      :query="cmdType === 'file' ? fileQuery : slashQuery"
      @select="onCmdSelect"
    >
      <div
        ref="composerBoxRef"
        class="composer-box relative rounded-lg border bg-[var(--composer-bg)]"
        :class="[boxClass, focusRingClass]"
        data-testid="composer-box"
        @dragover.prevent="onDragOver"
        @dragleave.prevent="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- QueueBubble（v6 §8.5：内嵌 composer-box 顶部，去独立卡片/pulse/标签/chevron，
             仅 border-b 分隔，Zap/Clock icon + truncate 文本）——6 区第 1 位 -->
        <QueueBubble :state="queueState" />
        <!-- Staging 模式标识 chip（fork/handoff 统一）：顶部 accent chip 提示当前 staging 类型 + × 退出。
             经 staging.activeStaging 统一渲染（ADR-0057），退出调 staging.exit() -->
        <div
          v-if="staging.activeStaging.value"
          class="composer-mode-chip mx-2.5 mt-2 flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--accent)]"
          :data-testid="staging.activeStaging.value.type === 'fork' ? 'composer-mode-chip' : 'composer-handoff-chip'"
        >
          <component :is="staging.activeStaging.value.visual.chipIcon" class="size-3" />
          <span class="flex-1">{{ t(staging.activeStaging.value.visual.chipLabelKey) }}</span>
          <Button
            variant="ghost"
            size="icon"
            class="size-4 rounded-sm p-0 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-accent-fg"
            :title="staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkExit') : t('panel.composer.handoffExit')"
            @click="staging.exit"
          >
            <X class="size-3" />
          </Button>
        </div>
        <!-- 顶部元信息行 slot（landing 态：directory/branch chip；panel 态留空） -->
        <slot name="meta-row" />
        <!-- 已附上下文 chip 行（§2f）。W4：从 segments 派生 image chips，× 删除定位 DOM 节点移除 -->
        <ContextChipsBar :items="attachedItems" @remove="onRemoveContextChip" />
        <!-- 输入区：ui 包 ComposerInput（contenteditable 富文本，draft §1/§2e，支持 slash chip 与 @/# mention 内联）。
             deps（pasteImage/renderIcon/t）经 ComposerInputDeps inject token 注入（ADR-0058）。 -->
        <ComposerInput
          ref="inputRef"
          :placeholder="placeholder"
          :disabled="isSending"
          :session-id="sessionId"
          @input="onInputChange"
          @keydown="onKeydown"
          @slash-trigger="onSlashTrigger"
          @file-trigger="onFileTrigger"
          @focus="onBoxFocusIn"
          @blur="onBoxFocusOut"
        />

      <!-- 工具条（panel/spec §composer line 51）：上下文/模型/thinking-level 展示型 + 发送位三态。
           gap-0：三触发器贴合紧凑成一条工具带（draft「不画分隔线」，仅靠 padding 区隔），发送位 ml-1.5 独立锚点。 -->
      <div class="composer-bar flex flex-wrap items-center justify-end gap-0 px-2.5 pb-2 mt-1">
        <!-- + 添加内容（左锚定，spec §1 ①，click 出浮层：附件 / 命令；# 文件改走 inline 触发） -->
        <AddMenuPopover @select="onAddSelect" />
        <!-- ExtensionHost composer.toolbar 挂载点（audit §12.1，MountPointRegistry composer.toolbar）。
             plugin 贡献工具栏视图 → ViewHost 渲染。empty="hidden"：无贡献时零 DOM 不影响布局。
             见 02-extension-host-wiring.md 重构 2。 -->
        <ViewHost
          v-if="sessionId"
          view-id="composer.toolbar"
          :session-id="sessionId"
          empty="hidden"
        />
        <span class="flex-1" />
        <!-- 上下文容量（spec §2a：hover 出容量 popover；session 通道订阅 context.update） -->
        <ContextCapacityPopover :session-id="sessionId ?? undefined" :model-id="currentModelId" />
        <!-- 模型（spec §2b：click 出模型切换 popover） -->
        <ModelSelectPopover :selected="currentModelId" @select="onModelSelect" />
        <!-- 思考等级（spec §2c：click 出 6 级 popover；level 从 session 透传） -->
        <ThinkingLevelPopover :level="currentThinkingLevel" :level-map="currentThinkingLevelMap" @select="onThinkingSelect" />

        <!-- 发送位三态：S6 streaming/dispatching→stop / S5 sending→spinner / compact→queue-send（可点，入队待重放）/ S1·S2 idle→send -->
        <Button
          v-if="isActive"
          variant="ghost"
          size="icon"
          class="stop-btn ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-surface-hover text-neutral-mid hover:bg-danger-soft hover:text-danger"
          :title="t('panel.composer.stop')"
          @click="onStopClick"
        >
          <Square class="size-[13px]" />
        </Button>
        <Button
          v-else-if="isCompacting"
          variant="default"
          size="icon"
          class="ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSubmit"
          :title="canSubmit ? t('panel.composer.queueSend') : t('panel.composer.sendHint')"
          @click="onSend"
        >
          <ArrowUp class="size-[15px]" />
        </Button>
        <div
          v-else-if="isSending"
          class="ml-1.5 grid size-[var(--composer-btn-size)] place-items-center rounded-md bg-accent text-accent-fg"
          :title="t('panel.composer.sending')"
        >
          <Loader2 class="size-4 animate-spin" />
        </div>
        <Button
          v-else
          variant="default"
          size="icon"
          class="ml-1.5 size-[var(--composer-btn-size)] rounded-md bg-accent text-accent-fg transition-colors enabled:hover:bg-accent-hover disabled:bg-transparent disabled:text-[var(--neutral-dim)]"
          :disabled="!canSubmit"
          :title="canSubmit ? `${staging.activeStaging.value ? (staging.activeStaging.value.type === 'fork' ? t('panel.composer.forkSend') : t('panel.composer.handoffSend')) : t('panel.composer.send')} · ⏎` : t('panel.composer.sendHint')"
          @click="onSend"
        >
          <ArrowUp class="size-[15px]" />
        </Button>
      </div>
    </div>
    </CommandPopover>

  </div>
</template>

<script setup lang="ts">
import { computed, createVNode, onBeforeUnmount, onMounted, provide, ref, render, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Loader2, Square, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ComposerInput, ComposerInputDepsKey, type ComposerInputDeps } from '@xyz-agent/ui/features/composer'
import { ViewHost } from '@xyz-agent/ui/extension-host'
import AddMenuPopover from './AddMenuPopover.vue'
import CommandPopover from './CommandPopover.vue'
import ContextCapacityPopover from './ContextCapacityPopover.vue'
import ModelSelectPopover from './ModelSelectPopover.vue'
import ThinkingLevelPopover from './ThinkingLevelPopover.vue'
import ContextChipsBar from './ContextChipsBar.vue'
import RetryIndicator from './RetryIndicator.vue'
import QueueBubble from './QueueBubble.vue'
import CompactQueueBadge from './CompactQueueBadge.vue'
import { useChatStore } from '@/stores/chat'
import { useProjectSkills, useGlobalSkills } from '@/composables/features/settings/useProjectSkills'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'
import { useComposerShell, type ShellInputInstance } from '@/composables/panel/composer-shell'
import { handleImagePaste } from '@/composables/panel/useImageAttachment'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'

const props = withDefaults(
  defineProps<{
    sessionId: string | null
    variant?: 'panel' | 'landing'
  }>(),
  { variant: 'panel' },
)

const { t } = useI18n()
const chatStore = useChatStore()
const flow = useNewTaskFlow()
const { projectSkills: landingProjectSkills } = useProjectSkills(flow.currentCwd) // W3 ADR-0051：landing 当前 cwd 项目 skill
const { globalSkills: landingGlobalSkills } = useGlobalSkills() // W4 FR-5：landing 全局 skill
const isActive = computed(() => {
  if (!props.sessionId) return false
  return chatStore.isActive(props.sessionId)
})

/** #13 retry/queue 指示位数据源（store 由 W0/#8 维护，不可变 Map 更新触发响应） */
const retryState = computed(() => (props.sessionId ? chatStore.getRetryState(props.sessionId) : undefined))
const queueState = computed(() => (props.sessionId ? chatStore.getQueueState(props.sessionId) : undefined))
const draft = ref('')
const inputRef = ref<InstanceType<typeof ComposerInput> | null>(null)
// W4：shell 的 input 契约是结构类型 ShellInputInstance（composer-shell.ts）——
// ui 包 ComposerInput 实例含全部 expose 方法（clear/focus/getText/getSegments/setText/
// insertTextAtCursor/insertSlashChip/insertFileChip/insertImageBadge/removeImageChip/
// moveCaretVertical），与契约结构兼容，模板 ref 类型断言传递（Vue 实例类型含 props/emits
// 无法直接赋给结构契约 ref）
const shellInputRef = inputRef as Ref<ShellInputInstance | null>

const sessionIdRef = computed(() => props.sessionId)
const {
  cmdOpen,
  cmdType,
  slashQuery,
  fileQuery,
  commandPopoverRef,
  onSlashTrigger,
  onFileTrigger,
  onAddSelect,
  onCmdSelect,
} = useCommandPopoverTrigger(inputRef, sessionIdRef)

const isSending = ref(false)
/** composer-box 聚焦态（v6 §6.1 .focused：border-accent + 3px accent 外环 --accent-ring）。
 *  boxClass（composer-shell）三级链 staging>bash>steer>hasInput 无 focus 分支，故在壳层补：
 *  focus 优先级低于 staging/steer（二者有独立视觉：staging bg-accent-soft / steer 呼吸），
 *  用 ! 前缀压过 hasInput 的 2px 微环 Tailwind 内联工具类。 */
const isFocused = ref(false)
/** focus ring class：staging/bash/steer 活跃时不叠加（它们已含 accent border + ring），
 *  否则聚焦时输出 3px accent 外环（覆盖 hasInput 的 2px 微环）。
 *  排除条件用 steer/bash 共享视觉特征 `border-[var(--accent)]`（Plan 04 删
 *  animate-steer-breathe 后原字符串条件变死代码，F3 修复）。 */
const focusRingClass = computed<Array<string>>(() => {
  if (!isFocused.value) return ['']
  const exclusive = String(boxClass.value[0] ?? '')
  if (
    exclusive.includes('border-[var(--accent)]')
    || staging.activeStaging.value
  ) {
    return ['']
  }
  // 3px accent-ring 外环（v6 §6.1 .focused 真值；与 staging/bash 分支的 shadow-[0_0_0_3px_var(--accent-ring)] 同视觉语言）
  return ['!border-[var(--accent)] ![box-shadow:0_0_0_3px_var(--accent-ring)]']
})
/** composer-box focusin/focusout：子元素（ComposerInput）聚焦算 box 聚焦（v6 .focused 态）。
 *  focusout 时 relatedTarget 仍在 box 内则保持（composer-box 内子元素切换不退出聚焦）。 */
function onBoxFocusIn(): void {
  isFocused.value = true
}
function onBoxFocusOut(): void {
  isFocused.value = false
}
// focusin/focusout 用原生 listener 注册（非 template @focusin）：composer-box 经
// CommandPopover 的 PopoverAnchor as-child 包裹，Vue template 事件绑定在 clone element 时丢失。
// ref 指向真实 DOM，addEventListener 稳定生效。
onMounted(() => {
  // composerBoxRef 在 CommandPopover PopoverAnchor as-child 包裹下透传丢失（ref 为 null），
  // 聚焦态改由子组件 ComposerInput emit focus/blur 驱动（见 @focus/@blur 绑定）。
})
onBeforeUnmount(() => {
  composerBoxRef.value?.removeEventListener('focusin', onBoxFocusIn)
  composerBoxRef.value?.removeEventListener('focusout', onBoxFocusOut)
})
/** composer-box 聚焦态：由 ComposerInput @focus/@blur 驱动（composer-box 经 CommandPopover
 *  PopoverAnchor as-child 包裹，ref 透传丢失，改由子组件 ComposerInput emit focus/blur）。 */
/** 当前 panel 的 session 是否正在压缩上下文（#6，per-session） */
const isCompacting = computed(() => (props.sessionId ? chatStore.isCompacting(props.sessionId) : false))

// composer-box 容器 ref（拖拽落位 + 视觉）——先声明，再喂给 shell
const composerBoxRef = ref<HTMLElement | null>(null)
// FR4: per-session 草稿存储（内存不持久化）；session 切换时保存旧/恢复新草稿
const drafts = new Map<string, string>()

// ── W4 壳改写：core 模块 deps 组装 + 视觉派生集中在 composer-shell.ts（替代 14 个 useComposer* shim）──
const shell = useComposerShell({
  sessionIdRef,
  variantRef: computed(() => props.variant),
  inputRef: shellInputRef,
  composerBoxRef,
  draft,
  isSending,
  drafts,
  isActive,
  isCompacting,
})
const {
  currentModelId,
  currentThinkingLevel,
  currentThinkingLevelMap,
  onModelSelect,
  onThinkingSelect,
  handleArrowUp,
  handleArrowDown,
  resetBrowsing,
  isBrowsing,
  attachedItems,
  refreshAttachedItems,
  onRemoveContextChip,
  onDragOver,
  onDragLeave,
  onDrop,
  fork,
  handoff,
  staging,
  onSteer,
  onFollowUp,
  onAbort,
  onSend,
  canSubmit,
  boxClass,
  placeholder,
} = shell

watch(
  () => props.sessionId,
  (newId, oldId) => {
    if (oldId) {
      // browsing 态 getText() 返回历史条目，存用户实际输入
      drafts.set(oldId, isBrowsing.value ? (draft.value || '') : (inputRef.value?.getText() ?? ''))
    }
    // 切 session 退出活跃 staging 模式（fork/handoff），避免来源残留指向错误 session
    staging.exit()
    resetBrowsing()
    if (newId) {
      const saved = drafts.get(newId)
      if (saved) {
        draft.value = saved
        inputRef.value?.setText(saved, 'end')
      } else {
        draft.value = ''
        inputRef.value?.clear()
      }
    }
  },
)

/** ComposerInput input 事件 → 维护 draft（纯文本，用于发送判断）+ 刷新 image chips */
function onInputChange(text: string): void {
  draft.value = text
  refreshAttachedItems()
  // 用户修改了内容，重置浏览历史状态（下次按上重新从最后一条开始）
  resetBrowsing()
}

/** 键盘：⏎ 发送/steer，Alt+⏎ follow-up，⇧⏎ 换行，↑/↓ 翻历史。命令浮层 open 时优先路由到浮层。 */
function onKeydown(e: KeyboardEvent): void {
  if (cmdOpen.value && commandPopoverRef.value?.handleKeydown(e)) return
  if (e.isComposing) return // IME 组合中不拦截（与 useContenteditableInput 守卫一致）
  // Staging Esc 路由：经 staging.handleEsc → activeStaging.handleEsc（fork/handoff 互斥下不会同时活跃）
  if (staging.handleEsc(e)) return
  // shift/ctrl/alt/meta + 方向键是选区扩展/按词移动/段首段尾跳转，放行原生行为（不拦截）
  const bareArrow = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  if (bareArrow && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    const dir = e.key === 'ArrowUp' ? 'up' : 'down'
    if (inputRef.value?.moveCaretVertical(dir) === 'moved') return
    if (dir === 'up') handleArrowUp()
    else handleArrowDown()
    return
  }
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  if (e.altKey) {
    // Alt+⏎：压缩期间重路由到 onSend（入队待重放）——onFollowUp 无 isActive 守卫，
    // 直通会走 pi followUp RPC 留陈旧队列。非压缩态保持 followUp。
    if (isCompacting.value) onSend()
    else onFollowUp()
  } else if (isActive.value) {
    onSteer()
  } else {
    onSend()
  }
}

/**
 * stop 按钮点击：先尝试取消进行中的 staging 操作（handoff inflight），否则普通 LLM turn abort。
 * 在 Composer 包一层而非改 useComposerSubmit——避免影响其他消费方（onAbort 语义保持「取消 LLM turn」）。
 */
async function onStopClick(): Promise<void> {
  // staging 操作进行中（handoff inflight）→ 取消 staging（abortHandoff 乐观清 handingOff + RPC 中断）
  if (props.sessionId && await staging.abortIfInProgress(props.sessionId)) return
  // 否则普通 LLM turn abort
  await onAbort()
}

// ── ui ComposerInput deps 注入（ADR-0058：pasteImage/renderIcon/t 三壳层能力）──
const composerInputDeps: ComposerInputDeps = {
  pasteImage: handleImagePaste,
  // renderIcon：图标查找 + vue render 内聚在壳层（dom-core 零 vue render，ADR-0058 边界）。
  // 返回 true = 已渲染图标（dom-core 侧挂载 host），false = 无图标不渲染。
  renderIcon: (host: HTMLElement, iconKey?: string) => {
    const Comp = iconKey
      ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS]
      : undefined
    if (!Comp) return false
    render(createVNode(Comp, { size: 12 }), host)
    return true
  },
  t: (key: string) => t(key),
}
provide(ComposerInputDepsKey, composerInputDeps)

// Fork/Handoff 模式 API 暴露：modeRef 是 {value} 包装对象（非 ref 不被 defineExpose 解包）
defineExpose({
  forkMode: fork.forkModeRef,
  enterForkMode: fork.enterForkMode,
  exitForkMode: fork.exitForkMode,
  handoffMode: handoff.handoffModeRef,
  enterHandoffMode: handoff.enterHandoffMode,
  exitHandoffMode: handoff.exitHandoffMode,
})
</script>
