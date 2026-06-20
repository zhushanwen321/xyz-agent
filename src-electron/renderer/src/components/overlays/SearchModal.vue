<template>
  <!--
    容器组件 · Search Modal 骨架（overlays/spec.md · L0 Overlay 级组件）。
    ⌘K 触发的全局搜索浮层：模糊遮罩 + 居中浮层，浮于所有 Region 之上，不归属任何 Region。
    范围：全局·跨项目（命令/文件/符号/会话四类分组）。

    v1 范围（FG6 骨架）：modal 形态（遮罩 + 居中浮层 + 焦点输入框 + 空态）。
    DEFERRED（spec §9）：触发入口（⌘K / sidebar「搜索」nav，G3-002 hide，v1 不渲染触发按钮）；
         四类分组结果 + 模糊匹配高亮 + recents + 键盘 ↑↓/Tab/Enter + 跨项目检索范围（G-022）。
    本组件通过 v-model:open 受控；v1 无任何调用方渲染触发入口（待 G-022 联调阶段接入）。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      aria-modal="true"
      class="gap-0 overflow-hidden p-0 sm:rounded-lg"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>搜索</DialogTitle>
        <DialogDescription>全局搜索命令、文件、符号与会话</DialogDescription>
      </DialogHeader>

      <!-- 搜索输入框（唤起即 focus，光标置末尾；debounce 查询 DEFERRED） -->
      <div class="flex items-center gap-2 border-b border-border px-3.5 py-3">
        <Search class="size-[14px] flex-shrink-0 text-subtle" />
        <Input
          v-model="query"
          class="h-8 border-0 bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-0"
          placeholder="搜索命令、文件、符号、会话…"
        />
        <kbd class="flex-shrink-0 rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">Esc</kbd>
      </div>

      <!-- 结果区：四类分组骨架（数据源 DEFERRED，v1 显空态） -->
      <div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <Search class="size-6 text-subtle" />
        <p class="text-[13px] text-muted">
          {{ query ? '暂无匹配结果' : '输入关键词开始搜索' }}
        </p>
        <p class="font-mono text-[11px] text-subtle">
          四类分组 · 跨项目范围（G-022 DEFERRED）
        </p>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { Search } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

/** 查询文本（debounce 120ms 查索引 DEFERRED，v1 仅本地绑定驱动空态文案） */
const query = ref('')

/** 关闭时清空查询（spec §边缘：查询清空恢复 recents；recents DEFERRED 故清空到空态） */
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) query.value = ''
    else nextTick(() => { query.value = '' })
  },
)

void emit
</script>
