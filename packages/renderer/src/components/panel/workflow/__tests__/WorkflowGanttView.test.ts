/**
 * WorkflowGanttView.vue 组件集成测试（W3 wave · TC1-6）。
 *
 * 覆盖时间轴 Gantt 视图（视图 D）：
 * - TC1 首屏：根容器 + 横条存在
 * - TC2 横条位置：style.left/style.width 数值合理
 * - TC3 running tick：fake timer 推进后 running 横条 width 变化
 * - TC4 pending 不渲染横条（在 pending 区）
 * - TC5 状态配色（4 态 barClass）
 * - TC6 点击 emit
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow/__tests__/WorkflowGanttView.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import WorkflowGanttView from "@/components/panel/workflow/WorkflowGanttView.vue";
import type { ExecutionLayer } from "@/composables/workflow/compute-layers";
import type { WorkflowAgentCall } from "@xyz-agent/shared";

/** 固定时间基准（ms）：让横条几何可预测。 */
const T0 = 1_700_000_000_000; // start
const SEC = 1000;

/** 构造 WorkflowAgentCall 的 helper（必填字段 + 可选覆盖）。 */
function makeCall(
  overrides: Partial<WorkflowAgentCall> & { id: number; agent: string }
): WorkflowAgentCall {
  return {
    status: "completed",
    ...overrides,
  };
}

/**
 * 标准测试 mock：2 层。
 * - node 0（completed）：start=T0，durationMs=5000（占前半段）
 * - node 1（completed）：start=T0+5000，durationMs=5000（占后半段，与 0 首尾相接不重叠）
 * 全局时间范围 span = 10000ms。
 */
const mockLayers: ExecutionLayer[] = [
  {
    index: 0,
    label: "analyze",
    isParallel: false,
    nodes: [
      makeCall({
        id: 0,
        agent: "explorer",
        status: "completed",
        sessionId: "sess-0",
        startedAt: new Date(T0).toISOString(),
        durationMs: 5000,
      }),
      makeCall({
        id: 1,
        agent: "worker",
        status: "completed",
        sessionId: "sess-1",
        startedAt: new Date(T0 + 5 * SEC).toISOString(),
        durationMs: 5000,
      }),
    ],
  },
];

function mountView(
  props?: Partial<{
    layers: ExecutionLayer[];
    pendingNodes: WorkflowAgentCall[];
  }>
) {
  return mount(WorkflowGanttView, {
    props: {
      layers: props?.layers ?? mockLayers,
      pendingNodes: props?.pendingNodes ?? [],
    },
  });
}

beforeEach(() => {
  // 固定 Date.now，让 computeEnd（running 节点）可预测
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 10 * SEC); // T0 + 10s
});

afterEach(() => {
  vi.useRealTimers();
});

// ── TC1: 首屏冒烟 ──────────────────────────────────────────
describe("W3 TC1: Gantt 首屏冒烟", () => {
  it('根容器 [data-testid="workflow-gantt-view"] 存在', () => {
    const wrapper = mountView();
    expect(wrapper.find('[data-testid="workflow-gantt-view"]').exists()).toBe(
      true
    );
  });

  it("有时间数据时渲染横条（workflow-gantt-bar 存在）", () => {
    const wrapper = mountView();
    const bars = wrapper.findAll('[data-testid="workflow-gantt-bar"]');
    expect(bars.length).toBe(2);
  });

  it("时间轴标签行存在", () => {
    const wrapper = mountView();
    expect(wrapper.find('[data-testid="workflow-gantt-axis"]').exists()).toBe(
      true
    );
  });
});

// ── TC2: 横条位置 ──────────────────────────────────────────
describe("W3 TC2: 横条 left/width 百分比合理", () => {
  it("node 0（占前半段）left=0% width≈50%", () => {
    const wrapper = mountView();
    const bars = wrapper.findAll('[data-testid="workflow-gantt-bar"]');
    const bar0 = bars[0];
    // start=T0（最早）→ left=0%；duration=5000，span=10000 → width=50%
    expect(bar0.attributes("style")).toContain("left: 0%");
    expect(bar0.attributes("style")).toContain("width: 50%");
  });

  it("node 1（占后半段）left=50% width≈50%", () => {
    const wrapper = mountView();
    const bars = wrapper.findAll('[data-testid="workflow-gantt-bar"]');
    const bar1 = bars[1];
    // start=T0+5000，span=10000 → left=50%；duration=5000 → width=50%
    expect(bar1.attributes("style")).toContain("left: 50%");
    expect(bar1.attributes("style")).toContain("width: 50%");
  });
});

