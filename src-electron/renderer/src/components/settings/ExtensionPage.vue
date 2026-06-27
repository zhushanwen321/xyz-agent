<template>
  <!--
    Settings · Extension 菜单页（issues.md #5 方案 A · 安装多步流 + 内联候选展开 + 卸载确认）。
    刷新机制：finishInstall/uninstall 后 runtime 推 config.extensions → onExtensions 订阅（SettingsModal 持有）
    → extensions prop 流入本页，无需本页自建订阅。
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
          @keyup.enter="onInstall"
        />
        <Button
          class="h-8 shrink-0 rounded-sm px-3 text-[12px]"
          :disabled="!installInput.trim() || installing"
          @click="onInstall"
        >
          <Loader2 v-if="installing" class="animate-spin" />
          安装
        </Button>
      </div>
      <!-- 错误反馈（非静默吞，CLAUDE.md 规则 #3） -->
      <div v-if="actionError" class="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px] text-danger">
        <AlertCircle class="size-3.5 shrink-0" />
        <span class="truncate">{{ actionError }}</span>
      </div>
    </section>

    <!-- 候选内联展开（dir/git 多步第二步，§6.3 点3：安装区下方直接展开） -->
    <section v-if="discovered" class="rounded-md border border-border bg-bg">
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 class="text-[12px] font-medium text-fg">发现 {{ discovered.candidates.length }} 个候选</h3>
        <Button variant="ghost" class="h-auto px-2 py-0.5 text-[11px] text-subtle" @click="onCancelInstall">取消</Button>
      </div>
      <div v-if="!discovered.candidates.length" class="py-4 text-center text-[11px] text-muted">该来源未发现可安装的扩展</div>
      <div v-else class="flex flex-col gap-0.5 p-2">
        <Label
          v-for="c in discovered.candidates"
          :key="c.dirName"
          class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-surface"
        >
          <!-- 候选多选：Checkbox 受控（selected Set 管理，dirName 为 key）；点击 Label 文字区也触发切换 -->
          <Checkbox
            :model-value="selected.has(c.dirName)"
            class="shrink-0"
            @update:model-value="toggleCandidate(c.dirName)"
          />
          <div class="min-w-0 flex-1" @click="toggleCandidate(c.dirName)">
            <div class="flex items-center gap-2">
              <span class="truncate text-[12px] text-fg">{{ c.name }}</span>
              <span class="rounded-sm bg-surface px-1 py-0.5 font-mono text-[10px] text-subtle">{{ c.dirName }}</span>
              <span class="font-mono text-[10px] text-subtle">v{{ c.version }}</span>
            </div>
            <span class="truncate text-[11px] text-muted">{{ c.description }}</span>
          </div>
        </Label>
      </div>
      <div v-if="discovered.candidates.length" class="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span class="text-[11px] text-subtle">已选 {{ selected.size }} / {{ discovered.candidates.length }}</span>
        <Button size="dense" :disabled="selected.size === 0 || installing" @click="onFinishInstall">
          <Loader2 v-if="installing" class="animate-spin" />
          安装选中
        </Button>
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
        <!-- 启用开关：Switch 原语（状态经 onExtensions 订阅推回） -->
        <Switch
          :model-value="ext.enabled"
          class="shrink-0"
          :aria-label="ext.enabled ? '禁用扩展' : '启用扩展'"
          @update:model-value="onToggle(ext, $event)"
        />
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

    <!-- 卸载确认弹窗（hide-close：内容区已有「取消」按钮作为唯一关闭入口） -->
    <Dialog :open="!!confirmTarget" @update:open="confirmTarget = ''">
      <DialogContent hide-close class="max-w-[360px]">
        <DialogHeader>
          <DialogTitle>卸载 {{ confirmTarget }}？</DialogTitle>
          <DialogDescription>此操作不可撤销，扩展将从本地移除。</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-4">
          <Button variant="ghost" :disabled="uninstalling" @click="confirmTarget = ''">取消</Button>
          <Button variant="danger" :disabled="uninstalling" @click="onConfirmUninstall">
            <Loader2 v-if="uninstalling" class="animate-spin" />
            卸载
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Trash2, Loader2, AlertCircle } from '@lucide/vue'
import type { ExtensionDiscoveredPayload } from '@xyz-agent/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
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
/** 动作错误（install/toggle/uninstall 失败时显示，非静默吞） */
const actionError = ref('')
/** 安装中（install/discover/finish 共用 loading） */
const installing = ref(false)
/** 卸载中 */
const uninstalling = ref(false)
/** dir/git 安装发现的候选（多步第一步产物）；null 表示未进入候选选择阶段 */
const discovered = ref<ExtensionDiscoveredPayload | null>(null)
/** 候选多选（key = dirName，finishInstall 的 selected 语义） */
const selected = ref<Set<string>>(new Set())

