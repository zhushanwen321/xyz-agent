/**
 * useWorkflowDrawerTabs 单测（workflow DAG 可视化 W1 wave；W3 改单例后适配）。
 *
 * 覆盖二级 tab 状态管理（per-session 隔离 Map 分区）的 3 个场景：
 * 1. open/close/isOpened 基本流程
 * 2. 切 session 隔离（A 打开的 run 不在 B 出现）
 * 3. 重复 open 更新时间戳排序（最近打开在前）
 *
 * [W3] useWorkflowDrawerTabs 已改为模块级单例（对齐 useSideDrawer）：分区键来自
 * panelStore.focusedSessionId。测试 mock @/stores/panel 控制 focusedSessionId，
 * 用 resetWorkflowDrawerTabs 清分区隔离（与 useSideDrawer.test.ts 同范式）。
 *
 * 运行：npx vitest run src/composables/workflow/__tests__/use-workflow-drawer-tabs.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref, nextTick } from "vue";

// ── mock panel store：控制 focusedSessionId（active panel 的 sessionId）──
// useWorkflowDrawerTabs 内部读 panel store 的 focusedSessionId computed 作分区键。
const mockFocusedSessionId = ref<string | null>(null);

vi.mock("@/stores/panel", () => ({
  usePanelStore: () => ({
    get focusedSessionId() {
      return mockFocusedSessionId.value;
    },
  }),
}));

import {
  useWorkflowDrawerTabs,
  resetWorkflowDrawerTabs,
} from "../use-workflow-drawer-tabs";

/** 切换当前 focused session（模拟 selectSession 改 active panel 的 session 绑定） */
function focusSession(sid: string | null): void {
  mockFocusedSessionId.value = sid;
}

beforeEach(() => {
  resetWorkflowDrawerTabs();
  mockFocusedSessionId.value = null;
});

describe("W1 useWorkflowDrawerTabs: 二级 tab 状态管理", () => {
  it("场景1 open/close/isOpened：open 后 isWorkflowOpened=true 且列表含该 run；close 后清空", async () => {
    focusSession("session-A");
    const { isWorkflowOpened, openedRunIds, openWorkflow, closeWorkflow } =
      useWorkflowDrawerTabs();

    // 初始无打开
    expect(isWorkflowOpened("wf-001")).toBe(false);
    expect(openedRunIds.value).toEqual([]);

    // open wf-001
    openWorkflow("wf-001");
    await nextTick();
    expect(isWorkflowOpened("wf-001")).toBe(true);
    expect(openedRunIds.value).toContain("wf-001");

    // close wf-001
    closeWorkflow("wf-001");
    await nextTick();
    expect(isWorkflowOpened("wf-001")).toBe(false);
    expect(openedRunIds.value).toEqual([]);
  });

  it("场景2 切 session 隔离：A 打开的 run 不在 B 的 openedRunIds 出现", async () => {
    focusSession("session-A");
    const { openedRunIds, openWorkflow, isWorkflowOpened } =
      useWorkflowDrawerTabs();

    // 在 A 打开 wf-001
    openWorkflow("wf-001");
    await nextTick();
    expect(openedRunIds.value).toContain("wf-001");

    // 切到 session-B：B 分区独立，不含 A 打开的 run
    focusSession("session-B");
    await nextTick();
    expect(openedRunIds.value).toEqual([]);
    expect(isWorkflowOpened("wf-001")).toBe(false);

    // 切回 A：A 分区数据保留（不丢失）
    focusSession("session-A");
    await nextTick();
    expect(openedRunIds.value).toContain("wf-001");
    expect(isWorkflowOpened("wf-001")).toBe(true);
  });

  it("场景3 重复 open 更新时间戳排序：最近打开的排前（DESC）", async () => {
    // 用 fake timers 让 Date.now() 在每次 open 时递增，确保时间戳可区分排序
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const t = now;
      now += 1000; // 每次 Date.now() 调用递增 1s
      return t;
    });

    focusSession("session-A");
    const { openedRunIds, openWorkflow } = useWorkflowDrawerTabs();

    try {
      // open wf-001（t=1000000）
      openWorkflow("wf-001");
      // open wf-002（t=1001000）
      openWorkflow("wf-002");
      // 再次 open wf-001（t=1002000，更新为最新）→ wf-001 应排前
      openWorkflow("wf-001");
      await nextTick();

      // 最近打开在前（DESC）：wf-001（最新）→ wf-002
      expect(openedRunIds.value).toEqual(["wf-001", "wf-002"]);
    } finally {
      dateSpy.mockRestore();
    }
  });
});
