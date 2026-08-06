<template>
  <!--
    展示组件 · 会话列表（子视图 A，draft-five-states 卡 A/D）。
    按 cwd 分组渲染（D7：对齐后端 SessionGroup[]）—— 每组一个标题（cwd 末段）+ 组内 SessionItem 列表。
    按 activeProject.workspaces 过滤（v6 D14）：默认 project（name 空）显示全部；命名 project 只显示
    其 workspaces 对应 cwd 的组（session 与 project 的关联键 = cwd，见 shared/project.ts）。
    ScrollArea 包裹；空态（D，session 数=0）显示极淡「暂无会话」占位。
    v-model 语义用 activeId（单向：子→父 select）。
  -->
  <ScrollArea class="session-list h-full">
    <div class="flex flex-col px-1">
      <div
        v-for="g in visibleGroups"
        :key="g.cwd"
        class="group/folder group-section flex flex-col gap-0.5"
      >
        <!-- 组标题：cwd 末段（长路径只显末段防溢出，与 SessionItem.dirName 同一信息原子）。
             sticky 贴顶用 bg-bg 不透明（侧边栏底色透明融合 bg，header 同色遮住滚过的 item 文字）。
             group/folder 命名 group：folder header 的 hover 只触发 folder delete button 显示，
             不影响子级 SessionItem 的 group-hover（两者独立 scope）。 -->
        <div class="group/folder sticky top-0 z-[1] flex items-center gap-1.5 bg-bg px-2 pb-0.5 pt-2">
          <Folder class="size-[11px] shrink-0 text-neutral-dim" />
          <span class="truncate text-[10px] font-medium text-neutral-dim">
            {{ dirNameOf(g.cwd) }}
          </span>
          <span class="font-mono text-[10px] text-neutral-dim opacity-60">{{ g.sessions.length }}</span>
          <!-- folder 维度批量删除按钮（两段式确认，与 SessionItem.delete 一致） -->
          <div
            class="ml-auto"
            :class="folderConfirmingCwd === g.cwd ? 'flex' : 'flex opacity-0 group-hover/folder:opacity-100'"
            @mouseleave="onFolderMouseLeave(g.cwd)"
          >
            <Button
              variant="ghost"
              size="icon"
              data-testid="folder-delete-btn"
              :class="folderConfirmingCwd === g.cwd
                ? 'size-[22px] rounded-sm border border-danger bg-danger text-neutral-fg'
                : 'size-[22px] rounded-sm border border-border-strong bg-surface text-neutral-mid hover:bg-surface-hover hover:text-danger'"
              :title="folderConfirmingCwd === g.cwd
                ? t('sidebar.sessionList.deleteFolderConfirm')
                : t('sidebar.sessionItem.delete')"
              @click.stop="onFolderRemoveClick(g.cwd)"
            >
              <Check v-if="folderConfirmingCwd === g.cwd" class="size-[13px]" />
              <Trash2 v-else class="size-[13px]" />
            </Button>
          </div>
        </div>
        <!-- 每条 session 渲染 SessionItem；当前激活 session 下方紧跟其分支小列表
             （spec §2 层③ 方案3：仅当前 session 展开自己的分支，不破坏其他 session 扁平结构）。
             用 template v-for 聚合 SessionItem + 条件 ForkGroup，保持 s 在作用域内。 -->
        <template v-for="s in g.sessions" :key="s.id">
          <SessionItem
            :session="s"
            :active="s.id === activeId"
            :status="statusOf(s.id)"
            :parent-label="parentLabelOf(s)"
            @select="emit('select', $event)"
            @rename="emit('rename', $event)"
            @delete="emit('delete', $event)"
          />
          <!-- 当前 session 的分支：从组内 sessions filter parentSession 指向当前 session
               （sessionFile 路径或 sessionId，FR-20 fallback）。无分支时不渲染空容器。 -->
          <ForkGroup
            v-if="s.id === activeId && branchesOf(s).length > 0"
            :branches="branchesOf(s)"
            :parent-id="s.id"
            @select="emit('select', $event)"
            @stop="emit('stopBranch', $event)"
          />
        </template>
      </div>
    </div>
    <div
      v-if="totalCount === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center"
    >
      <p class="text-[11px] text-neutral-dim opacity-55">{{ t('sidebar.sessionList.empty') }}</p>
      <Button
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 rounded-md px-2 text-[11px] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg"
        @click="emit('newSession')"
      >
        <Plus class="size-[14px]" />
        {{ t('sidebar.sessionList.newSession') }}
      </Button>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import type { SessionGroup, SessionSummary } from '@xyz-agent/shared'
import type { DerivedStatus } from '@/types'
import { computed, provide, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, Folder, Trash2, Check } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { dirNameOf } from '@xyz-agent/ui'
import { useProjectStore } from '@/stores/project'
import SessionItem from './SessionItem.vue'
import ForkGroup from './ForkGroup.vue'

const { t } = useI18n()
const projectStore = useProjectStore()

const props = defineProps<{
  /** 按 cwd 分组的会话（D7，对齐后端 SessionGroup[]） */
  groups: SessionGroup[]
  activeId: string | null
  /** 派生状态点（D6），由容器注入 useSessionDerivations.derivedStatus */
  statusOf: (id: string) => DerivedStatus
}>()

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  delete: [sessionId: string]
  newSession: []
  /** 停止后台分支 session（FR-19，ForkGroup 两段式确认后调 abort） */
  stopBranch: [sessionId: string]
  /** 删除指定 cwd 下所有 session（folder 维度批量删除，两段式确认后由 Sidebar 调 deleteFolder） */
  deleteFolder: [cwd: string]
}>()