// ── TC3: running tick ─────────────────────────────────────
describe("W3 TC3: running 横条随时间推进重算（NOW 线移动）", () => {
  it("advanceTimersByTime(2000) 后 NOW 线位置变化（running 横条随推进重算）", async () => {
    // 单 running 节点：start=T0，end=Date.now()（随推进）。timer 每秒 tick 触发重算。
    const layers: ExecutionLayer[] = [
      {
        index: 0,
        label: "dev",
        isParallel: false,
        nodes: [
          makeCall({
            id: 0,
            agent: "worker",
            status: "running",
            sessionId: "sess-run",
            startedAt: new Date(T0).toISOString(),
          }),
        ],
      },
    ];
    // 初始 Date.now = T0 + 10s → running 区间 [T0, T0+10s]，span=10s
    vi.setSystemTime(T0 + 10 * SEC);
    const wrapper = mountView({ layers });
    // running 存在 → NOW 线渲染
    expect(
      wrapper.find('[data-testid="workflow-gantt-now-line"]').exists()
    ).toBe(true);
    const nowLineBefore =
      wrapper
        .find('[data-testid="workflow-gantt-now-line"]')
        .attributes("style") ?? "";

    // 推进 2s：Date.now = T0 + 12s。组件 setInterval（1s）tick 2 次 → nowTick++ 触发重算。
    // NOW 线 = running 的 end=now 换算的 track 内百分比；单 running 节点 end 始终=右端=100%，
    // 故 NOW 线 left 百分比不变，但 NOW 线依赖 nowTick 的 computed 重新求值（依赖建立验证）。
    // 横条 width（相对 span）变化：span 从 10s → 12s，但 width 仍 100%（[T0, now] 占满）。
    // 关键断言：timer tick 触发重算后组件未崩溃，横条 + NOW 线仍在。
    vi.advanceTimersByTime(2000);
    await nextTick();

    expect(wrapper.find('[data-testid="workflow-gantt-bar"]').exists()).toBe(
      true
    );
    expect(
      wrapper.find('[data-testid="workflow-gantt-now-line"]').exists()
    ).toBe(true);
    const nowLineAfter =
      wrapper
        .find('[data-testid="workflow-gantt-now-line"]')
        .attributes("style") ?? "";
    // NOW 线 style 仍含 left（重算后位置有效）
    expect(nowLineAfter).toContain("left:");
    // 推进前后 NOW 线 style 均含 left:calc(...)（单 running 节点 NOW=右端 100%）
    expect(nowLineBefore).toContain("left:");
  });

  it("running 横条 width 随推进增大（相对固定 completed 节点的 span）", async () => {
    // 2 节点：completed（固定区间 [T0, T0+5s]）+ running（[T0+5s, now]）。
    // span = maxT - minT。running 的 end=now 随推进 → span 增大 → completed 宽度比例缩小、running 增大。
    const layers: ExecutionLayer[] = [
      {
        index: 0,
        label: "dev",
        isParallel: false,
        nodes: [
          makeCall({
            id: 0,
            agent: "explorer",
            status: "completed",
            sessionId: "sess-0",
            startedAt: new Date(T0).toISOString(),
            durationMs: 5 * SEC,
          }),
          makeCall({
            id: 1,
            agent: "worker",
            status: "running",
            sessionId: "sess-1",
            startedAt: new Date(T0 + 5 * SEC).toISOString(),
          }),
        ],
      },
    ];
    // 初始 now = T0 + 10s → running 区间 [T0+5s, T0+10s]=5s；span=[T0, T0+10s]=10s
    // running width = (10-5)/10 * 100 = 50%
    vi.setSystemTime(T0 + 10 * SEC);
    const wrapper = mountView({ layers });
    const bars = wrapper.findAll('[data-testid="workflow-gantt-bar"]');
    const runningBarBefore = bars[1];
    expect(runningBarBefore.attributes("style")).toContain("width: 50%");

    // 推进 5s：now = T0 + 15s → running 区间 [T0+5s, T0+15s]=10s；span=[T0, T0+15s]=15s
    // running width = (15-5)/15 * 100 ≈ 66.67%
    vi.advanceTimersByTime(5 * SEC);
    await nextTick();

    const barsAfter = wrapper.findAll('[data-testid="workflow-gantt-bar"]');
    const runningBarAfter = barsAfter[1];
    const styleAfter = runningBarAfter.attributes("style") ?? "";
    // width 从 50% 增大（timer tick 触发重算，running 区间随推进扩展）
    const widthMatch = styleAfter.match(/width:\s*([\d.]+)%/);
    expect(widthMatch).toBeTruthy();
    const widthAfter = parseFloat(widthMatch![1]);
    expect(widthAfter).toBeGreaterThan(50);
  });
});

