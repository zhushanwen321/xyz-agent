<!--
  容器组件 · Settings modal（settings/spec.md · 居中 modal + 模糊背景）。
  数据来自 settings store（单一真相源：providers/skills/agents/extensions/system）。
  store 由 AppShell 应用级 init（常驻订阅），本组件只读 store + open 时刷新 providers。
  5 菜单导航 + 右侧对应页面组件。
-->
<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      hide-close
      class="flex max-h-[85vh] max-w-[900px] flex-col gap-0 overflow-hidden p-0 sm:rounded-lg"
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
              <SettingsResourcePage
                v-else-if="activeMenu === 'skill'"
                kind="skill"
                :items="skills"
                :dirs="skillDirs"
                @update-dirs="onUpdateSkillDirs"
              />
              <SettingsResourcePage
                v-else-if="activeMenu === 'agent'"
                kind="agent"
                :items="agents"
                :dirs="agentDirs"
                @update-dirs="onUpdateAgentDirs"
              />
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
import { storeToRefs } from 'pinia'
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
import { useSettingsStore, type SystemSettings } from '@/stores/settings'
import { useSettings } from '@/composables/features/useSettings'
import { useToast } from '@/composables/useToast'
import type { SkillDirConfig } from '@xyz-agent/shared'
import ProviderPage from './ProviderPage.vue'
import SettingsResourcePage from './SettingsResourcePage.vue'
import ExtensionPage from './ExtensionPage.vue'
import SystemPage from './SystemPage.vue'

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

// 数据来自 settings store（单一真相源，AppShell 应用级 init 常驻订阅）。
// storeToRefs 保持响应性解构。
const settingsStore = useSettingsStore()
const { providers, skills, agents, extensions, system, skillDirs, agentDirs } = storeToRefs(settingsStore)
const { refreshProviders } = useSettings()

// 打开时刷新 providers（拿最新快照）；skills/agents/extensions 靠订阅，无需主动拉。
watch(() => props.open, (isOpen) => {
  if (isOpen) refreshProviders()
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

/** SystemPage 偏好更新 → 走 store（写 localStorage + 同步 DOM data-theme + i18n）+ toast 反馈。 */
const { info: toastInfo, error: toastError } = useToast()
async function onSystemUpdate(patch: Partial<SystemSettings>) {
  try {
    await settingsStore.setSystem(patch)
    toastInfo('已应用')
   
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/**
 * SkillPage 加载路径变更 → 走 store（写 discovery.json，ADR-0020 §1）。
 * W2 D10 修复：setSkillDirs 是 async（store 内 await config.setSkillDirs），原实现未 await 未 catch，
 * reject 时 unhandled rejection + 静默失败。现 await + try/catch + toast error 反馈（CLAUDE.md 规则 #3）。
 */
async function onUpdateSkillDirs(dirs: SkillDirConfig[]) {
  // 只把 enabled 路径写进 discovery（目录在 = 启用，ADR §5）
  try {
    await settingsStore.setSkillDirs(dirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

/** AgentPage 加载路径变更 → 走 store（写 discovery.json），语义同 onUpdateSkillDirs。 */
async function onUpdateAgentDirs(dirs: SkillDirConfig[]) {
  try {
    await settingsStore.setAgentDirs(dirs.filter((d) => d.enabled).map((d) => d.path))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}
</script>
