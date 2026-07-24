<template>
  <!--
    加载路径配置（层 A）—— Skill/Agent 共享组件（ADR-0020 §5）。
    强制目录只读置顶 + 可选目录可勾选可拖动排序（靠前覆盖靠后）。

    拖拽设计（rethink 后）：纯本地状态驱动，脱离 store 广播回路。
    - 拖拽期间只改 localDirs（即时生效，零网络往返）
    - dragend 时把最终顺序 emit 给父组件持久化（发后即忘）
    - 外部 props.dirs 变化同步进 localDirs，但拖拽进行中跳过（避免广播覆盖用户操作）
    这把「交互即时性」与「状态持久化」彻底解耦。
  -->
  <section>
    <h3 class="mb-2 text-[12px] font-medium text-fg">{{ t('settings.loadPaths.title') }}</h3>

    <!-- 强制目录（ADR-0020 §1.1 层 1-2，桥接层硬编码注入，不可关不可拖）-->
    <div class="mb-2 rounded-md border border-border bg-bg">
      <div class="px-3 py-2 text-[11px] text-muted">{{ t('settings.loadPaths.forcedDirs') }}</div>
      <div
        v-for="dir in forcedDirs"
        :key="dir"
        class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]"
      >
        <span class="size-4 shrink-0 rounded bg-surface-hover text-center text-[10px] leading-4 text-subtle">
          &#10003;
        </span>
        <span class="font-mono text-fg opacity-60">{{ dir }}</span>
        <span class="ml-auto text-[10px] text-subtle">{{ t('settings.loadPaths.forced') }}</span>
      </div>
    </div>

    <!-- 可选目录（ADR-0020 §1.1 层 3，可勾选可拖排序）-->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-3 py-2 text-[11px] text-muted">{{ t('settings.loadPaths.optionalDirs') }}</div>
      <div
        v-for="(dir, index) in localDirs"
        :key="dir.path"
        class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px] transition-colors"
        :class="{
          'border-t-2 border-t-accent bg-surface-hover/50': dragOverIndex === index,
          'opacity-40': dragIndex === index,
        }"
        :draggable="!disabled"
        @dragstart="onDragStart($event, index)"
        @dragenter.prevent="onDragOver($event, index)"
        @dragover.prevent="onDragOver($event, index)"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop(index)"
        @dragend="onDragEnd"
      >
        <GripVertical
          class="size-4 shrink-0 cursor-grab text-subtle hover:text-fg active:cursor-grabbing"
          :class="{ 'cursor-not-allowed opacity-40': disabled }"
          :aria-label="t('settings.loadPaths.dragSort')"
        />
        <Checkbox
          :model-value="dir.enabled"
          class="shrink-0"
          :disabled="disabled"
          :aria-label="t('settings.loadPaths.enableDir', { path: dir.path })"
          @update:model-value="onToggle(index, $event)"
        />
        <span class="font-mono text-fg">{{ dir.path }}</span>
        <Button
          variant="ghost"
          data-testid="remove-path-btn"
          class="ml-auto size-6 shrink-0 p-0 text-subtle hover:bg-surface-hover hover:text-danger"
          :class="{ 'cursor-not-allowed opacity-40': disabled }"
          :disabled="disabled"
          :aria-label="t('settings.loadPaths.removeDir', { path: dir.path })"
          @click="onRemove(index)"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>

      <!-- 添加自定义路径入口（ADR-0020 §5 自定义 discovery 目录）-->
      <div class="border-t border-border px-3 py-2">
        <div class="flex items-center gap-2">
          <Input
            v-model="newPath"
            data-testid="new-path-input"
            placeholder="/absolute/path/to/dir"
            class="h-8 font-mono text-[12px]"
            :disabled="disabled"
            @keydown.enter="onAddPath"
          />
          <Button
            variant="secondary"
            size="dense"
            data-testid="add-path-btn"
            :disabled="disabled"
            @click="onAddPath"
          >
            {{ t('settings.loadPaths.addPath') }}
          </Button>
        </div>
        <p
          v-if="pathError"
          data-testid="path-error"
          class="mt-1 text-[11px] text-danger"
        >
          {{ pathError }}
        </p>
      </div>
    </div>

    <p v-if="kind === 'agent'" class="mt-1.5 text-[11px] text-subtle">{{ t('settings.loadPaths.agentRestartHint') }}</p>
    <p v-else-if="kind === 'extension'" class="mt-1.5 text-[11px] text-subtle">{{ t('settings.loadPaths.extensionLoadOrderHint') }}</p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { GripVertical, Trash2 } from '@lucide/vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { SkillDirConfig } from '@xyz-agent/shared'

const props = defineProps<{
  /** 强制目录路径（只读展示，ADR-0020 §1.1 层 1-2） */
  forcedDirs: string[]
  /** 可选目录配置（来自 store，可勾选可拖排序） */
  dirs: SkillDirConfig[]
  /** 资源类型：skill 即时生效，agent 需重开会话，extension 新会话生效（ADR §理由） */
  kind: 'skill' | 'agent' | 'extension'
  /** 操作禁用（扫描中等场景） */
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** 目录配置变更（勾选或排序），父组件写回 store */
  'update-dirs': [dirs: SkillDirConfig[]]
}>()

const { t } = useI18n()

// ── 本地状态（拖拽即时性的关键）──
// localDirs 是 dirs 的可写副本：拖拽/勾选只改它（即时），props.dirs 变化时同步进来。
const localDirs = ref<SkillDirConfig[]>([...props.dirs])

