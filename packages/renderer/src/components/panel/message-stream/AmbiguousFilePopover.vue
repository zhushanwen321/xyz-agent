<template>
  <!--
    歧义文件选择浮层（裸 basename 多匹配时弹出，如 design.md 在项目里有多个匹配）。

    克隆 CommandPopover 三件套模式：
    - Popover + PopoverAnchor as-child：锚定到点击的 <a> 元素（由 v-model:open 受控开关，
      不像 CommandPopover 的 slot 模式——这里 anchor 是具体 DOM 元素，用 :anchor 传入）
    - window capture 键盘导航（↑↓⏎ Esc）：与 CommandPopover 同模式，不依赖焦点位置
    - file 两行渲染（basename 主行 + 父目录暗行）：天然适合歧义区分（同名文件靠路径区分）

    数据源：candidates 由调用方从 fileSearchStore 按 basename 反查传入（FileNode[]）。
    选中后 emit('select', path) → 调用方走 selectFile(path) + drawer.open('detail') + 关浮层。
  -->
  <Popover v-model:open="controlledOpen">
    <!-- PopoverAnchor reference：传外部点击的 <a> DOM 元素作锚点（virtual anchor 模式，
         不需要 slot 包裹）。reka-ui PopoverAnchor.reference 透传给 PopperAnchor.onAnchorChange。 -->
    <PopoverAnchor :reference="anchorEl ?? undefined" />
    <PopoverContent
      v-if="open && candidates.length > 0"
      side="bottom"
      align="start"
      :side-offset="6"
      :collision-padding="8"
      class="w-[360px] max-w-[calc(100vw-16px)] overflow-hidden p-0"
      @open-auto-focus.prevent
    >
      <!-- 标题行：basename + 匹配数 -->
      <div class="border-b border-border px-2.5 py-1.5 text-[11px] text-subtle">
        「{{ basename }}」有 {{ candidates.length }} 个匹配，选择要打开的文件
      </div>
      <!-- 候选列表 -->
      <div class="max-h-[220px] overflow-y-auto py-1">
        <Button
          v-for="(node, i) in candidates"
          :key="node.path"
          variant="ghost"
          class="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-left text-[12px] leading-[1.4] transition-colors"
          :class="i === activeIndex ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-hover hover:text-fg'"
          @click="onSelect(node)"
          @mouseenter="activeIndex = i"
        >
          <FileIcon class="size-[15px] shrink-0" :class="i === activeIndex ? 'text-accent' : 'text-subtle'" />
          <!-- 两行：basename 主行 + 父目录路径暗行（区分同名文件位置） -->
          <div class="min-w-0 flex-1">
            <div class="truncate font-mono text-[12px]" :class="i === activeIndex ? 'text-accent' : 'text-fg'">{{ node.name }}</div>
            <div v-if="dirPathOf(node.path)" class="truncate font-mono text-[10px] leading-tight text-subtle">{{ dirPathOf(node.path) }}</div>
          </div>
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
/**
 * 歧义文件选择浮层。
 *
 * 触发：markdown 裸 basename（如 design.md）点击时，若 fileSearchStore 反查到多个匹配，
 * useMarkdownInteractions 的 onAmbiguous 回调设 ambiguousState → 渲染本组件。
 *
 * 交互：↑↓ 切换高亮、⏎/Tab 选中、Esc 关闭（window capture 键盘导航，与 CommandPopover 同模式）。
 * 选中后 emit('select', path)，调用方负责 selectFile + drawer.open + 清 ambiguousState。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { File as FileIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { FileNode } from '@xyz-agent/shared'

const props = defineProps<{
  /** 浮层开关（v-model:open） */
  open: boolean
  /** 歧义 basename（标题展示用） */
  basename: string
  /** 候选文件列表（按 basename 反查 fileSearchStore 的结果） */
  candidates: FileNode[]
  /** 锚点 DOM 元素（点击的 <a>，PopoverAnchor reference 模式，不要求在 slot 内） */
  anchorEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [path: string]
}>()

/** 受控 open：双向同步 */
const controlledOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const activeIndex = ref(0)

/** 取文件路径的父目录（供第二行展示，区分同名文件位置） */
function dirPathOf(path: string): string {
  const slashIdx = path.lastIndexOf('/')
  return slashIdx >= 0 ? path.slice(0, slashIdx + 1) : ''
}

function onSelect(node: FileNode): void {
  emit('select', node.path)
  controlledOpen.value = false
}

/**
 * 键盘导航（与 CommandPopover 同模式）：↑↓ 切换、⏎/Tab 选中、Esc 关闭。
 * 幂等守卫 e.defaultPrevented 防双入口重复处理。
 */
function handleKeydown(e: KeyboardEvent): boolean {
  if (!props.open) return false
  if (e.defaultPrevented) return false
  const list = props.candidates
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
  if (e.key === 'Enter' || e.key === 'Tab') {
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

/** window capture 监听（不依赖焦点位置，浮层 open 时稳定命中键盘导航） */
function onWindowKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  handleKeydown(e)
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onWindowKeydown, true)
  onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown, true))
}

// 浮层打开/候选变化时重置高亮到第一项
watch(
  () => [props.open, props.candidates],
  () => {
    activeIndex.value = 0
  },
)
</script>