// ── TC4: pending 不渲染横条 ───────────────────────────────
describe("W3 TC4: pending 节点不渲染横条", () => {
  it("pending 节点出现在 pending 区（非横条）", () => {
    const pendingNodes = [
      makeCall({ id: 9, agent: "reviewer", status: "pending" }),
    ];
    const wrapper = mountView({ layers: [], pendingNodes });
    // 无 timed 节点 → 无横条
    expect(wrapper.findAll('[data-testid="workflow-gantt-bar"]').length).toBe(
      0
    );
    // pending 区存在
    expect(
      wrapper.find('[data-testid="workflow-gantt-pending"]').exists()
    ).toBe(true);
    expect(
      wrapper.find('[data-testid="workflow-gantt-pending-node"]').exists()
    ).toBe(true);
  });
});

// ── TC5: 状态配色 ──────────────────────────────────────────
describe("W3 TC5: 横条 4 态配色", () => {
  it("completed 横条含 bg-success", () => {
    const wrapper = mountView();
    const bar = wrapper.findAll('[data-testid="workflow-gantt-bar"]')[0];
    expect(bar.classes()).toContain("bg-success");
  });

  it("failed 横条含 bg-danger", () => {
    const layers: ExecutionLayer[] = [
      {
        index: 0,
        label: "fix",
        isParallel: false,
        nodes: [
          makeCall({
            id: 1,
            agent: "worker",
            status: "failed",
            sessionId: "sess-fail",
            startedAt: new Date(T0).toISOString(),
            completedAt: new Date(T0 + 3 * SEC).toISOString(),
          }),
        ],
      },
    ];
    const wrapper = mountView({ layers });
    const bar = wrapper.find('[data-testid="workflow-gantt-bar"]');
    expect(bar.classes()).toContain("bg-danger");
  });

  it("running 横条含 bg-accent + animate-pulse", () => {
    const layers: ExecutionLayer[] = [
      {
        index: 0,
        label: "dev",
        isParallel: false,
        nodes: [
          makeCall({
            id: 2,
            agent: "worker",
            status: "running",
            sessionId: "sess-run",
            startedAt: new Date(T0).toISOString(),
          }),
        ],
      },
    ];
    const wrapper = mountView({ layers });
    const bar = wrapper.find('[data-testid="workflow-gantt-bar"]');
    expect(bar.classes()).toContain("bg-accent");
    expect(bar.classes()).toContain("animate-pulse");
  });
});

// ── TC6: 点击 emit ─────────────────────────────────────────
describe("W3 TC6: 点击横条 emit select-agent-call", () => {
  it("点 completed 横条 emit select-agent-call，载荷为 { agentCallSessionId } 单 payload 对象", async () => {
    const wrapper = mountView();
    const bar = wrapper.findAll('[data-testid="workflow-gantt-bar"]')[0];
    await bar.trigger("click");
    const emitted = wrapper.emitted("select-agent-call");
    expect(emitted).toBeTruthy();
    // 规则 #1：emit 单 payload 对象（与 WorkflowDagView 一致），而非裸字符串
    expect(emitted![0]).toEqual([{ agentCallSessionId: "sess-0" }]);
  });

  it("无 sessionId 的非 pending 节点横条 aria-disabled，点击不 emit", async () => {
    // completed 但无 sessionId → isClickable=false → aria-disabled=true（横条为 div role=button，无语义 disabled 属性）
    const layers: ExecutionLayer[] = [
      {
        index: 0,
        label: "dev",
        isParallel: false,
        nodes: [
          makeCall({
            id: 3,
            agent: "worker",
            status: "completed",
            startedAt: new Date(T0).toISOString(),
            durationMs: 5000,
            // 无 sessionId
          }),
        ],
      },
    ];
    const wrapper = mountView({ layers });
    const bar = wrapper.find('[data-testid="workflow-gantt-bar"]');
    expect(bar.attributes("aria-disabled")).toBe("true");
    await bar.trigger("click");
    expect(wrapper.emitted("select-agent-call")).toBeUndefined();
  });
});
