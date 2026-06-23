<template>
  <!--
    Settings · Extension 菜单页（handoff-extension.md · 安装区 + Entity List + 卸载确认）。
  -->
  <div class="flex flex-col gap-4">
    <!-- 安装区 -->
    <section class="rounded-md border border-border bg-bg">
      <div class="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          v-for="tab in tabs"
          :key="tab.id"
          class="h-auto rounded-sm px-2.5 py-1 text-[12px]"
          :class="activeTab === tab.id ? 'bg-surface-hover text-fg' : 'text-muted hover:text-fg'"
          @click="activeTab = tab.id"
        >{{ tab.label }}</Button>
      </div>
      <div class="flex items-center gap-2 p-3">
        <Input
          v-model="installInput"
          class="h-8 flex-1 text-[12px]"
          :placeholder="tabPlaceholder"
        />
        <Button
          class="h-8 shrink-0 rounded-sm px-3 text-[12px]"
          :disabled="!installInput.trim()"
        >安装</Button>
      </div>
    </section>

    <!-- 已安装列表 -->
    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-fg">已安装</h3>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-subtle">{{ extensions.length }}</span>
      </div>

      <div v-if="!extensions.length" class="py-8 text-center text-[12px] text-muted">暂无扩展</div>

      <div v-for="ext in extensions" :key="ext.name" class="flex items-center gap-3 rounded-md border border-border bg-bg px-3 py-2.5">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex items-center gap-2">
            <span class="truncate text-[12px] font-medium text-fg">{{ ext.name }}</span>
            <span class="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">v{{ ext.version }}</span>
          </div>
          <span class="truncate text-[11px] text-muted">{{ ext.description }}</span>
          <div v-if="ext.tools.length" class="mt-1 flex flex-wrap gap-1">
            <span v-for="t in ext.tools" :key="t" class="rounded-sm bg-surface px-1 py-0.5 font-mono text-[10px] text-subtle">{{ t }}</span>
          </div>
        </div>
        <!-- 启用开关：调 extension.toggle 持久化 -->
        <Label class="relative inline-flex shrink-0 cursor-pointer" @click.stop>
          <input type="checkbox" :checked="ext.enabled" class="peer sr-only" @change="onToggle(ext, ($event.target as HTMLInputElement).checked)" />
          <div class="h-5 w-9 rounded-full bg-border-strong after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-full" />
        </Label>
        <!-- 卸载按钮 -->
        <Button
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-subtle hover:bg-[rgba(239,68,68,0.12)] hover:text-danger [&_svg]:size-3.5"
          title="卸载"
          @click="confirmTarget = ext.name"
        >
          <Trash2 />
        </Button>
      </div>
    </section>

    <!-- 卸载确认弹窗 -->
    <Dialog :open="!!confirmTarget" @update:open="confirmTarget = ''">
      <DialogContent class="max-w-[360px]">
        <DialogHeader>
          <DialogTitle>卸载 {{ confirmTarget }}？</DialogTitle>
          <DialogDescription>此操作不可撤销，扩展将从本地移除。</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button variant="ghost" @click="confirmTarget = ''">取消</Button>
          <Button variant="danger" @click="confirmTarget = ''">卸载</Button>
        </div>
        <!-- 注：卸载属 install/uninstall 多步流，D10 推后，本轮仅 UI 占位 -->
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Trash2 } from '@lucide/vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { extension as extensionApi } from '@/api'

interface ExtensionItem {
  name: string
  version: string
  description: string
  enabled: boolean
  tools: string[]
}

defineProps<{ extensions: ExtensionItem[] }>()

const tabs = [
  { id: 'npm', label: 'npm' },
  { id: 'dir', label: 'Local Dir' },
  { id: 'git', label: 'Git URL' },
] as const

const activeTab = ref<'npm' | 'dir' | 'git'>('npm')
const installInput = ref('')
const confirmTarget = ref('')
/** 动作错误（toggle 失败时显示，非静默吞） */
const actionError = ref('')

const tabPlaceholder = computed(() => {
  const map: Record<string, string> = {
    npm: 'npm:package-name',
    dir: '/path/to/extension',
    git: 'https://github.com/...',
  }
  return map[activeTab.value] ?? ''
})

/** 启用开关 → extension.toggle（状态经 onExtensions 订阅推回）。
 * 失败记录错误供 UI 反馈；onExtensions 订阅未变 → 开关视觉态自动恢复。 */
async function onToggle(ext: ExtensionItem, enabled: boolean) {
  actionError.value = ''
  try {
    await extensionApi.toggle(ext.name, enabled)
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}
</script>
