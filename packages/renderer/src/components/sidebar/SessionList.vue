<template>
  <!--
    展示组件 · 会话列表（子视图 A，draft-five-states 卡 A/D）。
    按 cwd 分组渲染（D7：对齐后端 SessionGroup[]）—— 每组一个标题（cwd 末段）+ 组内 SessionItem 列表。
    ScrollArea 包裹；空态（D，session 数=0）显示极淡「暂无会话」占位。
    v-model 语义用 activeId（单向：子→父 select）。
  -->
  <ScrollArea class="session-list h-full">
    <div class="flex flex-col px-1">
      <div
        v-for="g in groups"
        :key="g.cwd"
        class="group-section flex flex-col gap-0.5"
      >
        <!-- 组标题：cwd 末段（长路径只显末段防溢出，与 SessionItem.dirName 同一信息原子）。
             sticky 贴顶用 bg-bg 不透明（侧边栏底色透明融合 bg，header 同色遮住滚过的 item 文字） -->
        <div class="sticky top-0 z-[1] flex items-center gap-1.5 bg-bg px-2 pb-0.5 pt-2">
          <Folder class="size-[11px] shrink-0 text-subtle" />
          <span class="truncate text-[10px] font-medium uppercase tracking-wide text-subtle">
            {{ dirNameOf(g.cwd) }}
          </span>
          <span class="font-mono text-[10px] text-subtle opacity-60">{{ g.sessions.length }}</span>
        </div>
        <!-- 每条 session 渲染 SessionItem；当前激活 session 下方紧跟其分支小列表
             （spec §2 层③ 方案3：仅当前 session 展开自己的分支，不破坏其他 session 扁平结构）。
             用 template v-for 聚合 SessionItem + 条件 ForkGroup，保持 s 在作用域内。 -->
        <template v-for="s in g.sessions" :key="s.id">
          <SessionItem
            :session="s"
            :active="s.id === activeId"
            :status="statusOf(s.id)"
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
      <p class="text-[11px] text-subtle opacity-55">{{ t('sidebar.sessionList.empty') }}</p>
      <Button
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 rounded-md px-2 text-[11px] text-muted hover:bg-surface-hover hover:text-fg"
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
import { computed, provide, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { Plus, Folder } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { dirNameOf } from '@/composables/logic/path'
import SessionItem from './SessionItem.vue'
import ForkGroup from './ForkGroup.vue'

const { t } = useI18n()

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
}>()

/** 全部 session 总数（空态判定，跨组汇总） */
const totalCount = computed(() =>
  props.groups.reduce((sum, g) => sum + g.sessions.length, 0),
)

/**
 * 取当前 session 的直接子分支列表（FR-17，spec §2 层③）。
 * 从组内 sessions filter parentSession 指向当前 session：
 * - 优先匹配 parentSession === sessionFile（活跃 session 落盘路径，§8.1 规范）
 * - fallback 匹配 parentSession === id（源 session 未落盘时用 sessionId 作血缘键，FR-20）
 * 仅在当前 session 所在组内 filter（分支与父同 cwd，不需跨组扫描）。
 */
function branchesOf(s: SessionSummary): SessionSummary[] {
  const parentKey = s.sessionFile || s.id
  return props.groups
    .filter((g) => g.cwd === s.cwd)
    .flatMap((g) => g.sessions)
    .filter((b) => b.parentSession != null && b.parentSession === parentKey)
}

/** 单一 Esc 监听器——避免每个 SessionItem 各自注册 window keydown listener（N 项 N 个监听器）。
 *  SessionItem inject 后 watch escCount 变化清自身确认态。 */
const escCount = ref(0)
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') escCount.value++
})
provide('sessionItemEsc', escCount)

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
</script>
