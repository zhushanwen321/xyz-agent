<template>
  <!--
    Settings · Extension 菜单页（issues.md #5 方案 A · 安装多步流 + 内联候选展开 + 卸载确认）。
    刷新机制：finishInstall/uninstall 后 runtime 推 config.extensions → onExtensions 订阅（SettingsModal 持有）
    → extensions prop 流入本页，无需本页自建订阅。
  -->
  <div class="flex flex-col gap-4">
    <!-- 推荐扩展区：快捷一键安装 builtin pi-extensions（SSOT = recommended-extensions.json）。
         onMounted 拉取 installed 状态；install 后 watch(extensions) 刷新。-->
    <section v-if="recommended.length" class="rounded-md border border-border bg-bg">
      <div class="border-b border-border px-3 py-2">
        <h3 class="text-[12px] font-medium text-fg">推荐扩展</h3>
      </div>
      <div class="flex flex-col gap-0.5 p-2">
        <div
          v-for="r in recommended"
          :key="r.name"
          class="flex items-center gap-3 rounded-sm px-2 py-2 hover:bg-surface"
        >
          <div class="min-w-0 flex-1 flex flex-col gap-0.5">
            <span class="truncate text-[12px] font-medium text-fg">{{ r.name }}</span>
            <span class="truncate text-[11px] text-muted">{{ r.description }}</span>
          </div>
          <!-- 已安装：disabled + Check 图标；未安装：点击调 install(npm:pkgName) -->
          <Button
            variant="ghost"
            size="dense"
            class="shrink-0 rounded-sm text-[11px]"
            :disabled="r.installed || installingRecommended.has(r.name)"
            @click="onInstallRecommended(r.name)"
          >
            <Loader2 v-if="installingRecommended.has(r.name)" class="animate-spin" />
            <Check v-else-if="r.installed" />
            {{ r.installed ? '已安装' : '安装' }}
          </Button>
        </div>
      </div>
    </section>

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
          {{ installButtonText }}
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
          <!--
            候选多选（W2 D3 修复）：Checkbox 受控（selected Set 管理，dirName 为 key）。
            原实现还在内层 div 上绑了 @click="toggleCandidate"，导致双触发——
            点击文字区时浏览器把 Label 的 click 转发给 labelable 的 Checkbox（→ update:model-value
            → toggleCandidate 加），同时 div @click 又触发 toggleCandidate（减），两次翻转抵消，
            勾选框不变化。现去掉 div @click，仅靠 Label→Checkbox 转发 + update:model-value 单通道。
          -->
          <Checkbox
            :model-value="selected.has(c.dirName)"
            class="shrink-0"
            @update:model-value="toggleCandidate(c.dirName)"
          />
          <div class="min-w-0 flex-1">
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
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-subtle">已选 {{ selected.size }} / {{ discovered.candidates.length }}</span>
          <Button variant="ghost" size="dense" class="h-auto px-1.5 py-0.5 text-[11px] text-subtle hover:text-fg" @click="toggleSelectAll">
            {{ isAllSelected ? '取消全选' : '全选' }}
          </Button>
        </div>
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
            <!-- 来源标签 -->
            <span v-if="ext.source === 'user-installed'" class="rounded-sm bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">user</span>
          </div>
          <span class="truncate text-[11px] text-muted">{{ ext.description }}</span>
          <div v-if="ext.tools?.length" class="mt-1 flex flex-wrap gap-1">
            <span v-for="t in ext.tools" :key="t" class="rounded-sm bg-surface px-1 py-0.5 font-mono text-[10px] text-subtle">{{ t }}</span>
          </div>
          <!-- 自动升级开关（仅 user-installed 扩展显示） -->
          <div v-if="ext.source === 'user-installed'" class="mt-1.5 flex items-center gap-2">
            <Switch
              :model-value="ext.autoUpgrade ?? false"
              class="shrink-0"
              :disabled="toggling.has(ext.name)"
              aria-label="自动升级"
              @update:model-value="onSetAutoUpgrade(ext, $event)"
            />
            <span class="text-[11px] text-muted">自动升级</span>
          </div>
        </div>
        <!-- 启用开关：Switch 原语。乐观更新——点击立即改 store（开关即时滑动），API 失败回滚。 -->
        <Switch
          :model-value="ext.enabled"
          class="shrink-0"
          :disabled="toggling.has(ext.name)"
          :aria-label="ext.enabled ? '禁用扩展' : '启用扩展'"
          @update:model-value="onToggle(ext, $event)"
        />
        <!-- 升级按钮（仅 user-installed 扩展显示） -->
        <Button
          v-if="ext.source === 'user-installed'"
          variant="ghost"
          class="size-7 shrink-0 rounded-sm p-0 text-subtle hover:bg-accent-soft hover:text-accent [&_svg]:size-3.5"
          title="升级"
          :disabled="upgrading.has(ext.name)"
          @click="onUpgrade(ext.name)"
        >
          <Loader2 v-if="upgrading.has(ext.name)" class="animate-spin" />
          <ArrowUpCircle v-else />
        </Button>
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

    <!-- 卸载确认弹窗（ConfirmDialog 原语：标题+描述+取消/危险确认，loading 态显 spinner） -->
    <ConfirmDialog
      v-model:open="uninstallDialogOpen"
      variant="danger"
      :title="`卸载 ${confirmTarget}？`"
      description="此操作不可撤销，扩展将从本地移除。"
      confirm-text="卸载"
      cancel-text="取消"
      :loading="uninstalling"
      @confirm="onConfirmUninstall"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { Trash2, Loader2, AlertCircle, Check, ArrowUpCircle } from '@lucide/vue'
