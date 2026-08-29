// src/__tests__/ui-request-handler-factory.test.ts
//
// C1 测试：ui-request-handler-factory.ts — createUiRequestHandlerForMode 透传矩阵。
//
// 透传矩阵（createUiRequestHandlerForMode 返回的 handler 行为）：
//   - headless（json/print/undefined）：返回 undefined（不注入 handler）
//   - TUI：fire-and-forget 回 ack 不透传；dialog 进 dialogQueue 串行
//   - GUI（rpc）：fire-and-forget 直接调 realHandler；dialog 进 dialogQueue 串行
// realHandler 路由：channel 命中 → channelHandler（经 coerceUiResponse 形变）；未命中 → defaultDialogForward（dialog 转发结果，fire-and-forget 转发 ctx.ui.* 后回 ack，未知 method warn + ack）。
// 测接口契约，不测实现细节。

import type { ExtensionContext, ExtensionMode } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("../../core/logger.ts", () => ({
  getLogger: () => loggerMock,
}));

import { DialogGlobalQueue, type UiRequest } from "../dialog-queue.ts";
import { type ChannelHandler,createUiChannelRegistry } from "../ui-channels.ts";
import { createUiRequestHandlerForMode } from "../ui-request-handler-factory.ts";

// mock ExtensionContext 已补 mode 字段（host-mode.ts 读它分流）。最小形状构造。
function makeCtx(mode: ExtensionMode): ExtensionContext {
  return {
    cwd: "/tmp/test",
    mode,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getSessionDir: () => "/tmp/test/sessions",
    },
    modelRegistry: undefined,
    model: undefined,
  } as ExtensionContext;
}

/** 带 mock ctx.ui 的 ExtensionContext（GUI fire-and-forget 转发测试用）。
 *  dialog method（select/confirm/input/editor）返回 undefined/true/"" 兜底，
 *  fire-and-forget method（notify/setStatus/setWidget/setTitle/setEditorText）是 void spy。 */
function makeCtxWithUi(mode: ExtensionMode = "rpc"): ExtensionContext & { ui: Record<string, ReturnType<typeof vi.fn>> } {
  const ui: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    input: vi.fn(async () => ""),
    editor: vi.fn(async () => ""),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setTitle: vi.fn(),
    setEditorText: vi.fn(),
  };
  return {
    cwd: "/tmp/test",
    mode,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getSessionDir: () => "/tmp/test/sessions",
    },
    modelRegistry: undefined,
    model: undefined,
    ui,
  } as unknown as ExtensionContext & { ui: Record<string, ReturnType<typeof vi.fn>> };
}

function dialogReq(id: string, channel?: string): UiRequest {
  return { method: "select", id, title: `q-${id}`, ...(channel ? { channel } : {}) };
}

function fireAndForgetReq(id: string): UiRequest {
  return { method: "notify", id, message: `n-${id}` };
}

// dialog 路径用 fake timers 推进 processNext；静默 console.warn/error（stub 故意 warn）。
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  loggerMock.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createUiRequestHandlerForMode — headless 返回 undefined", () => {
  it("mode='json' → undefined（不注入 handler）", () => {
    const queue = new DialogGlobalQueue();
    expect(createUiRequestHandlerForMode(makeCtx("json"), createUiChannelRegistry(), queue))
      .toBeUndefined();
  });

  it("mode='print' → undefined", () => {
    const queue = new DialogGlobalQueue();
    expect(createUiRequestHandlerForMode(makeCtx("print"), createUiChannelRegistry(), queue))
      .toBeUndefined();
  });
});

describe("createUiRequestHandlerForMode — TUI 模式透传", () => {
  it("fire-and-forget（notify）→ {ack:true}，不调 realHandler / 不入队", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("tui"), registry, queue)!;
    const resp = await handler(fireAndForgetReq("f1"));

    expect(resp).toEqual({ ack: true });
    expect(console.warn).not.toHaveBeenCalled(); // realHandler（defaultDialogForward）未走
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("dialog（select 无 channel）→ 进 dialogQueue（enqueue 被调，defaultDialogForward stub cancelled）", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("tui"), registry, queue)!;
    const pending = handler(dialogReq("d1"));

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});

