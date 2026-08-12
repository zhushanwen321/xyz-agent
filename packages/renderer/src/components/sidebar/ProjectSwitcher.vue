<script setup lang="ts">
/**
 * ProjectSwitcher —— v6 D14 Project 一级导航（UI 形态对齐 v6 demo，spec §6.2）。
 *
 * 折叠态 = 当前 project 名 + 展开箭头；展开态 = project 列表（hover 出删除）+ 底部「+ 新建项目」。
 *  - 新建：点击展开 input，Enter 创建（Esc 取消 / blur 提交），创建后设为活跃 project。
 *  - 删除：点击 trash → ConfirmDialog（variant danger）确认 → removeProject；
 *    删活跃项自动切首个；保底不删最后一个（store.removeProject 守卫）。
 *  - 折叠时一并取消未提交的新建输入（demo toggle 语义）。
 *
 * 数据层（2026-08-04 语义修正 + 持久化迁移，恢复自 343453206^）：
 *  - session 按 projectId 直接关联过滤（SessionList 消费，默认项目 = 未归类 + 孤儿聚合）。
 *  - 自动归因：新建 session 归属当前 activeProject（create 透传 projectId）。
 *  - 手动归类：SessionItem「归入项目」菜单（session.setProject RPC）。
 *  - project 列表持久化迁 runtime projects.json（ProjectStore，localStorage 仅首启迁移）。
 */
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { ChevronDown, Folder, Plus, Trash2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useProjectStore } from '@/stores/project'

const { t } = useI18n()
const projectStore = useProjectStore()

// ── 折叠/展开两态（demo 形态：默认折叠，点击 toggle 展开列表）──
const expanded = ref(false)

function toggle() {
  expanded.value = !expanded.value
  // 折叠时一并取消未提交的新建输入
  if (!expanded.value) creating.value = false
}

// ── 当前 project（activeProject fallback 列表第一个；name 空时 fallback i18n defaultName）──
const current = computed(() => projectStore.activeProject)
const currentName = computed(
  () => current.value?.name || t('sidebar.projectSwitcher.defaultName'),
)

// ── 删除确认流（ConfirmDialog variant=danger）──
const deleteOpen = ref(false)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = computed(
  () => projectStore.projects.find((p) => p.id === pendingDeleteId.value)?.name ?? '',
)

// ── 新建流（input / 按钮 互斥）──
const creating = ref(false)
const draft = ref('')
const inputRef = ref<ComponentPublicInstance | null>(null)

function select(id: string) {
  projectStore.setActiveProject(id)
  expanded.value = false
}

function requestDelete(id: string) {
  pendingDeleteId.value = id
  deleteOpen.value = true
}

function confirmDelete() {
  if (pendingDeleteId.value) projectStore.removeProject(pendingDeleteId.value)
  pendingDeleteId.value = null
  deleteOpen.value = false
}

function startCreate() {
  creating.value = true
  draft.value = ''
  nextTick(() => {
    // Input 组件根元素是 <input>，template ref 拿到组件实例，$el 是 input DOM
    const el = inputRef.value?.$el
    if (el instanceof HTMLInputElement) el.focus()
  })
}

function commitCreate() {
  const name = draft.value.trim()
  if (name) projectStore.addProject(name)
  creating.value = false
  draft.value = ''
}

function cancelCreate() {
  creating.value = false
  draft.value = ''
}
</script>

<template>
  <div class="mb-1 mx-1 overflow-hidden rounded-md border border-border bg-bg-input">
    <!-- 折叠态：当前 project 行（ghost 行，点击展开/收起） -->
    <Button
      variant="ghost"
      type="button"
      class="flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-2 py-1.5 text-[12px] font-medium text-neutral-fg"
      :aria-expanded="expanded"
      data-testid="project-switcher-current"
      @click="toggle"
    >
      <Folder class="size-3.5 shrink-0 text-neutral-mid" />
      <span class="flex-1 truncate text-left">{{ currentName }}</span>
      <ChevronDown
        class="size-3 shrink-0 text-neutral-dim transition-transform duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="{ 'rotate-180': expanded }"
      />
    </Button>

    <!-- 展开态：project 列表（popover 范式：bg-elevated + border-strong + shadow-2） -->
    <div
      v-if="expanded"
      data-testid="project-list"
      class="flex max-h-36 flex-col gap-px overflow-y-auto border-t border-border-strong bg-bg-elevated p-1"
    >
      <!-- list item：div role=button + hover 出删除（避免 button 嵌套 button） -->
      <div
        v-for="p in projectStore.recentProjects"
        :key="p.id"
        data-testid="project-item"
        role="button"
        tabindex="0"
        class="group flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-[5px] text-[11px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="p.id === projectStore.activeProjectId
          ? 'bg-surface text-accent'
          : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'"
        @click="select(p.id)"
        @keydown.enter="select(p.id)"
      >
        <span class="flex-1 truncate">{{ p.name || t('sidebar.projectSwitcher.defaultName') }}</span>
        <!-- 删除按钮：命名 project 且多 project 时才显（保底不删最后一个；默认项目行永不显，review MF-1 双保险）；hover item 淡入 -->
        <Button
          v-if="p.name && projectStore.projects.length > 1"
          variant="ghost"
          class="size-5 shrink-0 rounded-sm p-0 text-neutral-dim opacity-0 transition-opacity duration-[var(--duration-fast)] hover:bg-danger-soft hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
          :title="t('sidebar.projectSwitcher.deleteProject')"
          :aria-label="t('sidebar.projectSwitcher.deleteProject')"
          @click.stop="requestDelete(p.id)"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>

      <!-- 新建项目：input / 按钮互斥 -->
      <div v-if="creating" class="p-0">
        <Input
          ref="inputRef"
          v-model="draft"
          class="mt-px h-[26px] rounded-sm border-border-strong bg-bg-input px-2 text-[11px] text-neutral-fg"
          :placeholder="t('sidebar.projectSwitcher.namePlaceholder')"
          @keydown.enter.prevent="commitCreate"
          @keydown.esc.prevent="cancelCreate"
          @blur="commitCreate"
        />
      </div>
      <Button
        v-else
        variant="ghost"
        type="button"
        class="mt-px h-auto w-full justify-start gap-1.5 rounded-sm px-1.5 py-[5px] text-[11px] text-neutral-dim"
        @click="startCreate"
      >
        <Plus class="size-3 shrink-0 text-neutral-dim" />
        <span>{{ t('sidebar.projectSwitcher.newProject') }}</span>
      </Button>
    </div>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('sidebar.projectSwitcher.deleteTitle')"
      :description="t('sidebar.projectSwitcher.deleteDesc', { name: pendingDeleteName || t('sidebar.projectSwitcher.defaultName') })"
      :confirm-text="t('sidebar.projectSwitcher.deleteConfirm')"
      :cancel-text="t('sidebar.projectSwitcher.cancel')"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>