import type { ExtensionDiscoveredPayload, RecommendedExtension } from '@xyz-agent/shared'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { extension as extensionApi } from '@/api'
import { useSettingsStore, type ExtensionItem } from '@/stores/settings'
import { useToast } from '@/composables/useToast'

const props = defineProps<{ extensions: ExtensionItem[] }>()
const settingsStore = useSettingsStore()
const { info: toastInfo } = useToast()

/** toggle 中的扩展名集合（防双击：API 期间 disable Switch） */
const toggling = ref<Set<string>>(new Set())

const tabs = [
  { id: 'npm', label: 'npm' },
  { id: 'dir', label: 'Local Dir' },
  { id: 'git', label: 'Git URL' },
] as const

/**
 * 推荐扩展列表（含已安装状态）。
 * onMounted 拉取；extensions prop 变化（install/uninstall 后 runtime 推 config.extensions）
 * 时重新拉取，确保 installed 状态及时更新。
 */
const recommended = ref<Array<RecommendedExtension & { installed: boolean }>>([])
/** 推荐扩展安装中（按包名 key，支持并发不同包；同包重复点击 disabled 防抖） */
const installingRecommended = ref<Set<string>>(new Set())

async function refreshRecommended() {
  try {
    recommended.value = await extensionApi.fetchRecommended()
  } catch (e) {
    // 拉取失败仅记录到 actionError，不阻塞页面其余功能
    actionError.value = e instanceof Error ? `加载推荐扩展失败: ${e.message}` : `加载推荐扩展失败: ${String(e)}`
  }
}

onMounted(refreshRecommended)
// extensions prop 变化后刷新推荐列表的 installed 状态（install/uninstall/toggle 都会触发）
watch(() => props.extensions, refreshRecommended)

/** 推荐扩展一键安装：自动补 npm: 前缀 */
async function onInstallRecommended(pkgName: string) {
  if (installingRecommended.value.has(pkgName)) return
  actionError.value = ''
  const next = new Set(installingRecommended.value)
  next.add(pkgName)
  installingRecommended.value = next
  try {
    await extensionApi.install(`npm:${pkgName}`)
    toastInfo('扩展已安装')
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    const after = new Set(installingRecommended.value)
    after.delete(pkgName)
    installingRecommended.value = after
  }
}

const activeTab = ref<'npm' | 'dir' | 'git'>('npm')
const installInput = ref('')
const confirmTarget = ref('')
/** 卸载弹窗开关：派生自 confirmTarget（有目标即开），关闭时清空目标 */
const uninstallDialogOpen = computed({
  get: () => confirmTarget.value !== '',
  set: (open: boolean) => {
    if (!open) confirmTarget.value = ''
  },
})
/** 动作错误（install/toggle/uninstall 失败时显示，非静默吞） */
const actionError = ref('')
/** 安装中（install/discover/finish 共用 loading） */
const installing = ref(false)
/** 卸载中 */
const uninstalling = ref(false)
/** 升级中的扩展名集合（支持并发不同扩展） */
const upgrading = ref<Set<string>>(new Set())
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

