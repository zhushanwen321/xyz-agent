<template>
  <!--
    Settings · System 菜单页（handoff-system.md · 模式 A+B · 全枚举开关）。
    两块 Card：语言与外观 / 配色主题。聊天显示整块从 draft 移除（handoff §11a 决议）。
  -->
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- 卡 1：语言与外观 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">语言与外观</h3>
      </div>
      <div class="border-t border-border">
        <!-- 语言 -->
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">语言</Label>
          <Select
            :model-value="system.locale"
            @update:model-value="emit('update', { locale: $event as 'zh-CN' | 'en-US' })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="en-US">English (US)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <!-- 外观模式 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <Label class="text-[12px] text-fg">外观模式</Label>
          <Select
            :model-value="system.theme"
            @update:model-value="emit('update', { theme: $event as 'light' | 'dark' | 'system' })"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">浅色</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
              <SelectItem value="system">跟随系统</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>

    <!-- 卡 2：配色主题 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">配色主题</h3>
      </div>
      <div class="border-t border-border px-4 py-3">
        <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">Muted</p>
        <div class="mb-3 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            v-for="sw in mutedSwatches"
            :key="sw.id"
            class="h-auto gap-2 rounded-sm border px-3 py-1.5 text-[12px] transition-colors hover:bg-transparent"
            :class="system.themePreset === sw.id
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
              : 'border-border bg-bg hover:bg-[var(--accent-soft)]'"
            @click="emit('update', { themePreset: sw.id })"
          >
            <span class="size-4 rounded-full" :style="{ background: sw.color }" />
            <span class="text-fg">{{ sw.label }}</span>
          </Button>
        </div>
        <p class="mb-2 text-[11px] uppercase tracking-wider text-muted">Colorful</p>
        <div class="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            v-for="sw in colorfulSwatches"
            :key="sw.id"
            class="h-auto gap-2 rounded-sm border px-3 py-1.5 text-[12px] transition-colors hover:bg-transparent"
            :class="system.themePreset === sw.id
              ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]'
              : 'border-border bg-bg hover:bg-[var(--accent-soft)]'"
            @click="emit('update', { themePreset: sw.id })"
          >
            <span class="size-4 rounded-full" :style="{ background: sw.color }" />
            <span class="text-fg">{{ sw.label }}</span>
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

defineProps<{
  system: { locale: string; theme: string; themePreset: string }
}>()

const emit = defineEmits<{
  update: [patch: Record<string, unknown>]
}>()

const mutedSwatches = [
  { id: 'warm-teal', label: 'Warm Teal', color: 'oklch(55% 0.08 195)' },
  { id: 'cold-teal', label: 'Cold Teal', color: 'oklch(62% 0.10 190)' },
  { id: 'neutral', label: 'Neutral', color: 'oklch(40% 0 0)' },
  { id: 'sharp', label: 'Sharp', color: 'oklch(10% 0 0)' },
  { id: 'warm-neutral', label: 'Warm Neutral', color: 'oklch(45% 0.04 80)' },
]

const colorfulSwatches = [
  { id: 'cold-blue', label: 'Cold Blue', color: '#4f8ef7' },
  { id: 'terracotta', label: 'Terracotta', color: 'oklch(64% 0.13 28)' },
  { id: 'rose', label: 'Rose', color: 'oklch(65% 0.14 350)' },
  { id: 'amber', label: 'Amber', color: 'oklch(67% 0.15 65)' },
  { id: 'blue', label: 'Blue', color: 'oklch(62% 0.15 250)' },
  { id: 'violet', label: 'Violet', color: 'oklch(62% 0.15 280)' },
]
</script>
