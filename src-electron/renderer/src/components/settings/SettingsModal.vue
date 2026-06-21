<template>
  <!--
    容器组件 · Settings modal 骨架（settings/spec.md · 居中 modal + 模糊背景）。
    取向 = 配置/表单交互，区别于 Overview 的鸟瞰（spec §1）。
    形态：shadcn Dialog 居中浮层，浮于 workspace 之上；关闭恢复 workspace 原状态。

    v1 范围（FG6 骨架）：modal 形态 + modal-head（标题 + 关闭按钮）+ 左导航（5 菜单占位）+ 右详情空壳。
    DEFERRED（spec §9）：触发入口（Cmd+, / sidebar 头像，G3-002 hide，v1 不渲染触发按钮）；
         三种布局模式（Setting Row/Card/Entity List）+ 5 菜单具体表单 + 自动保存 + 内置搜索。
    本组件通过 v-model:open 受控；v1 无任何调用方渲染触发入口（待 G-021 联调阶段接入）。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      aria-modal="true"
      hide-close
      class="flex max-w-[900px] flex-col gap-0 overflow-hidden p-0 sm:rounded-lg"
    >
      <!-- modal-head：标题 + 内置搜索槽(DEFERRED) + 保存 pill 槽(DEFERRED) + 关闭按钮（spec §2 .modal-head） -->
      <div class="modal-head flex h-[44px] flex-none items-center gap-2.5 border-b border-border px-3.5">
        <span class="text-[14px] font-semibold tracking-tight text-fg">设置</span>
        <!-- 内置搜索 ⌘K（G-021 DEFERRED）：保留槽位，v1 不渲染输入框 -->
        <div class="ml-auto flex items-center gap-2">
          <!-- 自动保存状态 pill（RC-01 DEFERRED）：保留槽位 -->
          <DialogClose
            class="grid size-7 place-items-center rounded-sm text-muted transition-colors hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="关闭（Esc）"
          >
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogClose>
        </div>
      </div>

      <!-- modal-body：左 nav + 右 detail（spec §2 .modal-body） -->
      <div class="flex min-h-0 flex-1">
        <!-- 左导航：5 菜单占位（选中态 inset ring，spec §ov-nav） -->
        <nav class="flex w-[200px] flex-shrink-0 flex-col gap-px border-r border-border bg-surface p-2">
          <Button
            v-for="item in menus"
            :key="item.id"
            variant="ghost"
            class="h-auto justify-start gap-2.5 rounded-md px-2.5 py-2 text-[13px]"
            :class="
              item.id === activeMenu
                ? 'bg-surface-hover text-fg ring-1 ring-inset ring-accent hover:bg-surface-hover hover:text-fg'
                : 'text-muted hover:bg-surface-hover hover:text-fg'
            "
            @click="activeMenu = item.id"
          >
            <component :is="item.icon" class="size-[17px] flex-shrink-0" />
            <span>{{ item.label }}</span>
          </Button>
        </nav>

        <!-- 右详情：page-header + 空壳占位（Setting Row/Card/Entity List DEFERRED） -->
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="border-b border-border px-6 pb-4 pt-5">
            <h2 class="text-[20px] font-semibold tracking-tight text-fg">{{ currentMenu.label }}</h2>
            <p class="mt-0.5 text-[13px] text-muted">{{ currentMenu.desc }}</p>
          </div>
          <ScrollArea class="min-h-0 flex-1">
            <div class="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <p class="text-[13px] text-muted">配置项待联调阶段实现</p>
              <p class="font-mono text-[11px] text-subtle">
                {{ currentMenu.id }} · 三模式（G3-002 DEFERRED）
              </p>
            </div>
          </ScrollArea>
        </div>
      </div>

      <!-- sr-only 标题/描述（Radix Dialog a11y 契约，视觉不显） -->
      <DialogHeader class="sr-only">
        <DialogTitle>设置</DialogTitle>
        <DialogDescription>配置 Provider / Skill / Agent / Extension / System</DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Settings, Sparkles, Bot, Blocks, SlidersHorizontal, X } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

/**
 * 5 菜单定义（settings/spec.md §4）。
 * 图标语义与 draft-settings-shell symbol 一致；选中态 inset accent ring（弃左竖条）。
 * 实体内容（Row/Card/Entity List）DEFERRED，v1 仅 nav 联动 + 详情空壳。
 */
const menus = [
  { id: 'provider', label: 'Provider', icon: Settings, desc: '配置模型供应商与 API Key' },
  { id: 'skill', label: 'Skill', icon: Sparkles, desc: '管理 Skill 加载路径与来源' },
  { id: 'agent', label: 'Agent', icon: Bot, desc: '管理 Agent 加载路径与来源' },
  { id: 'extension', label: 'Extension', icon: Blocks, desc: '管理 MCP 扩展与工具' },
  { id: 'system', label: 'System', icon: SlidersHorizontal, desc: '外观、语言与快捷键偏好' },
] as const

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const activeMenu = ref<(typeof menus)[number]['id']>('provider')
const currentMenu = computed(() => menus.find((m) => m.id === activeMenu.value) ?? menus[0])

void props
</script>
