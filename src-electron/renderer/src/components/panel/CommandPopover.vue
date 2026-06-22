<template>
  <!--
    命令浮层（draft-composer-states §2d：@ 引用 / # 文件 / / 命令 三路共享容器）。
    由 Composer 受控打开（v-model:open）。用 reka-ui Popover portal 到 body，
    不受 composer-box 父容器 overflow/stacking context 限制（修复 D5 定位 bug）。
    PopoverAnchor 覆盖 composer-box，PopoverContent 相对它 side="top" 定位。
    键盘事件（↑↓ ⏎ Esc）由 Composer 在 ComposerInput keydown 时调 handleKeydown 路由进来。
  -->
  <Popover v-model:open="controlledOpen">
    <!-- anchor：覆盖 composer-box 的虚拟元素，不占布局空间 -->
    <PopoverAnchor as-child>
      <div class="pointer-events-none absolute inset-0" aria-hidden="true" />
    </PopoverAnchor>
    <PopoverContent
      v-if="items.length > 0"
      side="top"
      align="start"
      :side-offset="6"
      class="w-[320px] overflow-hidden p-0"
    >
      <!-- filter header -->
      <div class="flex items-center gap-1.5 border-b border-border bg-white/[0.015] px-2.5 py-1.5 font-mono text-[11px] text-subtle">
        <span>{{ typeLabel }}</span>
        <span :class="symbolClass">{{ symbol }}</span>
        <span>· {{ items.length }} 项</span>
      </div>
      <!-- list -->
      <div class="max-h-[132px] overflow-y-auto py-1">
        <Button
          v-for="(item, i) in items"
          :key="item.id"
          variant="ghost"
          class="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-left text-[12px] leading-[1.4] transition-colors"
          :class="i === activeIndex ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'"
          @click="onSelect(item)"
          @mouseenter="activeIndex = i"
        >
          <component
            :is="iconFor(item)"
            class="size-[15px] shrink-0"
            :class="i === activeIndex ? 'text-accent' : 'text-subtle'"
          />
          <span class="flex-1 truncate">{{ item.name }}</span>
          <span class="ml-auto shrink-0 font-mono text-[10px] text-subtle">{{ item.kind }}</span>
        </Button>
      </div>
      <!-- foot -->
      <div class="flex items-center justify-between border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-subtle">
        <span class="flex items-center gap-1">
          <kbd class="rounded-sm border border-border bg-surface px-1 py-px">↑↓</kbd>选
          <kbd class="rounded-sm border border-border bg-surface px-1 py-px">⏎</kbd>插
        </span>
        <span :class="symbolClass">{{ symbol }}</span>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, markRaw, ref, watch } from 'vue'
import { Braces, FileText, Folder, Star, Terminal, Wrench } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  MOCK_FILES,
  MOCK_MENTIONS,
  MOCK_SLASH_COMMANDS,
  type MockFileItem,
  type MockMentionItem,
  type MockSlashCommand,
} from '@/api/mock/composer-data'

type CmdType = 'mention' | 'file' | 'slash'

const props = defineProps<{
  open: boolean
  type: CmdType
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [payload: { type: CmdType; name: string }]
}>()

/** 受控 open：双向同步 props.open ↔ emit update:open */
const controlledOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const activeIndex = ref(0)

/** 统一候选项视图（三种数据源归一为 { id, name, kind, icon }） */
const items = computed(() => {
  if (props.type === 'mention') {
    return MOCK_MENTIONS.map((m: MockMentionItem) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      icon: m.icon,
    }))
  }
  if (props.type === 'file') {
    return MOCK_FILES.map((f: MockFileItem) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      icon: f.kind === '目录' ? 'folder' : 'file',
    }))
  }
  return MOCK_SLASH_COMMANDS.map((c: MockSlashCommand) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    icon: c.icon,
  }))
})

const symbol = computed(() => (props.type === 'mention' ? '@' : props.type === 'file' ? '#' : '/'))
const typeLabel = computed(() => (props.type === 'mention' ? '引用' : props.type === 'file' ? '文件' : '命令'))
const symbolClass = computed(() => ({
  'text-accent': props.type === 'mention',
  'text-success': props.type === 'file',
  'text-reasoning': props.type === 'slash',
}))

/** icon 字段 → lucide 组件 */
const ICONS = {
  file: markRaw(FileText),
  symbol: markRaw(Braces),
  skill: markRaw(Star),
  folder: markRaw(Folder),
  terminal: markRaw(Terminal),
  wrench: markRaw(Wrench),
  star: markRaw(Star),
}
function iconFor(item: { icon: string }) {
  return ICONS[item.icon as keyof typeof ICONS] ?? ICONS.file
}

function onSelect(item: { name: string }): void {
  emit('select', { type: props.type, name: item.name })
}

/**
 * Composer 在 ComposerInput keydown 时调用：浮层 open 则处理 ↑↓ ⏎ Esc。
 * 返回 true 表示已消费（Composer 不再走发送逻辑）。
 */
function handleKeydown(e: KeyboardEvent): boolean {
  if (!props.open) return false
  const list = items.value
  if (list.length === 0) return false
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % list.length
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + list.length) % list.length
    return true
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    onSelect(list[activeIndex.value])
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    controlledOpen.value = false
    return true
  }
  return false
}

// 浮层打开时重置高亮到第一项；type 切换也重置
watch(
  () => [props.open, props.type],
  () => {
    activeIndex.value = 0
  },
)

defineExpose({ handleKeydown })
</script>
