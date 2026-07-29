<template>
  <!--
    容器组件 · workflow 可视化抽屉（W3 wave part2）。
    承载二级 tab（多个 run 并存切换）+ DAG/Gantt view toggle + 操作按钮（pause/resume/abort）。
    节点点击 + 操作复用 useSidebarSubagentActions（与 sidebar 同口径）。
    DAG/Gantt 子视图契约一致：props { layers, pendingNodes } + emit select-agent-call。
  -->
  <div
    v-if="openedRunIds.length"
    class="flex h-full min-h-0 flex-col"
    data-testid="workflow-drawer-pane"
  >
    <!-- header 行：二级 tab 区 + view toggle + 操作按钮 -->
    <div class="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <!-- 二级 tab 区：每个打开的 run 一个 tab（scriptName + 状态点 + 关闭×） -->
      <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <Button
          v-for="runId in openedRunIds"
          :key="runId"
          variant="ghost"
          class="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px]"
          :class="
            activeRunId === runId
              ? 'bg-accent-soft text-accent'
              : 'text-neutral-mid'
          "
          :data-testid="
            activeRunId === runId
              ? 'workflow-drawer-tab-active'
              : 'workflow-drawer-tab'
          "
          @click="activeRunId = runId"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="runDotClass(runId)"
          />
          <span class="max-w-[120px] truncate">{{ runScriptName(runId) }}</span>
          <span
            class="flex size-3.5 shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover"
            :title="t('panel.sideDrawer.workflowDrawer.tabClose')"
            :data-testid="`workflow-drawer-tab-close-${runId}`"
            @click.stop="onCloseTab(runId)"
          >
            <X class="size-2.5" />
          </span>
        </Button>
      </div>

      <!-- view toggle：DAG/Gantt 双 ghost Button（复用 DetailPane 范式） -->
      <div
        v-if="currentRun"
        class="flex shrink-0 gap-0.5"
        data-testid="workflow-drawer-view-toggle"
      >
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[10px]"
          :class="
            viewMode === 'dag'
              ? 'bg-accent-soft text-accent'
              : 'text-neutral-mid'
          "
          :title="t('panel.sideDrawer.workflowDrawer.viewDag')"
          data-testid="workflow-drawer-view-dag"
          @click="viewMode = 'dag'"
          >{{ t("panel.sideDrawer.workflowDrawer.viewDag") }}</Button
        >
        <Button
          variant="ghost"
          class="h-6 rounded-sm px-1.5 text-[10px]"
          :class="
            viewMode === 'gantt'
              ? 'bg-accent-soft text-accent'
              : 'text-neutral-mid'
          "
          :title="t('panel.sideDrawer.workflowDrawer.viewGantt')"
          data-testid="workflow-drawer-view-gantt"
          @click="viewMode = 'gantt'"
          >{{ t("panel.sideDrawer.workflowDrawer.viewGantt") }}</Button
        >
      </div>

      <!-- 操作按钮：running→pause+abort，paused→resume+abort。abort 两段式确认。 -->
      <div
        v-if="
          currentRun &&
          (currentRun.status === 'running' || currentRun.status === 'paused')
        "
        class="flex shrink-0 items-center gap-0.5"
      >
        <Button
          variant="ghost"
          size="icon"
          class="size-5 text-neutral-dim hover:text-neutral-fg"
          :title="
            currentRun.status === 'running'
              ? t('panel.sideDrawer.workflowDrawer.pause')
              : t('panel.sideDrawer.workflowDrawer.resume')
          "
          data-testid="workflow-drawer-toggle-run"
          @click="onToggleRun"
        >
          <Pause v-if="currentRun.status === 'running'" class="size-3" />
          <Play v-else class="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          :data-testid="
            aborting ? 'workflow-drawer-abort-confirm' : 'workflow-drawer-abort'
          "
          :class="
            aborting
              ? 'size-5 border border-danger bg-danger text-neutral-fg'
              : 'size-5 text-neutral-dim hover:text-danger'
          "
          :title="
            aborting
              ? t('panel.sideDrawer.workflowDrawer.terminateConfirm')
              : t('panel.sideDrawer.workflowDrawer.terminate')
          "
          @click="onAbortClick"
        >
          <Check v-if="aborting" class="size-3" />
          <Square v-else class="size-3" />
        </Button>
      </div>
    </div>

    <!-- 内容区：按 viewMode 分发 DAG / Gantt 子视图 -->
    <ScrollArea v-if="currentRun" class="min-h-0 flex-1">
      <WorkflowDagView
        v-if="viewMode === 'dag'"
        :layers="layersData.layers"
        :pending-nodes="layersData.pendingNodes"
        @select-agent-call="handleSelectAgentCall"
      />
      <WorkflowGanttView
        v-else
        :layers="layersData.layers"
        :pending-nodes="layersData.pendingNodes"
        @select-agent-call="handleSelectAgentCall"
      />
    </ScrollArea>
  </div>

  <!-- 空态：无打开的 run -->
  <div
    v-else
    class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
    data-testid="workflow-drawer-empty"
  >
    <Workflow class="size-6 text-neutral-dim opacity-40" />
    <p class="text-[12px] text-neutral-dim opacity-70">
      {{ t("panel.sideDrawer.workflowDrawer.noOpenedRuns") }}
    </p>
    <p class="text-[11px] text-neutral-dim opacity-50">
      {{ t("panel.sideDrawer.workflowDrawer.noOpenedRunsHint") }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * WorkflowDrawerPane —— workflow 可视化抽屉容器（W3 wave part2）。
 *
 * 职责：
 * - 二级 tab：管理多个打开的 run（useWorkflowDrawerTabs），点 tab 切 activeRunId，× 关闭。
 * - view toggle：DAG（WorkflowDagView）/ Gantt（WorkflowGanttView）切换，双 ghost Button。
 * - 操作按钮：按 currentRun.status 显 pause/resume + abort（两段式确认，复用 WorkflowDetail 范式）。
 * - 节点点击 + 操作：复用 useSidebarSubagentActions（与 sidebar 同口径，跨 store 编排在 actions 层）。
 *
 * 子视图契约一致（DAG/Gantt 可互换）：props { layers, pendingNodes } + emit select-agent-call。
 * layers 由 computeLayers(currentRun.agentCalls) 计算（纯函数，非响应式，computed 内重算）。
 */
import { computed, ref, toRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Pause, Play, Square, Check, Workflow } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import WorkflowDagView from "./WorkflowDagView.vue";
import WorkflowGanttView from "./WorkflowGanttView.vue";
import { useWorkflowStore } from "@/stores/workflow";
import { useWorkflowDrawerTabs } from "@/composables/workflow/use-workflow-drawer-tabs";
import { computeLayers } from "@/composables/workflow/compute-layers";
import { useSidebarSubagentActions } from "@/composables/features/useSidebarSubagentActions";
import { callDotClass } from "@/composables/workflow/format";

const props = defineProps<{ sessionId: string | null }>();

const { t } = useI18n();

// 1. 二级 tab 状态（openedRunIds 按打开时间 DESC 排序）
// [W3] useWorkflowDrawerTabs 为模块级单例（分区键来自 panelStore.focusedSessionId），
// 与 useSidebarSubagentActions 共享同一分区 Map（sidebar openWorkflow → drawer 更新）。
const { openedRunIds, closeWorkflow } = useWorkflowDrawerTabs();

// 2. workflow 数据（records 按 sessionId 分区）
const workflowStore = useWorkflowStore();
const records = computed(() =>
  props.sessionId ? workflowStore.recordsOf(props.sessionId).value : []
);

// 3. 当前活跃 run（默认 openedRunIds[0]，openedRunIds 变化时同步）
const activeRunId = ref<string | null>(null);
watch(
  openedRunIds,
  (ids) => {
    if (ids.length && !ids.includes(activeRunId.value ?? "")) {
      activeRunId.value = ids[0];
    }
  },
  { immediate: true }
);

const currentRun = computed(
  () => records.value.find((r) => r.runId === activeRunId.value) ?? null
);

// 4. view toggle（默认 DAG）
const viewMode = ref<"dag" | "gantt">("dag");

// 5. layers 计算（传给 DAG/Gantt 子视图，computeLayers 是纯函数）
const layersData = computed(() =>
  currentRun.value
    ? computeLayers(currentRun.value.agentCalls)
    : { layers: [], pendingNodes: [] }
);

// 6. 节点点击 + 操作（复用 useSidebarSubagentActions，与 sidebar 同口径）
const { onSelectAgentCall, onWorkflowAction } = useSidebarSubagentActions(
  toRef(props, "sessionId")
);

/** select-agent-call 事件载荷契约：单个 payload 对象（规则 #1）。 */
interface SelectAgentCallPayload {
  agentCallSessionId: string
}

/**
 * select-agent-call 事件适配器：从 payload 对象解构 agentCallSessionId，
 * 再交给 onSelectAgentCall（其签名接受 string | undefined）。
 */
function handleSelectAgentCall(payload: SelectAgentCallPayload): void {
  const { agentCallSessionId } = payload;
  void onSelectAgentCall(agentCallSessionId);
}

/** run 缺失时 scriptName 回退取 runId 前缀长度 */
const RUNID_FALLBACK_SLICE = 8;

// ── 二级 tab 关闭：关闭后切到相邻 tab（避免 activeRunId 悬空）──
function onCloseTab(runId: string): void {
  const idx = openedRunIds.value.indexOf(runId);
  // 删除前先算好目标：优先下一个兄弟（保持「切到下一个」的现有行为），否则上一个，全空则 null。
  // 不依赖删除后数组的位置索引（openedRunIds 顺序/排序若变化也不受影响）。
  const siblingIds = openedRunIds.value;
  const targetRunId =
    siblingIds[idx + 1] ?? siblingIds[idx - 1] ?? null;
  closeWorkflow(runId);
  // 仅当被关的是当前活跃 tab 时才切换，避免覆盖用户已手动切换的 activeRunId
  if (activeRunId.value === runId) {
    activeRunId.value = targetRunId;
  }
}

/** tab 状态点配色（按 run status，复用 callDotClass 的 running/completed 语义；paused 用 warn） */
function runDotClass(runId: string): string {
  const run = records.value.find((r) => r.runId === runId);
  if (!run) return "bg-neutral-dim";
  if (run.status === "paused") return "bg-warn";
  return callDotClass(run.status === "running" ? "running" : "completed");
}

/** tab 显示的 scriptName（run 缺失时回退 runId 前缀） */
function runScriptName(runId: string): string {
  const run = records.value.find((r) => r.runId === runId);
  return run?.scriptName ?? runId.slice(0, RUNID_FALLBACK_SLICE);
}

// ── 操作按钮 ──
/** pause/resume 切换（按 currentRun.status） */
function onToggleRun(): void {
  if (!currentRun.value) return;
  const status = currentRun.value.status;
  // 防御：仅 running/paused 可切换。状态过期（如 done）时 no-op，避免误发 resume 导致 API 报错。
  if (status !== "running" && status !== "paused") return;
  const action = status === "running" ? "pause" : "resume";
  void onWorkflowAction({ action, runId: currentRun.value.runId });
}

/** abort 两段式确认（复用 WorkflowDetail.vue 的 onAbortClick 模式） */
const aborting = ref(false);

function onAbortClick(): void {
  if (aborting.value) {
    if (currentRun.value) {
      void onWorkflowAction({ action: "abort", runId: currentRun.value.runId });
    }
    aborting.value = false;
  } else {
    aborting.value = true;
  }
}
</script>
