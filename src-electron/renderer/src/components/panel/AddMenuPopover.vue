<template>
  <!--
    + 添加内容 popover（draft-composer-states §1 ①）。
    click 触发，四路：附件 / @ 引用 / # 文件 / / 命令。
    点击 @ # / 由父组件插入对应符号到输入区（进而触发命令浮层 §2d）。
  -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="size-[28px] shrink-0 rounded-sm text-subtle transition-colors hover:bg-surface-hover hover:text-muted"
        title="添加内容（附件 / @ 引用 / 命令）"
      >
        <Plus class="size-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" class="w-[208px] p-1">
      <Button
        v-for="item in items"
        :key="item.type"
        variant="ghost"
        class="flex w-full items-center justify-start gap-2.5 rounded-sm px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface-hover hover:text-fg"
        @click="onSelect(item.type)"
      >
        <component :is="item.icon" class="size-3.5 shrink-0 text-subtle" />
        <span class="flex-1 text-left">{{ item.label }}</span>
        <span v-if="item.hint" class="font-mono text-[10px] text-subtle">{{ item.hint }}</span>
      </Button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { markRaw, ref } from 'vue'
import { AtSign, Hash, Paperclip, Plus, Slash } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type AddType = 'attach' | 'mention' | 'file' | 'slash'

const emit = defineEmits<{
  select: [type: AddType]
}>()

const open = ref(false)

const items = [
  { type: 'attach' as const, label: '附件', icon: markRaw(Paperclip) },
  { type: 'mention' as const, label: '引用', hint: '@', icon: markRaw(AtSign) },
  { type: 'file' as const, label: '文件', hint: '#', icon: markRaw(Hash) },
  { type: 'slash' as const, label: '命令', hint: '/', icon: markRaw(Slash) },
]

function onSelect(type: AddType): void {
  open.value = false
  emit('select', type)
}
</script>
