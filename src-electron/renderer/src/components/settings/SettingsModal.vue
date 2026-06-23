<template>
  <!--
    容器组件 · Settings modal（settings/spec.md · 居中 modal + 模糊背景）。
    数据来自 @/api/settings（mock: fixtureProviders/Skills/Agents/Extensions/System）。
    5 菜单导航 + 右侧对应页面组件。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      aria-modal="true"
      hide-close
      class="flex max-w-[900px] flex-col gap-0 overflow-hidden p-0 sm:rounded-lg"
    >
      <!-- modal-head -->
      <div class="modal-head flex h-[44px] flex-none items-center gap-2.5 border-b border-border px-3.5">
        <span class="text-[14px] font-semibold tracking-tight text-fg">设置</span>
        <div class="ml-auto flex items-center gap-2">
          <DialogClose
            class="grid size-7 place-items-center rounded-sm text-muted transition-colors hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="关闭（Esc）"
          >
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogClose>
        </div>
      </div>

      <!-- modal-body -->
      <div class="flex min-h-0 flex-1">
        <!-- 左导航 -->
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
            <span
              v-if="getItemCount(item.id)"
              class="ml-auto rounded-full bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle"
            >{{ getItemCount(item.id) }}</span>
          </Button>
        </nav>

        <!-- 右详情 -->
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div class="border-b border-border px-6 pb-4 pt-5">
            <h2 class="text-[20px] font-semibold tracking-tight text-fg">{{ currentMenu.label }}</h2>
            <p class="mt-0.5 text-[13px] text-muted">{{ currentMenu.desc }}</p>
          </div>
          <ScrollArea class="min-h-0 flex-1">
            <div class="px-6 py-4">
              <ProviderPage v-if="activeMenu === 'provider'" :providers="providers" />
              <SkillPage v-else-if="activeMenu === 'skill'" :skills="skills" />
              <AgentPage v-else-if="activeMenu === 'agent'" :agents="agents" />
              <ExtensionPage v-else-if="activeMenu === 'extension'" :extensions="extensions" />
              <SystemPage v-else-if="activeMenu === 'system'" :system="system" @update="onSystemUpdate" />
            </div>
          </ScrollArea>
        </div>
      </div>

      <DialogHeader class="sr-only">
        <DialogTitle>设置</DialogTitle>
        <DialogDescription>配置 Provider / Skill / Agent / Extension / System</DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
import { settings } from '@/api'
import type { ProviderInfo, SkillInfo, AgentInfo } from '@xyz-agent/shared'
import ProviderPage from './ProviderPage.vue'
import SkillPage from './SkillPage.vue'
import AgentPage from './AgentPage.vue'
import ExtensionPage from './ExtensionPage.vue'
import SystemPage from './SystemPage.vue'

interface ExtensionItem {
  name: string
  version: string
  description: string
  enabled: boolean
  tools: string[]
}

interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
}

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

// 数据状态
const providers = ref<ProviderInfo[]>([])
const skills = ref<SkillInfo[]>([])
const agents = ref<AgentInfo[]>([])
const extensions = ref<ExtensionItem[]>([])
const system = ref<SystemSettings>({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })

// 打开时加载数据
watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  const [p, s, a, e, sys] = await Promise.allSettled([
    settings.getProviders(),
    settings.getSkills(),
    settings.getAgents(),
    settings.getExtensions(),
    settings.getSystem(),
  ])
  if (p.status === 'fulfilled') providers.value = p.value
  if (s.status === 'fulfilled') skills.value = s.value
  if (a.status === 'fulfilled') agents.value = a.value
  if (e.status === 'fulfilled') extensions.value = e.value
  if (sys.status === 'fulfilled') system.value = sys.value
})

function getItemCount(id: string): number {
  switch (id) {
    case 'provider': return providers.value.length
    case 'skill': return skills.value.length
    case 'agent': return agents.value.length
    case 'extension': return extensions.value.length
    default: return 0
  }
}

async function onSystemUpdate(patch: Record<string, unknown>) {
  Object.assign(system.value, patch)
  await settings.updateSystem(patch)
}
</script>
