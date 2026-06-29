<template>
  <!--
    展示组件 · 命令/skill 文档（drawer Doc tab 内容）。
    数据源：
    - SessionCommand（commandStore，按 sessionId + selectedCommandName 查）：name/source/icon/description
    - SkillInfo（settings.skills 全局）：join 命中时渲染完整 SKILL.md（content）
    join 规则：skill 命令（source=skill）去 / 后按 skill.name 或 skill.triggers 匹配。
    非 skill 命令（extension/builtin）：仅有 description，退化为信息卡。
    selectedCommandName 由 useSideDrawer 单例持有（用户气泡 slash chip 点击时设置）。
  -->
  <section v-if="command" class="flex h-full flex-col">
    <!-- 元信息头：icon + 命令名 + source 标签 + skill 命令的 sourcePath -->
    <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
      <component :is="iconComponent" class="size-4 shrink-0 text-reasoning" />
      <span class="font-mono text-[13px] font-medium text-fg">{{ command.name }}</span>
      <span class="ml-auto rounded-sm bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted">{{ sourceLabel }}</span>
    </header>
    <!-- 文档体：skill 命令渲染完整 SKILL.md；非 skill 渲染 description 信息卡 -->
    <div class="min-h-0 flex-1 overflow-auto p-3">
      <template v-if="skill">
        <!-- skill 完整文档（SKILL.md 经 markdown 渲染） -->
        <div v-if="skill.description" class="mb-3 text-[13px] text-muted">{{ skill.description }}</div>
        <MarkdownRenderer v-if="skill.content" :content="skill.content" />
        <div v-else class="py-6 text-center text-[12px] text-subtle">该 skill 无文档正文</div>
        <!-- skill 元信息：sourcePath / tools / triggers -->
        <div v-if="skill.sourcePath" class="mt-4 border-t border-border pt-3">
          <p class="text-[11px] text-subtle">路径</p>
          <p class="mt-0.5 break-all font-mono text-[11px] text-muted">{{ skill.sourcePath }}</p>
        </div>
      </template>
      <!-- 非 skill 命令：信息卡 -->
      <div v-else class="flex h-full flex-col items-start gap-2 py-2">
        <p v-if="command.description" class="text-[13px] leading-[1.6] text-fg">{{ command.description }}</p>
        <p v-else class="text-[12px] text-subtle">该命令无详细描述</p>
        <p class="mt-1 text-[11px] text-subtle">
          {{ command.kind === 'extension' ? '扩展命令' : command.kind === 'builtin' ? '内置命令' : '命令' }}，
          无完整文档（仅 description）。
        </p>
      </div>
    </div>
  </section>
  <!-- 无选中命令 → 空态（SideDrawer v-else 兜底，此处理论上不达，但防御性保留） -->
  <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
    <p class="text-[12px] text-subtle">未选择命令</p>
    <p class="text-[11px] text-subtle opacity-50">点击用户气泡中的命令 chip 查看文档</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Wrench } from '@lucide/vue'
import type { Component } from 'vue'
import type { SkillInfo } from '@xyz-agent/shared'
import { useCommandStore } from '@/stores/command'
import { useSettingsStore } from '@/stores/settings'
import { useSideDrawer } from '@/composables/features/useSideDrawer'
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'
import MarkdownRenderer from './message-stream/MarkdownRenderer.vue'

const props = defineProps<{
  /** drawer 所属 panel 的 session（查 commandStore 用） */
  sessionId: string | null
}>()

const commandStore = useCommandStore()
const settings = useSettingsStore()
const { selectedCommandName } = useSideDrawer()

/** 当前选中的 SessionCommand（从 commandStore 查） */
const command = computed(() => {
  const name = selectedCommandName.value
  const sid = props.sessionId
  if (!name || !sid) return null
  return commandStore.findCommandByName(sid, name) ?? null
})

/**
 * skill 命令 join SkillInfo：去 / 后按 skill.name 或 triggers 匹配。
 * 非 skill 命令（extension/builtin）返回 null → 走信息卡分支。
 */
const skill = computed<SkillInfo | null>(() => {
  const cmd = command.value
  if (!cmd || cmd.kind !== 'skill') return null
  const bareName = cmd.name.replace(/^\//, '')
  return (
    settings.skills.find((s) => s.name === bareName || s.triggers?.includes(bareName)) ?? null
  )
})

/** source 标签：skill→「Skill」、extension→「Extension」、builtin→「内置」 */
const sourceLabel = computed(() => {
  const kind = command.value?.kind
  if (kind === 'skill') return 'Skill'
  if (kind === 'extension') return 'Extension'
  if (kind === 'builtin') return '内置'
  return kind ?? ''
})

/** chip/命令 icon → lucide 组件（复用 SLASH_ICON_COMPONENTS，与选择框/chip 同源） */
const iconComponent = computed<Component>(() => {
  const iconKey = command.value?.icon
  return (
    (iconKey ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS] : undefined) ??
    Wrench
  )
})
</script>
