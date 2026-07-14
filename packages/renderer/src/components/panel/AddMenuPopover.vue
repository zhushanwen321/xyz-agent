<template>
  <!--
    + 添加内容 popover（draft-composer-states §1 ①）。
    click 触发，两路：附件 / / 命令。
    # 文件已移除入口——改走输入区敲 # 的 inline 触发（§2d，见 CommandPopover file 分支）。
    附件暂为 TODO（附件功能单独开任务，涉及系统文件对话框 + pi 对接）。
  -->
  <Popover v-model:open="open">
    <PopoverTriggerButton
      :open="open"
      variant="icon"
      :show-chevron="false"
      :title="t('panel.composer.addContent')"
    >
      <Plus class="size-4" />
    </PopoverTriggerButton>
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
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import { Paperclip, Plus, Slash } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTriggerButton } from '@/components/ui/popover'

type AddType = 'attach' | 'slash'

interface AddItem {
  type: AddType
  label: string
  icon: Component
  hint?: string
}

const emit = defineEmits<{
  select: [type: AddType]
}>()

const { t } = useI18n()
const open = ref(false)

const ITEMS: AddItem[] = [
  { type: 'attach', label: t('panel.composer.attach'), icon: markRaw(Paperclip) },
  { type: 'slash', label: t('panel.composer.command'), hint: '/', icon: markRaw(Slash) },
]

// file 入口移除后无 session 守门需求（attach/slash 均与 cwd 无关），items 退化为常量
const items = ITEMS

function onSelect(type: AddType): void {
  open.value = false
  emit('select', type)
}
</script>