// 同步外部变更（store 广播），但拖拽进行中跳过——避免广播覆盖用户正在拖拽的顺序。
watch(() => props.dirs, (next) => {
  if (dragIndex.value !== null) return // 拖拽中，不覆盖
  // 广播回显抑制（竞态修复 W2）：onDragEnd emit 后 dragIndex 已清成 null，
  // 此时若广播回来（props.dirs 因 store→WS→runtime 回路而变），原守卫失效会覆盖 localDirs。
  // awaitingBroadcast 在 onDragEnd emit 前置位：广播回来时若 enabled 路径顺序与 localDirs
  // 一致 → 这是自己刚 emit 的回显，跳过覆盖（保留 localDirs 对象，避免回弹/对象重建）；
  // 顺序不一致 → 外部真实变更，落到下面正常同步。标志无论走哪条分支都复位。
  if (awaitingBroadcast.value) {
    const nextEnabled = next.filter((d) => d.enabled).map((d) => d.path)
    const localEnabled = localDirs.value.filter((d) => d.enabled).map((d) => d.path)
    const sameOrder =
      nextEnabled.length === localEnabled.length &&
      nextEnabled.every((p, i) => p === localEnabled[i])
    awaitingBroadcast.value = false
    if (sameOrder) return // 广播顺序与用户拖拽一致 → 跳过覆盖
    // 顺序不一致 = 外部真实变更 → 落到下面覆盖
  }
  localDirs.value = next.map((d) => ({ ...d }))
}, { deep: true })

// ── 原生 HTML5 拖拽（本地状态驱动，零回路）──
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)
/**
 * 拖拽 emit 后等待广播回显的标志（竞态修复 W2）。
 * onDragEnd emit 前置位 true；watch(props.dirs) 据此判断：广播值的 enabled 顺序与 localDirs
 * 一致 → 跳过覆盖（防 onDragEnd 清 dragIndex 后广播把刚拖的顺序覆盖回去）。任何分支都复位。
 */
const awaitingBroadcast = ref(false)
const DND_MIME = 'application/x-loadpaths-index'

function onDragStart(e: DragEvent, index: number): void {
  if (props.disabled || !e.dataTransfer) return
  // 必须 dataTransfer 写数据，否则浏览器判定拖拽无效 → drop 事件永不触发。
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData(DND_MIME, String(index))
  e.dataTransfer.setData('text/plain', String(index))
  dragIndex.value = index
}

function onDragOver(e: DragEvent, index: number): void {
  if (dragIndex.value === null || dragIndex.value === index) return
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverIndex.value = index
}

function onDragLeave(): void {
  dragOverIndex.value = null
}

/**
 * 放下：立即重排 localDirs（即时生效，零回路）。
 * 不在此 emit——顺序的最终持久化留到 dragend（拖拽完全结束后一次性 emit）。
 */
function onDrop(targetIndex: number): void {
  const from = dragIndex.value
  if (from === null || from === targetIndex) {
    dragOverIndex.value = null
    return
  }
  // 重排 localDirs：把 from 移到 target 位置（靠前 = 高优先级，ADR §1.1）
  const next = [...localDirs.value]
  const [moved] = next.splice(from, 1)
  next.splice(targetIndex, 0, moved)
  localDirs.value = next
  // 不清 dragIndex——留给 dragend 统一清理 + emit
}

/**
 * 拖拽完全结束：清状态 + 把最终顺序一次性 emit 持久化（发后即忘）。
 * 持久化是异步副作用，不阻塞 UI（localDirs 已是最终态）。
 */
function onDragEnd(): void {
  const wasDragging = dragIndex.value !== null
  dragIndex.value = null
  dragOverIndex.value = null
  if (wasDragging) {
    // 先置位 awaitingBroadcast 再 emit：emit 触发 store→WS→runtime→props.dirs 广播回路，
    // 回来时 watch 检查 awaitingBroadcast，若 enabled 顺序一致则跳过覆盖（防竞态回弹）。
    awaitingBroadcast.value = true
    emit('update-dirs', localDirs.value.map((d) => ({ ...d })))
  }
}

/** Checkbox 勾选 → 立即改 localDirs + emit 持久化。目录在 = 启用（ADR §5）。 */
function onToggle(index: number, value: string | boolean): void {
  const enabled = value === true
  const next = localDirs.value.map((d, i) => (i === index ? { ...d, enabled } : d))
  localDirs.value = next
  emit('update-dirs', next.map((d) => ({ ...d })))
}

// ── 自定义路径入口（W5/D1）──
const newPath = ref('')
const pathError = ref('')

/**
 * 添加自定义路径（ADR-0020 §5 自定义 discovery 目录）。
 * 仅做非空 + 重复校验；存在性提示按 D1 决策不做（无现成 RPC，避免新增通道）。
 * 新路径默认 enabled=true，append 到 localDirs 末尾（最低优先级，可再拖排序）。
 */
function onAddPath(): void {
  const path = newPath.value.trim()
  if (!path) return // 空路径：无操作、不报错
  if (localDirs.value.some((d) => d.path === path)) {
    pathError.value = t('settings.loadPaths.pathExists')
    return
  }
  pathError.value = ''
  localDirs.value = [...localDirs.value, { path, enabled: true }]
  newPath.value = ''
  emit('update-dirs', localDirs.value.map((d) => ({ ...d })))
}

/** 彻底移除条目（区别于取消勾选：删后条目不再出现在列表） */
function onRemove(index: number): void {
  if (props.disabled) return
  localDirs.value = localDirs.value.filter((_, i) => i !== index)
  emit('update-dirs', localDirs.value.map((d) => ({ ...d })))
}
</script>
