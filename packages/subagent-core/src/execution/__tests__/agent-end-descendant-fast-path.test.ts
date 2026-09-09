// src/execution/__tests__/agent-end-descendant-fast-path.test.ts
//
// [U2 D3a] 无后代判据派生 + agent_end 零判定快路径（实施计划 u2-descendant 验收条款）。
//
// 设计：docs/design/subagent-agent-end-recovery.md §3.3 D3a + §3.5 错误规格表 D3a 行。
//
// 覆盖：
//   - 条款①（守卫测试）：deriveDescendantCapable 六形态断言——tools undefined / 空数组
//     （pi 默认全工具，物理具备派生能力）/ 含 subagents / 含 workflow / 含 bash（后台
//     记账面，判 false 会误杀进程内 poller）/ 全不含（快路径）+ 清单常量内容锚定。
//   - 条款②（行为测试）：全不含白名单 subagent agent_end 后立即 final kill——零判定
//     （三分支差集读取不触达）、零等待（wakeup grace 15s / no-progress 30min 量级均无
//     残留 timer 副作用）、runSpawn 成功语义收尾。
//   - 条款③（行为测试）：含 bash 白名单不受快路径影响——descendantCapable=true，
//     agent_end 正常走三分支（count>0 → keep-alive；count=0 → final kill）。
//   - 对照：tools undefined（默认全工具）→ 同样不进快路径（既有 keep-alive 语义回归锚）。
//
// mock 布局与 keep-alive-no-progress.test.ts 一致（FakeChild + mock session-pending）；
// mock 工厂与 loggerMock 单源 helpers/spawn-mock.ts，前奏复用 helpers/session-runner-mocks.ts。

import { describe, expect, it, vi } from "vitest";

// [对齐 keep-alive-no-progress] Mock 共享 logger：快路径 debug 文案可被断言。
vi.mock("../../core/logger.ts", async () =>
  (await import("./helpers/spawn-mock.ts")).coreLoggerModule());

vi.mock("node:child_process", async () =>
  (await import("./helpers/spawn-mock.ts")).childProcessModule());
vi.mock("node:fs", async () => (await import("./helpers/spawn-mock.ts")).fsModule());
vi.mock("../alive-store.ts", async () =>
  (await import("./helpers/spawn-mock.ts")).aliveStoreModule());

// 三分支差集判定：默认 count>0（有活跃后代 → keep-alive 分支），用例内按需覆盖。
vi.mock("../session-pending.ts", async () =>
  (await import("./helpers/spawn-mock.ts")).sessionPendingModule());

vi.mock("../engine/engines/pi/temp-prompt.ts", async () =>
  (await import("./helpers/spawn-mock.ts")).tempPromptModule());

import {
  DESCENDANT_CAPABLE_TOOLS,
  deriveDescendantCapable,
  KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS,
  WAKEUP_GRACE_MS,
} from "../engine/engines/pi/session-runner.ts";
import {
  emitStdoutLine,
  loggerMock,
  makeOpts,
} from "./helpers/spawn-mock.ts";
import { keepAliveTestHooks, spawnAndReachKeepAlive, takeSessionRunnerMocks } from "./helpers/session-runner-mocks.ts";

const { mockPending, mockListPending } = takeSessionRunnerMocks();

/** 构造带 tools 白名单的 agentConfig（name/systemPrompt 为 AgentConfig 必填面）。 */
function agentConfigWith(tools: string[] | undefined) {
  return { name: "analyst", systemPrompt: "", tools };
}

// ============================================================
// 条款①：守卫测试——无后代判据六形态
// ============================================================

describe("[U2 D3a] deriveDescendantCapable 无后代判据（六形态守卫）", () => {
  it("tools undefined → true（pi 默认全工具，物理具备派生能力）", () => {
    expect(deriveDescendantCapable(undefined)).toBe(true);
  });

  it("tools 空数组 → true（同 undefined：未限制 = 全工具）", () => {
    expect(deriveDescendantCapable([])).toBe(true);
  });

  it("白名单含 subagents → true（spawn 面可达）", () => {
    expect(deriveDescendantCapable(["read", "subagents"])).toBe(true);
  });

  it("白名单含 workflow → true（spawn 面可达）", () => {
    expect(deriveDescendantCapable(["read", "workflow"])).toBe(true);
  });

  it("白名单含 bash → true（base-tool-enhance 后台模式是 pending 记账一等面，判 false 会误杀进程内 poller）", () => {
    expect(deriveDescendantCapable(["read", "grep", "bash"])).toBe(true);
  });

  it("白名单非空且三者均不含 → false（零判定快路径唯一入口形态）", () => {
    expect(deriveDescendantCapable(["read", "grep"])).toBe(false);
  });

  it("清单常量单点锚定：DESCENDANT_CAPABLE_TOOLS = subagents/workflow/bash（防意外漂移）", () => {
    expect([...DESCENDANT_CAPABLE_TOOLS].sort()).toEqual(["bash", "subagents", "workflow"]);
  });
});

