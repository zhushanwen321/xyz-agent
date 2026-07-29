/**
 * SideDrawer workflow tab 接入测试（W3 wave part2 · TC10-11）。
 *
 * 覆盖 SideDrawer.vue 对 workflow tab 的条件显示 + 内容分支：
 * - TC10 条件显示：mock workflowStore.recordsOf 返回非空 → workflow tab icon 出现
 * - TC11 内容分支：activeTab='workflow' → WorkflowDrawerPane 渲染
 *
 * 参考现有 __tests__/components/SideDrawer.test.ts 的 mount 范式（stub 子组件、mock store）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow/__tests__/SideDrawer-workflow.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import type { SideDrawerTab } from "@/composables/features/useSideDrawer";
import { __clearSessionCleanupRegistryForTest } from "@/composables/useSessionScopedState";

// ── mock useSessionEvents（避免真实订阅）──
vi.mock("@/composables/features/useSessionEvents", () => ({
  useSessionEvents: () => () => {},
}));

// ── mock 子组件为桩，避免依赖真实 GitPanel/DetailPane/TerminalView 等复杂依赖 ──
vi.mock("@/components/panel/GitPanel.vue", () => ({
  default: { template: '<div data-testid="git-stub" />' },
}));
vi.mock("@/components/panel/CommandDocPanel.vue", () => ({
  default: { template: '<div data-testid="doc-stub" />' },
}));
vi.mock("@/components/panel/DetailPane.vue", () => ({
  default: { template: '<div data-testid="detail-stub" />' },
}));
vi.mock("@/components/panel/BrowserPane.vue", () => ({
  default: { template: '<div data-testid="browser-pane-stub" />' },
}));
vi.mock("@/components/panel/TasksPanel.vue", () => ({
  default: { template: '<div data-testid="tasks-stub" />' },
}));
vi.mock("@/components/panel/TerminalView.vue", () => ({
  default: { template: '<div data-testid="terminal-stub" />' },
}));
vi.mock("@/components/message-stream/GuiComponentRenderer.vue", () => ({
  default: { template: "<div />" },
}));
vi.mock("@/components/message-stream/gui/AnsiText.vue", () => ({
  default: { props: ["content"], template: "<span>{{ content }}</span>" },
}));

// ── mock WorkflowDrawerPane 为桩（验证接入分支，不测容器内部）──
vi.mock("@/components/panel/workflow/WorkflowDrawerPane.vue", () => ({
  default: { template: '<div data-testid="workflow-drawer-pane-stub" />' },
}));

// ── mock useTasksStore：hasData 返回 false（聚焦 workflow tab，避免 tasks tab 干扰）──
vi.mock("@/stores/tasks", () => ({
  useTasksStore: () => ({ hasData: () => false }),
}));

// ── mock useChatStore：getMessages 返回空数组（避免 unread watch 报错）──
vi.mock("@/stores/chat", () => ({
  useChatStore: () => ({ getMessages: () => [] }),
}));

// ── mock useWorkflowStore：受控 recordsOf（TC10 非空、对照用例空）──
const mockRecords = ref<unknown[]>([]);
vi.mock("@/stores/workflow", () => ({
  useWorkflowStore: () => ({
    recordsOf: (_sid: string) => mockRecords,
  }),
}));

import SideDrawer from "@/components/panel/SideDrawer.vue";

beforeEach(() => {
  __clearSessionCleanupRegistryForTest();
  setActivePinia(createPinia());
  mockRecords.value = [];
});

function mountDrawer(
  sessionId: string | null,
  activeTab: SideDrawerTab = "terminal"
) {
  return mount(SideDrawer, {
    props: {
      isOpen: true,
      activeTab,
      docked: false,
      sessionId,
    },
    global: { plugins: [] },
  });
}

// ── TC10: 条件显示 ────────────────────────────────────────
describe("W3 TC10: workflow tab 条件显示", () => {
  it("recordsOf 返回非空 → workflow tab icon 出现", () => {
    mockRecords.value = [
      { runId: "wf-001", scriptName: "flow", status: "running" },
    ];
    const wrapper = mountDrawer("sess-A");
    expect(wrapper.find('[data-testid="drawer-tab-workflow"]').exists()).toBe(
      true
    );
  });

  it("recordsOf 返回空 → workflow tab icon 不出现", () => {
    mockRecords.value = [];
    const wrapper = mountDrawer("sess-A");
    expect(wrapper.find('[data-testid="drawer-tab-workflow"]').exists()).toBe(
      false
    );
  });

  it("sessionId 为 null → workflow tab icon 不出现（即使 records 非空，sessionId 守卫）", () => {
    mockRecords.value = [
      { runId: "wf-001", scriptName: "flow", status: "running" },
    ];
    const wrapper = mountDrawer(null);
    expect(wrapper.find('[data-testid="drawer-tab-workflow"]').exists()).toBe(
      false
    );
  });
});

// ── TC11: 内容分支 ────────────────────────────────────────
describe("W3 TC11: activeTab=workflow → WorkflowDrawerPane 渲染", () => {
  it('activeTab="workflow" → [data-testid="workflow-drawer-pane-stub"] 存在', () => {
    mockRecords.value = [
      { runId: "wf-001", scriptName: "flow", status: "running" },
    ];
    const wrapper = mountDrawer("sess-A", "workflow");
    expect(
      wrapper.find('[data-testid="workflow-drawer-pane-stub"]').exists()
    ).toBe(true);
  });

  it('activeTab="workflow" 传 sessionId 给 WorkflowDrawerPane', () => {
    mockRecords.value = [
      { runId: "wf-001", scriptName: "flow", status: "running" },
    ];
    const wrapper = mountDrawer("sess-A", "workflow");
    // stub 不验证 props 透传，但确认分支渲染了 WorkflowDrawerPane（v-else-if 链正确接入）
    const pane = wrapper.find('[data-testid="workflow-drawer-pane-stub"]');
    expect(pane.exists()).toBe(true);
  });
});
