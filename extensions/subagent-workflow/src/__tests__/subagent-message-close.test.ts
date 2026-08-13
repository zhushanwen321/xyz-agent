// src/__tests__/subagent-message-close.test.ts
//
// M2-B3 message/close action handler + adapter + 四态映射测试。
//
// handler 层测试：mock SubagentService（getRecordForAction/deliverToRunning/resumeRound/
// closeSubagent），验证 messageHandler/closeHandler 的参数校验、状态分流、返回值。
// 归属守卫/终态化/行为分流的真正逻辑在 service 层测试覆盖
//（subagent-service-message-close.test.ts）。

import { describe, expect, it, vi } from "vitest";

import { createRecord } from "../execution/execution-record.ts";
import type { SubagentService } from "../execution/subagent-service.ts";
import type { ExecutionRecord } from "../execution/types.ts";
import { adapter, closeHandler, mapExternalState, messageHandler } from "../interface/subagent-actions.ts";

/** 构造测试用 record（默认非 chatMode running——chatMode 统一投递测试显式传 chatMode:true）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord("sa-test", {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: false,
  });
  Object.assign(r, overrides);
  return r;
}

/** mock SubagentService 的 message/close 相关方法子集。 */
function makeMockService(): SubagentService {
  return {
    getRecordForAction: vi.fn(),
    deliverToRunning: vi.fn(),
    resumeRound: vi.fn(),
    deliverMessage: vi.fn(),
    closeSubagent: vi.fn(),
  } as unknown as SubagentService;
}

// ============================================================
// mapExternalState 四态映射（决策 10 细则 3）
// ============================================================

describe("mapExternalState 四态映射（决策 10 细则 3）", () => {
  it("running → active", () => {
    expect(mapExternalState("running")).toBe("active");
  });
  it("idle → waiting", () => {
    expect(mapExternalState("idle")).toBe("waiting");
  });
  it("done → ended", () => {
    expect(mapExternalState("closed")).toBe("ended");
  });
  it("cancelled → ended", () => {
    expect(mapExternalState("cancelled")).toBe("ended");
  });
  it("closed → ended", () => {
    expect(mapExternalState("closed")).toBe("ended");
  });
});

// ============================================================
// messageHandler 参数校验
// ============================================================

describe("messageHandler 参数校验", () => {
  it("缺 subagentId → throw", async () => {
    const service = makeMockService();
    await expect(messageHandler(service, { text: "hi" })).rejects.toThrow(/subagentId is required/);
  });

  it("text 空白 → throw（含 Correct 正例）", async () => {
    const service = makeMockService();
    await expect(
      messageHandler(service, { subagentId: "sa-1", text: "   " }),
    ).rejects.toThrow(/text is required/);
  });
});

// ============================================================
// messageHandler 非 chatMode 状态分流（回归防护，设计决策 6 状态×interrupt 映射）
// V2 决策 3：chatMode 走 deliverMessage 统一投递（见下方独立 describe）；此处验证
// 非 chatMode record 仍走 deliverToRunning/resumeRound（V2 改造零回归）。
// ============================================================

describe("messageHandler 非 chatMode 状态分流（回归防护，决策 6）", () => {
  it("running + interrupt:true → deliverToRunning(record, text, true)", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "follow up",
      interrupt: true,
    });

    expect(service.deliverToRunning).toHaveBeenCalledWith(record, "follow up", true);
    expect(service.resumeRound).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "message",
      subagentId: "sa-test",
      response: { delivered: true },
    });
  });

  it("running + interrupt 默认 false → deliverToRunning(record, text, false)", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "queue this" });

    expect(service.deliverToRunning).toHaveBeenCalledWith(record, "queue this", false);
  });

  it("idle → resumeRound（interrupt 自动退化，agent 无感）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "idle" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "continue",
      interrupt: true, // idle 时 interrupt 无意义，仍走 resumeRound
    });

    expect(service.resumeRound).toHaveBeenCalledWith(record, "continue");
    expect(service.deliverToRunning).not.toHaveBeenCalled();
    expect(result.response).toEqual({ delivered: true });
  });

  it("终态（done）→ throw ended（含恢复指引）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "closed" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await expect(
      messageHandler(service, { subagentId: "sa-test", text: "hi" }),
    ).rejects.toThrow(/has ended/);
  });

  it("归属守卫：getRecordForAction throw 时透传（not found or not owned）", async () => {
    const service = makeMockService();
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("subagent not found or not owned: sa-x");
    });

    await expect(
      messageHandler(service, { subagentId: "sa-x", text: "hi" }),
    ).rejects.toThrow(/not found or not owned/);
  });
});

// ============================================================
// messageHandler chatMode 统一投递（V2 决策 3）
// ============================================================

describe("messageHandler chatMode 统一投递（V2 决策 3）", () => {
  it("chatMode running → deliverMessage（不走 deliverToRunning/resumeRound）", async () => {
    const service = makeMockService();
    const record = makeRecord({ chatMode: true, status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "follow up",
      interrupt: true,
    });

    expect(service.deliverMessage).toHaveBeenCalledWith(record, "follow up", true);
    expect(service.deliverToRunning).not.toHaveBeenCalled();
    expect(service.resumeRound).not.toHaveBeenCalled();
    expect(result.response).toEqual({ delivered: true });
  });

  it("chatMode idle → deliverMessage（统一投递，不走 resumeRound——V2 进程长驻，判活分流）", async () => {
    const service = makeMockService();
    const record = makeRecord({ chatMode: true, status: "idle" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "continue", interrupt: false });

    expect(service.deliverMessage).toHaveBeenCalledWith(record, "continue", false);
    expect(service.resumeRound).not.toHaveBeenCalled();
    expect(service.deliverToRunning).not.toHaveBeenCalled();
  });

  it("chatMode interrupt 透传 deliverMessage（true=steer / false=followUp）", async () => {
    const service = makeMockService();
    const record = makeRecord({ chatMode: true, status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "stop", interrupt: true });
    expect(service.deliverMessage).toHaveBeenCalledWith(record, "stop", true);
  });
});

// ============================================================
// closeHandler
// ============================================================

describe("closeHandler", () => {
  it("缺 subagentId → throw", async () => {
    const service = makeMockService();
    await expect(closeHandler(service, {})).rejects.toThrow(/subagentId is required/);
  });

  it("正常 → closeSubagent 被调 + 返回 closed:true", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "idle" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);
    (service.closeSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await closeHandler(service, {
      subagentId: "sa-test",
      force: true,
    });

    expect(service.closeSubagent).toHaveBeenCalledWith(record, true);
    expect(result).toEqual({
      kind: "close",
      subagentId: "sa-test",
      response: { closed: true },
    });
  });

  it("force 默认 false", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);
    (service.closeSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await closeHandler(service, { subagentId: "sa-test" });

    expect(service.closeSubagent).toHaveBeenCalledWith(record, false);
  });
});

// ============================================================
// adapter message/close action
// ============================================================

describe("adapter message/close action", () => {
  it("message → content JSON 含 messageResponse.delivered:true", () => {
    const result = adapter({
      action: "message",
      domain: { kind: "message", subagentId: "sa-1", response: { delivered: true } },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ action: "message", messageResponse: { delivered: true } });
  });

  it("close → content JSON 含 closeResponse.closed:true", () => {
    const result = adapter({
      action: "close",
      domain: { kind: "close", subagentId: "sa-1", response: { closed: true } },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ action: "close", closeResponse: { closed: true } });
  });
});
