<script setup lang="ts">
/**
 * ProjectSwitcher —— v6 D14 Project 一级导航（spec §6.2）。
 *
 * 折叠态 = 当前 project 名 + 展开箭头；展开态 = project 列表（hover 出删除）+ 底部「+ 新建项目」。
 *  - 新建：点击展开 input，Enter 创建（Esc 取消 / blur 提交），创建后设为活跃 project。
 *  - 删除：点击 trash → ConfirmDialog（variant danger）确认 → removeProject；
 *    删活跃项自动切首个；保底不删最后一个（store.removeProject 守卫）。
 *
 * TODO（followup，本次只做 UI + store）：
 *  - session 按 activeProject.workspaces 过滤分组（当前 session 仍按 cwd 分组，不受本组件影响）。
 *  - workspace 管理 UI（添加/移除 workspace 到 project）。
 *  - store 持久化迁移到 runtime RPC（~/.xyz-agent/projects.json，跨设备一致）。
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
  <div class="mx-1 mb-1 overflow-hidden rounded-md border border-border bg-bg-input">
    <!-- project 列表（常驻默认展开，无折叠下拉）。
         按 recentProjects 排序（activeProject 第一 + 其余 lastUsedAt 降序）；
         max-h-32 限可视区约 5 项（5×~24px），overflow-y-auto 超出滚动。 -->
    <div
      data-testid="project-list"
      class="flex max-h-32 flex-col gap-px overflow-y-auto bg-bg-elevated p-1"
    >
      <!-- list item：div role=button + 行内删除 Button（避免 button 嵌套 button 无效 DOM） -->
      <div
        v-for="p in projectStore.recentProjects"
        :key="p.id"
        data-testid="project-item"
        role="button"
        tabindex="0"
        class="group flex cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="p.id === projectStore.activeProjectId
          ? 'bg-surface text-accent hover:bg-surface hover:text-accent'
          : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'"
        @click="select(p.id)"
        @keydown.enter="select(p.id)"
      >
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

    <!-- 新建项目（滚动区外，常驻底部；input / 按钮 互斥） -->
    <div class="border-t border-border-strong p-1">
      <Input
        v-if="creating"
        ref="inputRef"
        v-model="draft"
        class="h-[26px] rounded-sm border-border-strong bg-bg-input px-2 py-0 text-[11px] leading-none text-neutral-fg"
        :placeholder="t('sidebar.projectSwitcher.namePlaceholder')"
        @keydown.enter.prevent="commitCreate"
        @keydown.esc.prevent="cancelCreate"
        @blur="commitCreate"
      />
      <Button
        v-else
        variant="ghost"
        class="h-auto w-full justify-start gap-1.5 rounded-sm px-1.5 py-1 text-[11px] text-neutral-dim hover:bg-surface-hover hover:text-neutral-mid"
        @click="startCreate"
      >
        <Plus class="size-3" />
        <span>{{ t('sidebar.projectSwitcher.newProject') }}</span>
      </Button>
    </div>

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