const tabPlaceholder = computed(() => {
  const map: Record<string, string> = {
    npm: 'npm:package-name',
    dir: '/path/to/extension',
    git: 'https://github.com/...',
  }
  return map[activeTab.value] ?? ''
})

// 切换 tab 清空已发现候选（不同来源的候选不再适用）
watch(activeTab, () => {
  discovered.value = null
  selected.value = new Set()
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

/** 安装入口：npm 单步直装；dir/git 多步（先发现候选，内联展开） */
async function onInstall() {
  const input = installInput.value.trim()
  if (!input || installing.value) return
  actionError.value = ''
  installing.value = true
  try {
    if (activeTab.value === 'npm') {
      await extensionApi.install(input)
      installInput.value = ''
    } else if (activeTab.value === 'dir') {
      const result = await extensionApi.installDir(input)
      setDiscovered(result)
    } else {
      const result = await extensionApi.installGitRepository(input)
      setDiscovered(result)
    }
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
    discovered.value = null
  } finally {
    installing.value = false
  }
}

/** 记录发现结果，默认全选（常见 UX：一次性装全部候选，用户可逐项取消） */
function setDiscovered(result: ExtensionDiscoveredPayload) {
  discovered.value = result
  selected.value = new Set(result.candidates.map((c) => c.dirName))
}

/** 切换候选选中态（dirName 为 key） */
function toggleCandidate(dirName: string) {
  const next = new Set(selected.value)
  if (next.has(dirName)) next.delete(dirName)
  else next.add(dirName)
  selected.value = next
}

/** 完成安装：把选中候选从 tempDir 装入 extensions/，runtime 推 config.extensions 刷新列表 */
async function onFinishInstall() {
  if (!discovered.value || selected.value.size === 0 || installing.value) return
  actionError.value = ''
  installing.value = true
  const { tempDir } = discovered.value
  const selectedNames = [...selected.value]
  try {
    await extensionApi.finishInstall(tempDir, selectedNames)
    discovered.value = null
    selected.value = new Set()
    installInput.value = ''
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    installing.value = false
  }
}

/** 放弃安装：清理 tempDir，退出候选选择 */
async function onCancelInstall() {
  if (!discovered.value) return
  const { tempDir } = discovered.value
  discovered.value = null
  selected.value = new Set()
  try {
    await extensionApi.cancelInstall(tempDir)
  } catch (e) {
    // tempDir 清理失败仅记录，不阻塞 UI（候选区已关闭）。临时文件可能未清理，需手动检查。
    const baseMsg = e instanceof Error ? e.message : String(e)
    actionError.value = `${baseMsg}（临时文件可能未清理）`
  }
}

/** 卸载确认 → extension.uninstall（runtime 推 config.extensions 刷新列表） */
async function onConfirmUninstall() {
  if (!confirmTarget.value || uninstalling.value) return
  actionError.value = ''
  uninstalling.value = true
  const name = confirmTarget.value
  try {
    await extensionApi.uninstall(name)
    confirmTarget.value = ''
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    uninstalling.value = false
  }
}
</script>
