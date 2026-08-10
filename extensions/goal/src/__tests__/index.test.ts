/**
 * index.ts 测试 — 工厂入口 + 跨扩展 API（pi.__goalInit）
 *
 * 覆盖 T1.8 (NFR-AC-8)：__goalInit 签名 (objective, budget, ctx)，结构上无法接收 tasks
 * （task CRUD 已删除，D-16/FR-4 双轨消除）。active 守卫由 service.test.ts 覆盖。
 *
 * 用最小 fake pi + fake ctx 实例化 goalExtension 工厂，再调 pi.__goalInit。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import goalExtension from "../index";

// ── Minimal fake pi / ctx ─────────────────────────────

interface FactoryFixture {
	pi: ExtensionAPI & { __goalInit?: (...args: never[]) => unknown };
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	sendUser: unknown[];
	commands: Record<string, { description?: string }>;
}

/** 工厂所需的最小 pi：registerCommand/registerTool/on/registerMessageRenderer + appendEntry/sendMessage/sendUserMessage */
function makeFactoryFixture(): FactoryFixture {
	const states: unknown[] = [];
	const history: unknown[] = [];
	const sendUser: unknown[] = [];
	const commands: Record<string, { description?: string }> = {};
	const pi = {
		registerCommand: (name: string, opts: { description?: string }) => {
			commands[name] = { description: opts.description };
		},
		registerTool: () => {},
		on: () => {},
		registerMessageRenderer: () => {},
		appendEntry(customType: string, data?: unknown): void {
			if (customType === "goal-history") history.push(data);
			else states.push(data);
		},
		sendMessage: () => {},
		sendUserMessage(content: unknown): void {
			sendUser.push(content);
		},
	} as unknown as ExtensionAPI & { __goalInit?: (...args: never[]) => unknown };

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, sendUser, commands };
}

// ── pi.__goalInit（NFR-AC-8 / T1.8）──────────────────

describe("pi.__goalInit（NFR-AC-8 / T1.8）", () => {
	it("工厂实例化后 __goalInit 存在；正常调用 → 创建 goal（返回 true + 持久化 state）", () => {
		const { pi, ctx, states } = makeFactoryFixture();
		goalExtension(pi);
		expect(typeof pi.__goalInit).toBe("function");
		const ok = (pi.__goalInit as (o: string, b: unknown, c: ExtensionContext) => boolean)(
			"build feature X",
			undefined,
			ctx,
		);
		expect(ok).toBe(true);
		expect(states).toHaveLength(1); // appendState 调用
		const persisted = states[0] as { objective?: string };
		expect(persisted.objective).toBe("build feature X");
	});

	it("ctx 缺失 → 返回 false（创建失败，不 throw）", () => {
		// FR-4.2/D-16: ctx 必填
		const { pi } = makeFactoryFixture();
		goalExtension(pi);
		const init = pi.__goalInit as (o: string, b: unknown, c: unknown) => boolean;
		expect(() => init("obj", undefined, undefined)).not.toThrow();
		expect(init("obj", undefined, undefined)).toBe(false);
	});
});

// ── /goal 命令注册（TC9）─────────────────────────

describe("/goal 命令注册（TC9）", () => {
	it("goal 命令已注册且有 description", () => {
		const { pi, commands } = makeFactoryFixture();
		goalExtension(pi);
		expect(commands["goal"]).toBeDefined();
		expect(commands["goal"]?.description?.length).toBeGreaterThan(0);
	});
});