describe("createUiRequestHandlerForMode — GUI（rpc）模式透传", () => {
  it("fire-and-forget（notify）→ 直接调 realHandler，不入队", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const ctx = makeCtxWithUi("rpc");
    const handler = createUiRequestHandlerForMode(ctx, registry, queue)!;
    // notify 无 channel → realHandler → defaultDialogForward → case "notify" → {ack:true}
    const resp = await handler(fireAndForgetReq("f1"));

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("n-f1", "info");
  });

  it("dialog（select 无 channel）→ 进 dialogQueue", async () => {
    const registry = createUiChannelRegistry();
    const queue = new DialogGlobalQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, queue)!;
    const pending = handler(dialogReq("d1"));

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});

describe("createUiRequestHandlerForMode — channel 业务路由", () => {
  it("channel 命中 registry → 调注册的 channelHandler（不走 defaultDialogForward）", async () => {
    const registry = createUiChannelRegistry();
    const channelHandler: ChannelHandler = vi.fn(async () => ({ value: "from-channel" }));
    registry.register("ask_user", channelHandler);

    // GUI fire-and-forget 直接调 realHandler，绕过队列；channel 命中立即生效
    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, new DialogGlobalQueue())!;
    const resp = await handler({ method: "notify", id: "f1", message: "m", channel: "ask_user" });

    expect(channelHandler).toHaveBeenCalledTimes(1);
    expect(resp).toEqual({ value: "from-channel" });
  });

  it("channel 未命中 → defaultDialogForward（fire-and-forget 走 ack）", async () => {
    const ctx = makeCtxWithUi("rpc");
    const handler = createUiRequestHandlerForMode(
      ctx, createUiChannelRegistry(), new DialogGlobalQueue())!;
    const resp = await handler({ method: "notify", id: "f1", message: "m", channel: "unknown" });
    // notify 是 fire-and-forget，channel miss 后走 defaultDialogForward 的 notify case → ack
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("m", "info");
  });
});

// coerceUiResponse 形变（通过 channelHandler 返回不同 shape 间接测）
describe("createUiRequestHandlerForMode — coerceUiResponse 形变", () => {
  async function callWithChannel(raw: unknown) {
    const registry = createUiChannelRegistry();
    registry.register("ask_user", (async () => raw) as ChannelHandler);
    const handler = createUiRequestHandlerForMode(makeCtx("rpc"), registry, new DialogGlobalQueue())!;
    return handler({ method: "notify", id: "f1", message: "m", channel: "ask_user" });
  }

  it("channelHandler 返回 {value:'x'} → {value:'x'}", async () => {
    expect(await callWithChannel({ value: "x" })).toEqual({ value: "x" });
  });

  it("channelHandler 返回 {confirmed:true} → {confirmed:true}", async () => {
    expect(await callWithChannel({ confirmed: true })).toEqual({ confirmed: true });
  });

  it("channelHandler 返回 null（非法）→ 降级 {cancelled:true}", async () => {
    expect(await callWithChannel(null)).toEqual({ cancelled: true });
  });
});