/**
 * 按 activeProject 过滤后的分组（D14 关联键 = cwd）：
 * - 默认 project（name 空）→ 全部（未归类聚合，兼容现有体验）
 * - 命名 project → 只保留 cwd ∈ activeWorkspaceCwds 的组
 * 过滤后无匹配组 → totalCount=0 走空态（「暂无会话」+ 新建按钮）。
 */
const visibleGroups = computed<SessionGroup[]>(() => {
  if (projectStore.isDefaultProject) return props.groups
  const cwds = new Set(projectStore.activeWorkspaceCwds)
  if (cwds.size === 0) return []
  return props.groups.filter((g) => cwds.has(g.cwd))
})

/** 全部 session 总数（空态判定，跨组汇总） */
const totalCount = computed(() =>
  visibleGroups.value.reduce((sum, g) => sum + g.sessions.length, 0),
)

/**
 * 取当前 session 的直接子分支列表（FR-17，spec §2 层③）。
 * 从组内 sessions filter parentSession 指向当前 session：
 * - 优先匹配 parentSession === sessionFile（活跃 session 落盘路径，§8.1 规范）
 * - fallback 匹配 parentSession === id（源 session 未落盘时用 sessionId 作血缘键，FR-20）
 *
 * 竞态修复（RV5）：同时匹配两种 key，而非 `sessionFile || id` 单一键。
 * FR-20 fallback 在 fork 时可能写 srcSessionId（源未落盘），渲染时源已落盘 sessionFile 变为文件路径，
 * 若只取 sessionFile 会漏掉按 id 注册的分支；若只取 id 会漏掉已落盘的源。两种 key 取并集保证稳定命中。
 * 仅在当前 session 所在组内 filter（分支与父同 cwd，不需跨组扫描）。
 */
function branchesOf(s: SessionSummary): SessionSummary[] {
  return props.groups
    .filter((g) => g.cwd === s.cwd)
    .flatMap((g) => g.sessions)
    .filter(
      (b) =>
        b.parentSession != null &&
        (b.parentSession === s.sessionFile || b.parentSession === s.id),
    )
}

/**
 * 反查分支 session 的父 session label（P3 修复血缘显示）。
 *
 * SessionItem 模板用 `session.parentLabel || session.parentSession` 展示血缘，但此前 SessionList
 * 从未传 parentLabel → 实际显示 parentSession（文件路径或 UUID，不可读）。本 helper 按
 * session.parentSession 反查父 session，取其 label 注入 parentLabel。
 *
 * 匹配规则与 branchesOf 一致（FR-20 双键兜底）：parentSession 可能是父的 sessionFile（活跃 session
 * 落盘路径）或父的 id（源未落盘时用 sessionId 作血缘键），两种 key 取并集保证命中。
 * 仅在当前 session 所在组内查找（分支与父同 cwd，不需跨组扫描）；无父（parentSession 空）或
 * 父不在当前分组返回空串，SessionItem 回退到 parentSession 原值。
 */
function parentLabelOf(s: SessionSummary): string {
  if (!s.parentSession) return ''
  const parent = props.groups
    .filter((g) => g.cwd === s.cwd)
    .flatMap((g) => g.sessions)
    .find((p) => p.sessionFile === s.parentSession || p.id === s.parentSession)
  return parent?.label ?? ''
}

/** 单一 Esc 监听器——避免每个 SessionItem 各自注册 window keydown listener（N 项 N 个监听器）。
 *  SessionItem inject 后 watch escCount 变化清自身确认态。 */
const escCount = ref(0)
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') escCount.value++
})
provide('sessionItemEsc', escCount)

/**
 * folder 维度删除的两段式确认态（与 SessionItem.confirming 同范式）。
 * 存当前确认的 cwd（同时只允许一个 folder 处于确认态）；二次点击同 cwd 才 emit deleteFolder。
 * Esc / mouseleave / 点击外部（onClickOutside）复位——folder 按钮直接用本组件持有的 escCount
 * 同源 ref，不需 inject（SessionList 是 provide 源头）。
 */
const folderConfirmingCwd = ref<string | null>(null)
function onFolderRemoveClick(cwd: string): void {
  if (folderConfirmingCwd.value !== cwd) {
    folderConfirmingCwd.value = cwd
    return
  }
  folderConfirmingCwd.value = null
  emit('deleteFolder', cwd)
}
/** 鼠标离开 folder 按钮区域时复位确认态（与 Esc 同源，防止误确认） */
function onFolderMouseLeave(cwd: string): void {
  if (folderConfirmingCwd.value === cwd) folderConfirmingCwd.value = null
}
watch(escCount, () => {
  if (folderConfirmingCwd.value) folderConfirmingCwd.value = null
})

/**
 * S4：点击 folder 确认按钮外部时复位确认态（与 SessionItem.onClickOutside 同范式）。
 * folder 标题行处于 v-for 循环（多个 folder），不便逐项挂 onClickOutside ref，故用
 * 单一 window pointerdown 监听（pointerdown 先于 click，比 click 更早收口确认态）。
 *
 * 同级 folder 按钮冲突规避：点击另一 folder 的删除按钮时，该按钮的 @click.stop 会切
 * folderConfirmingCwd 到新 cwd。若此处无条件复位 '' 会覆盖新值。故只在「点击目标不在任何
 * folder 删除按钮内」时复位——新 cwd 的切换由 onFolderRemoveClick 自行处理，互不干扰。
 * 用 [data-testid="folder-delete-btn"] 锚定 folder 删除按钮（S5 前置 testid），与 SessionItem
 * 的 session 删除按钮 testid 区分。
 */
useEventListener(window, 'pointerdown', (e: PointerEvent) => {
  if (!folderConfirmingCwd.value) return
  const target = e.target as Element | null
  if (target?.closest('[data-testid="folder-delete-btn"]')) return
  folderConfirmingCwd.value = null
})

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
</script>