// ============================================================
// 条款②③：行为测试——快路径立即 kill / bash 白名单不受影响
// ============================================================

describe("[U2 D3a] agent_end 零判定快路径（descendantCapable === false）", () => {
  keepAliveTestHooks(mockPending);

  it("全不含白名单：agent_end 后立即 final kill，零判定（差集读取不触达）零等待（无残留 timer）", async () => {
    const opts = makeOpts({ agentConfig: agentConfigWith(["read", "grep"]) });
    const { child, promise } = await spawnAndReachKeepAlive(opts, "Task: fast path kill");

    // 立即 kill：agent_end 处置的同一 setImmediate 内已发 SIGTERM（零等待——若误走
    // 惰性回补，1s 超时在 fake timers 下不流逝，killed 不可能此刻为 true）
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");

    // 零判定：三分支差集读取与 no-progress 复核面均未触达
    expect(mockPending).not.toHaveBeenCalled();
    expect(mockListPending).not.toHaveBeenCalled();

    // 快路径 debug 文案（对齐 keep-alive 分支的 debug 惯例；S4 验收按此 grep）
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("no-descendant fast path"),
    );

    // 模拟 SIGTERM 生效（既有 final-kill 用例收尾：exit 先于 close，killChain 升级窗口结算）
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;

    // 零等待 timer 断言：越过 wakeup grace（15s）+ no-progress 静默阈值（30min）+
    // SIGKILL grace（30s）无任何残留 kill 副作用——快路径不挂 keep-alive /
    // no-progress / 15s 窗口（u3）任何 timer（对齐 keep-alive-no-progress 反证法）
    await vi.advanceTimersByTimeAsync(WAKEUP_GRACE_MS + KEEP_ALIVE_NO_PROGRESS_TIMEOUT_MS + 60_000);
    expect(child.killSignal).toBe("SIGTERM"); // 仅快路径一次信号，无二次信号
    expect(mockPending).not.toHaveBeenCalled();

    // close → 既有收尾链（含 u1 接入点 2 反查兜底路径所在段）可达，runSpawn 成功语义
    expect(result.success).toBe(true);
  });

  it("含 bash 白名单：不受快路径影响——agent_end 正常走三分支（count>0 → keep-alive，count=0 → final kill）", async () => {
    const opts = makeOpts({ agentConfig: agentConfigWith(["read", "grep", "bash"]) });
    // 第一次 agent_end：count>0（bash 后台任务记账面）→ keep-alive 落位；
    // 第二次 agent_end：count=0（任务完成）→ 三分支 final kill（既有语义）
    mockPending
      .mockReturnValueOnce({ count: 1, recentUnregister: false })
      .mockReturnValueOnce({ count: 0, recentUnregister: false });
    const { child, promise } = await spawnAndReachKeepAlive(opts, "Task: bash keep-alive");

    // 关键反证：descendantCapable=true → 快路径未生效（bash 后台 poller 不被误杀）
    expect(child.killed).toBe(false);
    expect(mockPending).toHaveBeenCalledTimes(1); // 三分支差集读取照常触达

    // 后代完成唤醒后的下一次 agent_end：三分支 count=0 → final kill
    emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(true);
    expect(child.killSignal).toBe("SIGTERM");
    expect(mockPending).toHaveBeenCalledTimes(2);

    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  it("对照：tools undefined（默认全工具）→ descendantCapable=true，不进快路径（keep-alive 照走）", async () => {
    const { child, finish } = await spawnAndReachKeepAlive(makeOpts({ agentConfig: undefined }));

    expect(child.killed).toBe(false); // keep-alive 落位（count>0）
    expect(mockPending).toHaveBeenCalledTimes(1);

    await finish();
  });
});
