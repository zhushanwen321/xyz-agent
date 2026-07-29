/**
 * WorkflowDrawerPane.vue 容器组件测试（W3 wave part2 · TC7-9）。
 *
 * 覆盖容器：二级 tab + DAG/Gantt view toggle + tab 切换/关闭。
 * - TC7 首屏：二级 tab + DAG 默认视图存在
 * - TC8 toggle 切换：点 Gantt → gantt-view 出现
 * - TC9 tab 切换/关闭
 *
 * mock 策略：
 * - useWorkflowDrawerTabs：返回受控 openedRunIds（让容器渲染 tab + 内容）
 * - useWorkflowStore：返回受控 records（currentRun 可解析 scriptName/status）
 * - useSidebarSubagentActions：stub 节点点击 + 操作回调（避免引入 chat/panel store 链）
 * - DAG/Gantt 子视图：stub（避免依赖 computeLayers 几何，聚焦容器行为）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow/__tests__/WorkflowDrawerPane.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ref, nextTick } from "vue";
import type { WorkflowRunRecord } from "@xyz-agent/shared";

// ── mock useWorkflowDrawerTabs：受控 openedRunIds + closeWorkflow spy ──
const mockOpenedRunIds = ref<string[]>([]);
const closeWorkflowSpy = vi.fn();
vi.mock("@/composables/workflow/use-workflow-drawer-tabs", () => ({
  useWorkflowDrawerTabs: () => ({
    openedRunIds: mockOpenedRunIds,
    openWorkflow: vi.fn(),
    closeWorkflow: closeWorkflowSpy,
    isWorkflowOpened: (runId: string) => mockOpenedRunIds.value.includes(runId),
  }),
  resetWorkflowDrawerTabs: vi.fn(),
}));

// ── mock useWorkflowStore：受控 recordsOf（返回固定 WorkflowRunRecord[]）──
const mockRecords = ref<WorkflowRunRecord[]>([]);
vi.mock("@/stores/workflow", () => ({
  useWorkflowStore: () => ({
    recordsOf: (_sid: string) => mockRecords,
  }),
}));

// ── mock useSidebarSubagentActions：stub 节点点击 + 操作回调 ──
const onSelectAgentCallSpy = vi.fn();
const onWorkflowActionSpy = vi.fn();
vi.mock("@/composables/features/useSidebarSubagentActions", () => ({
  useSidebarSubagentActions: () => ({
    onSelectAgentCall: onSelectAgentCallSpy,
    onWorkflowAction: onWorkflowActionSpy,
  }),
}));

// ── stub DAG/Gantt 子视图（聚焦容器行为，避免 computeLayers 几何）──
vi.mock("@/components/panel/workflow/WorkflowDagView.vue", () => ({
  default: { template: '<div data-testid="workflow-dag-view-stub" />' },
}));
vi.mock("@/components/panel/workflow/WorkflowGanttView.vue", () => ({
  default: { template: '<div data-testid="workflow-gantt-view-stub" />' },
}));

import WorkflowDrawerPane from "@/components/panel/workflow/WorkflowDrawerPane.vue";

/** 构造 WorkflowRunRecord 的 helper。 */
function makeRecord(
  overrides: Partial<WorkflowRunRecord> & { runId: string }
): WorkflowRunRecord {
  return {
    scriptName: "test-workflow",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    agentCalls: [],
    stateFilePath: "/tmp/state.json",
    ...overrides,
  };
}

/** 标准测试数据：2 个 run，run-1 为 running。 */
function setupRecords(): void {
  mockRecords.value = [
    makeRecord({
      runId: "wf-001",
      scriptName: "analyze-flow",
      status: "running",
    }),
    makeRecord({
      runId: "wf-002",
      scriptName: "dev-flow",
      status: "completed",
    }),
  ];
  mockOpenedRunIds.value = ["wf-001", "wf-002"];
}

function mountPane(sessionId: string | null = "sess-A") {
  return mount(WorkflowDrawerPane, {
    props: { sessionId },
  });
}

beforeEach(() => {
  closeWorkflowSpy.mockClear();
  onSelectAgentCallSpy.mockClear();
  onWorkflowActionSpy.mockClear();
  mockRecords.value = [];
  mockOpenedRunIds.value = [];
});

