/**
 * adapters/ports.ts 测试 — UiPort GUI 协议接线（marker 编码集成）。
 *
 * 验证 buildPorts 构造的 uiPort：
 * - setGuiWidget 经 guiSetWidget 编码 marker 进 ctx.ui.setWidget（RPC 模式）
 * - isGui 反映 ctx.mode（rpc → GUI 渲染通道；tui → 原生文本）
 *
 * 运行：cd extensions/goal && npx vitest run src/__tests__/ports.test.ts
 */
import { describe, expect, it } from "vitest";
import { GUI_WIDGET_MARKER, guiComponent } from "@xyz-agent/extension-protocol";

import { buildPorts } from "../adapters/ports";

/** mock pi（buildPorts 仅用 pi.appendEntry，此处不测 persistence）。 */
function makePi(): Parameters<typeof buildPorts>[0] {
	return { appendEntry: () => {} } as unknown as Parameters<typeof buildPorts>[0];
}

/** mock ctx，捕获 ui.setWidget 收到的 lines（验证 marker 编码）。 */
function makeCtx(opts: { mode?: string; hasUI?: boolean } = {}) {
	let captured: string[] | undefined = undefined;
	const ctx = {
		mode: opts.mode ?? "rpc",
		hasUI: opts.hasUI ?? true,
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => {
				captured = lines;
			},
			setStatus: () => {},
			notify: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
	} as unknown as Parameters<typeof buildPorts>[1];
	return { ctx, getCaptured: () => captured };
}

describe("buildPorts UiPort.setGuiWidget（marker 编码集成）", () => {
	it("RPC 模式 setGuiWidget → ctx.ui.setWidget 收到 marker 编码的 string[]", () => {
		const { ctx, getCaptured } = makeCtx({ mode: "rpc" });
		const ports = buildPorts(makePi(), ctx);
		const comp = guiComponent("stats-line", { items: [{ value: "x" }] });

		ports.ui.setGuiWidget("goal", comp);

		const captured = getCaptured();
		expect(captured).toBeDefined();
		expect(captured).toHaveLength(1);
		// marker 前缀（host 侧 event-adapter 据此解码成 extension:widgetGui）
		expect(captured![0].startsWith(GUI_WIDGET_MARKER)).toBe(true);
		// 解码还原 GuiComponent
		const json = captured![0].slice(GUI_WIDGET_MARKER.length);
		const parsed = JSON.parse(json);
		expect(parsed.type).toBe("stats-line");
	});

	it("setGuiWidget(undefined) → ctx.ui.setWidget 收到 undefined（清除语义）", () => {
		const { ctx, getCaptured } = makeCtx({ mode: "rpc" });
		const ports = buildPorts(makePi(), ctx);

		ports.ui.setGuiWidget("goal", undefined);

		expect(getCaptured()).toBeUndefined();
	});
});

describe("buildPorts UiPort.isGui（ctx.mode 反映）", () => {
	it("rpc 模式 → isGui=true（GUI 渲染通道有效）", () => {
		const { ctx } = makeCtx({ mode: "rpc" });
		expect(buildPorts(makePi(), ctx).ui.isGui).toBe(true);
	});

	it("tui 模式 → isGui=false（走原生文本行）", () => {
		const { ctx } = makeCtx({ mode: "tui" });
		expect(buildPorts(makePi(), ctx).ui.isGui).toBe(false);
	});
});