// ── P1：GUI fire-and-forget 分类转发（§3.2 映射表 + §3.7 D1/D2） ──
describe("defaultDialogForward — fire-and-forget 分类转发", () => {
  function makeHandler(ctx: ExtensionContext) {
    return createUiRequestHandlerForMode(
      ctx, createUiChannelRegistry(), new DialogGlobalQueue())!;
  }

  // (a) 五个 case 转发调用与 ack 返回
  it("notify → ctx.ui.notify + {ack:true}", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "notify", id: "n1", message: "hello" });
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("hello", "info");
  });

  it("setStatus → ctx.ui.setStatus + {ack:true}", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "setStatus", id: "s1", statusKey: "progress", statusText: "50%" });
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("progress", "50%");
  });

  it("setWidget（channel=undefined）→ ctx.ui.setWidget 含 placement + {ack:true}", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({
      method: "setWidget", id: "w1",
      widgetKey: "my-widget", widgetLines: ["line1", "line2"],
      widgetPlacement: "belowEditor",
    });
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("my-widget", ["line1", "line2"], { placement: "belowEditor" });
  });

  it("setTitle → ctx.ui.setTitle + {ack:true}", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "setTitle", id: "t1", title: "My Title" });
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.setTitle).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setTitle).toHaveBeenCalledWith("My Title");
  });

  it("set_editor_text → ctx.ui.setEditorText + {ack:true}", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "set_editor_text", id: "e1", text: "some code" });
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.setEditorText).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("some code");
  });

  // (b) notifyType 收窄三档 + 非法值 fallback info
  it.each([
    ["info", "info"],
    ["warning", "warning"],
    ["error", "error"],
  ] as const)("notifyType='%s' → 透传 '%s'", async (input, expected) => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    await handler({ method: "notify", id: "n1", message: "m", notifyType: input });
    expect(ctx.ui.notify).toHaveBeenCalledWith("m", expected);
  });

  it("notifyType 非法值 → fallback 'info'", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    await handler({ method: "notify", id: "n1", message: "m", notifyType: "debug" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("m", "info");
  });

  it("notifyType undefined → fallback 'info'", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    await handler({ method: "notify", id: "n1", message: "m" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("m", "info");
  });

  // (c) setWidget 两分支
  it("setWidget channel='gui_widget' → 不调 ctx.ui.setWidget，回 {ack:true}", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({
      method: "setWidget", id: "w1",
      widgetKey: "gui-w", widgetLines: ["\0XYZ_GUI_WIDGET:{...}"],
      channel: "gui_widget",
    });
    expect(resp).toEqual({ ack: true });
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("setWidget channel=undefined → 转发含 placement", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    await handler({
      method: "setWidget", id: "w1",
      widgetKey: "k", widgetLines: ["a"],
      widgetPlacement: "aboveEditor",
    });
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("k", ["a"], { placement: "aboveEditor" });
  });

  // (d) 未知 method warn + ack
  it("未知 method → logger.warn + {ack:true}（非 cancelled）", async () => {
    const ctx = makeCtxWithUi();
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "futureMethod", id: "x1" });
    expect(resp).toEqual({ ack: true });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown method"),
      expect.objectContaining({ detail: { method: "futureMethod", id: "x1" } }),
    );
  });

  // (e) dialog 既有 case 不回归（select/confirm 代表）
  it("select 无 channel → 调 ctx.ui.select + 透传 value", async () => {
    const ctx = makeCtxWithUi();
    ctx.ui.select.mockResolvedValueOnce("picked");
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "select", id: "d1", title: "Choose", options: ["a", "b"] });
    expect(resp).toEqual({ value: "picked" });
    expect(ctx.ui.select).toHaveBeenCalledWith("Choose", ["a", "b"]);
  });

  it("confirm 无 channel → 调 ctx.ui.confirm + 透传 confirmed", async () => {
    const ctx = makeCtxWithUi();
    ctx.ui.confirm.mockResolvedValueOnce(false);
    const handler = makeHandler(ctx);
    const resp = await handler({ method: "confirm", id: "d2", title: "Sure?", message: "Go?" });
    expect(resp).toEqual({ confirmed: false });
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Sure?", "Go?");
  });
});

// ── 确认 createUiRequestHandlerForMode 未改动（TUI 行为零变化） ──
describe("createUiRequestHandlerForMode — TUI 零回归", () => {
  it("TUI 下所有 fire-and-forget method 均回 ack 且不调 ctx.ui", async () => {
    const methods = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"];
    for (const method of methods) {
      const ctx = makeCtxWithUi("tui");
      const handler = createUiRequestHandlerForMode(
        ctx, createUiChannelRegistry(), new DialogGlobalQueue())!;
      const resp = await handler({ method, id: "t1" });
      expect(resp).toEqual({ ack: true });
      // TUI 不透传，ctx.ui 方法不应被调用
      for (const fn of Object.values(ctx.ui)) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  });
});