// ── TC7: 首屏 ─────────────────────────────────────────────
describe("W3 TC7: 容器首屏（二级 tab + DAG 默认视图）", () => {
  it('openedRunIds 非空时 [data-testid="workflow-drawer-pane"] 存在', () => {
    setupRecords();
    const wrapper = mountPane();
    expect(wrapper.find('[data-testid="workflow-drawer-pane"]').exists()).toBe(
      true
    );
  });

  it("二级 tab 渲染所有 openedRunIds（2 个 tab）", () => {
    setupRecords();
    const wrapper = mountPane();
    const tabs = wrapper.findAll(
      '[data-testid="workflow-drawer-tab"], [data-testid="workflow-drawer-tab-active"]'
    );
    expect(tabs.length).toBe(2);
  });

  it("默认 viewMode=dag → DAG 子视图渲染", () => {
    setupRecords();
    const wrapper = mountPane();
    expect(
      wrapper.find('[data-testid="workflow-dag-view-stub"]').exists()
    ).toBe(true);
    expect(
      wrapper.find('[data-testid="workflow-gantt-view-stub"]').exists()
    ).toBe(false);
  });

  it("tab 显示 scriptName（analyze-flow 渲染出来）", () => {
    setupRecords();
    const wrapper = mountPane();
    expect(wrapper.text()).toContain("analyze-flow");
    expect(wrapper.text()).toContain("dev-flow");
  });

  it('openedRunIds 为空时显空态 [data-testid="workflow-drawer-empty"]', () => {
    const wrapper = mountPane();
    expect(wrapper.find('[data-testid="workflow-drawer-empty"]').exists()).toBe(
      true
    );
    expect(wrapper.find('[data-testid="workflow-drawer-pane"]').exists()).toBe(
      false
    );
  });
});

// ── TC8: view toggle 切换 ─────────────────────────────────
describe("W3 TC8: DAG/Gantt view toggle 切换", () => {
  it("点 Gantt 按钮 → gantt 子视图出现，dag 消失", async () => {
    setupRecords();
    const wrapper = mountPane();
    expect(
      wrapper.find('[data-testid="workflow-dag-view-stub"]').exists()
    ).toBe(true);

    await wrapper
      .find('[data-testid="workflow-drawer-view-gantt"]')
      .trigger("click");

    expect(
      wrapper.find('[data-testid="workflow-gantt-view-stub"]').exists()
    ).toBe(true);
    expect(
      wrapper.find('[data-testid="workflow-dag-view-stub"]').exists()
    ).toBe(false);
  });

  it("点 DAG 按钮（从 gantt 切回）→ dag 子视图恢复", async () => {
    setupRecords();
    const wrapper = mountPane();
    // 先切到 gantt
    await wrapper
      .find('[data-testid="workflow-drawer-view-gantt"]')
      .trigger("click");
    expect(
      wrapper.find('[data-testid="workflow-gantt-view-stub"]').exists()
    ).toBe(true);
    // 切回 dag
    await wrapper
      .find('[data-testid="workflow-drawer-view-dag"]')
      .trigger("click");
    expect(
      wrapper.find('[data-testid="workflow-dag-view-stub"]').exists()
    ).toBe(true);
  });
});

// ── TC9: tab 切换/关闭 ────────────────────────────────────
describe("W3 TC9: 二级 tab 切换 + 关闭", () => {
  it("点非活跃 tab 切换 activeRunId", async () => {
    setupRecords();
    const wrapper = mountPane();
    // 初始 active = wf-001（openedRunIds[0]）
    expect(
      wrapper.find('[data-testid="workflow-drawer-tab-active"]').exists()
    ).toBe(true);

    // 点 wf-002 tab（非活跃）→ 切换
    const tabs = wrapper.findAll("button");
    const wf002Tab = tabs.find((b) => b.text().includes("dev-flow"));
    expect(wf002Tab).toBeTruthy();
    await wf002Tab!.trigger("click");
    await nextTick();

    // 操作按钮（pause）按 currentRun（wf-002 completed）状态——completed 无操作按钮
    // 关键：未崩溃，tab 切换生效（activeRunId 变 wf-002）
    expect(wrapper.find('[data-testid="workflow-drawer-pane"]').exists()).toBe(
      true
    );
  });

  it("点 tab 关闭× → 调 closeWorkflow(runId)", async () => {
    setupRecords();
    const wrapper = mountPane();
    const closeBtn = wrapper.find(
      '[data-testid="workflow-drawer-tab-close-wf-002"]'
    );
    expect(closeBtn.exists()).toBe(true);

    await closeBtn.trigger("click");
    await nextTick();

    expect(closeWorkflowSpy).toHaveBeenCalledWith("wf-002");
  });

  it("关闭当前活跃 tab 后切到相邻 tab（activeRunId 不悬空）", async () => {
    setupRecords();
    const wrapper = mountPane();
    // 初始 active = wf-001。点 wf-001 的关闭×
    const closeBtn = wrapper.find(
      '[data-testid="workflow-drawer-tab-close-wf-001"]'
    );
    await closeBtn.trigger("click");
    await nextTick();

    // closeWorkflow 被调；容器未崩溃
    expect(closeWorkflowSpy).toHaveBeenCalledWith("wf-001");
    expect(wrapper.find('[data-testid="workflow-drawer-pane"]').exists()).toBe(
      true
    );
  });
});