/** 第一层按钮文案：npm 单步直装→"安装"；dir/git 多步流先发现候选→"发现" */
const installButtonText = computed(() => activeTab.value === 'npm' ? '安装' : '发现')

// 切换 tab 清空已发现候选（不同来源的候选不再适用）
watch(activeTab, () => {
  discovered.value = null
  selected.value = new Set()
})

/** 启用开关 → 乐观更新 store（开关即时滑动）+ extension.toggle 持久化。
 * 乐观：先改 store，UI 立即反应；失败回滚 store + 报错。
 * 广播回来时权威值覆盖 store（幂等：若值一致无副作用）。 */
async function onToggle(ext: ExtensionItem, enabled: boolean) {
  if (toggling.value.has(ext.name)) return
  actionError.value = ''
  // 防双击
  const next = new Set(toggling.value)
  next.add(ext.name)
  toggling.value = next
  // 乐观：立即改 store
  const old = settingsStore.setExtensionEnabled(ext.name, enabled)
  try {
    await extensionApi.toggle(ext.name, enabled)
  } catch (e) {
    // 回滚
    settingsStore.setExtensionEnabled(ext.name, old)
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    const after = new Set(toggling.value)
    after.delete(ext.name)
    toggling.value = after
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
      // 自动补 npm: 前缀（runtime installExtension 强制要求，placeholder 仅提示不强制）
      const source = input.startsWith('npm:') ? input : `npm:${input}`
      await extensionApi.install(source)
      installInput.value = ''
      toastInfo('扩展已安装')
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
  // 默认不勾选——用户手动选择要安装的 extension，避免误装
  selected.value = new Set()
}

/** 切换候选选中态（dirName 为 key） */
function toggleCandidate(dirName: string) {
  const next = new Set(selected.value)
  if (next.has(dirName)) next.delete(dirName)
  else next.add(dirName)
  selected.value = next
}

/** 是否全选（用于全选/取消全选按钮文案切换） */
const isAllSelected = computed(() =>
  !!discovered.value
  && discovered.value.candidates.length > 0
  && selected.value.size === discovered.value.candidates.length,
)

/** 全选/取消全选候选 */
function toggleSelectAll() {
  if (!discovered.value) return
  selected.value = isAllSelected.value
    ? new Set()
    : new Set(discovered.value.candidates.map((c) => c.dirName))
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
    toastInfo('扩展已安装')
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
    toastInfo('扩展已卸载')
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    uninstalling.value = false
  }
}

/** 升级扩展：从 npm 拉最新版重装（仅 user-installed） */
async function onUpgrade(name: string) {
  if (upgrading.value.has(name)) return
  actionError.value = ''
  const next = new Set(upgrading.value)
  next.add(name)
  upgrading.value = next
  try {
    await extensionApi.upgrade(name)
    toastInfo('扩展已升级')
  } catch (e) {
    actionError.value = e instanceof Error ? `升级失败: ${e.message}` : `升级失败: ${String(e)}`
  } finally {
    const after = new Set(upgrading.value)
    after.delete(name)
    upgrading.value = after
  }
}

/** 设置扩展自动升级开关（仅 user-installed）→ 乐观更新 + 持久化。 */
async function onSetAutoUpgrade(ext: ExtensionItem, enabled: boolean) {
  if (toggling.value.has(ext.name)) return
  actionError.value = ''
  const next = new Set(toggling.value)
  next.add(ext.name)
  toggling.value = next
  const old = settingsStore.setExtensionAutoUpgrade(ext.name, enabled)
  try {
    await extensionApi.setAutoUpgrade(ext.name, enabled)
  } catch (e) {
    settingsStore.setExtensionAutoUpgrade(ext.name, old)
    actionError.value = e instanceof Error ? `设置自动升级失败: ${e.message}` : `设置自动升级失败: ${String(e)}`
  } finally {
    const after = new Set(toggling.value)
    after.delete(ext.name)
    toggling.value = after
  }
}
</script>
