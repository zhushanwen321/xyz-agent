<script setup lang="ts">
/**
 * ProjectSwitcher —— v6 D14 Project 一级导航（spec §6.2）。
 *
 * 常驻默认展开（无折叠下拉）：project 列表（按最近使用排序，hover 出删除）+ 「+ 新建项目」。
 *  - 新建：点击展开 input，Enter 创建（Esc 取消 / blur 提交），创建后设为活跃 project。
 *  - 删除：点击 trash → ConfirmDialog（variant danger）确认 → removeProject；
 *    删活跃项自动切首个；保底不删最后一个（store.removeProject 守卫）。
 *
 * TODO（followup，本次只做 UI + store + 自动归因 + 过滤）：
 *  - workspace 管理 UI（手动添加/移除 workspace 到 project）。
 *  - store 持久化迁移到 runtime RPC（~/.xyz-agent/projects.json，跨设备一致）。
 *
 * 已实现（2026-08-04）：
 *  - session 按 activeProject.workspaces 过滤分组（SessionList 消费 activeWorkspaceCwds，
 *    默认 project 显示全部，命名 project 只显示归入 cwd 的 session）。
 *  - 自动归因：新建 session 成功后把 cwd 归入 activeProject（useNewTaskFlow createSession 端口）。
 */
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { Trash2, Plus } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useProjectStore } from '@/stores/project'

const { t } = useI18n()
const projectStore = useProjectStore()

// ── 当前 project（name 空时 fallback i18n defaultName，store 不依赖 i18n）——
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
  <div class="mb-1 flex flex-col gap-px px-1">
    <!-- project 列表（常驻默认展开，无折叠下拉）。
         遵循 sidebar 范式（对齐 nav/SessionItem）：无边框、明度差分隔、rounded-md、
         active=bg-surface+accent 圆点指示、ghost 次操作。按 recentProjects 排序
         （activeProject 第一 + 其余 lastUsedAt 降序）；max-h-36 限可视区约 5 项，overflow-y-auto 滚动。 -->
    <div
      data-testid="project-list"
      class="flex max-h-36 flex-col gap-px overflow-y-auto"
    >
      <!-- list item：div role=button + active 圆点指示 + 行内删除 Button（避免 button 嵌套 button） -->
      <div
        v-for="p in projectStore.recentProjects"
        :key="p.id"
        data-testid="project-item"
        role="button"
        tabindex="0"
        class="group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="p.id === projectStore.activeProjectId
          ? 'bg-surface text-accent'
          : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'"
        @click="select(p.id)"
        @keydown.enter="select(p.id)"
      >
        <!-- active 指示圆点（对齐 SessionItem：active=accent 实心 / 非 active=透明占位，阴阳分明） -->
        <span
          class="size-2 shrink-0 rounded-full transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
          :class="p.id === projectStore.activeProjectId ? 'bg-accent' : 'bg-transparent'"
          aria-hidden="true"
        />
        <span class="flex-1 truncate">{{ p.name || t('sidebar.projectSwitcher.defaultName') }}</span>
        <!-- 删除按钮：多 project 时才显（保底不删最后一个）；hover item 淡入 -->
        <Button
          v-if="projectStore.projects.length > 1"
          variant="ghost"
          class="size-5 shrink-0 rounded-sm p-0 text-neutral-dim opacity-0 transition-opacity duration-[var(--duration-fast)] hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
          :title="t('sidebar.projectSwitcher.deleteProject')"
          :aria-label="t('sidebar.projectSwitcher.deleteProject')"
          @click.stop="requestDelete(p.id)"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </div>
    </div>

    <!-- 新建项目（ghost 次操作，对齐 nav 搜索按钮范式；滚动区外常驻；input / 按钮 互斥） -->
    <Input
      v-if="creating"
      ref="inputRef"
      v-model="draft"
      class="h-8 rounded-md border-border-strong bg-bg-input px-2.5 text-[12px] text-neutral-fg"
      :placeholder="t('sidebar.projectSwitcher.namePlaceholder')"
      @keydown.enter.prevent="commitCreate"
      @keydown.esc.prevent="cancelCreate"
      @blur="commitCreate"
    />
    <Button
      v-else
      variant="ghost"
      class="h-8 w-full justify-start gap-2.5 rounded-md px-2.5 text-[12px] text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-mid"
      @click="startCreate"
    >
      <Plus class="size-[15px] text-neutral-dim" />
      <span>{{ t('sidebar.projectSwitcher.newProject') }}</span>
    </Button>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('sidebar.projectSwitcher.deleteTitle')"
      :description="t('sidebar.projectSwitcher.deleteDesc', { name: pendingDeleteName || currentName })"
      :confirm-text="t('sidebar.projectSwitcher.deleteConfirm')"
      :cancel-text="t('sidebar.projectSwitcher.cancel')"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>
