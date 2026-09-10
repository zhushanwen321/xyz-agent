// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/pending-notifications.test.ts
//
// W1 核心实现测试。覆盖 plan.md U1-U11。
//
// 测试策略：
// - 用最小 mock 的 ExtensionAPI（mock events.on/emit、appendEntry、on、registerTool）
// - 用最小 mock 的 ExtensionContext（mock sessionManager.getEntries/getSessionId）
// - 调 pendingNotificationsExtension(pi) 触发工厂注册 handler
// - 手动触发 session_start / events / tool / session_shutdown，断言 state + appendEntry

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pendingNotificationsExtension from "../index";
import type { PendingEntry } from "../state";
import {
	countActiveFromEntries,
	createRegistry,
	getActive,
	PENDING_LIFECYCLE,
	normalizePendingType,
	rebuildFromEntries,
	register,
	unregister,
} from "../state";

// ── Mock 工具 ───────────────────────────────────────

interface HandlerRegistry {
	sessionStart: ((event: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
	sessionShutdown: ((event: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
	pendingRegister: ((data: unknown) => void) | undefined;
	pendingUnregister: ((data: unknown) => void) | undefined;
}

interface MockSessionEntry {
	customType: string;
	data: Record<string, unknown>;
}

interface MockSetup {
	pi: ExtensionAPI;
	handlers: HandlerRegistry;
	appendEntryMock: ReturnType<typeof vi.fn>;
	registerToolMock: ReturnType<typeof vi.fn>;
	sendMessageMock: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockSetup {
	const handlers: HandlerRegistry = {
		sessionStart: undefined,
		sessionShutdown: undefined,
		pendingRegister: undefined,
		pendingUnregister: undefined,
	};
	const appendEntryMock = vi.fn();
	const registerToolMock = vi.fn();
	const sendMessageMock = vi.fn();

	const pi = {
		appendEntry: appendEntryMock,
		registerTool: registerToolMock,
		sendMessage: sendMessageMock,
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
			if (event === "session_start") handlers.sessionStart = handler;
			if (event === "session_shutdown") handlers.sessionShutdown = handler;
		}),
		events: {
			emit: vi.fn(),
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				if (channel === "pending:register") handlers.pendingRegister = handler;
				if (channel === "pending:unregister") handlers.pendingUnregister = handler;
			}),
		},
	} as unknown as ExtensionAPI;

	return { pi, handlers, appendEntryMock, registerToolMock, sendMessageMock };
}

function createMockCtx(entries: MockSessionEntry[], sessionId = "sess-current"): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries as unknown[],
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
}

function fireSessionStart(setup: MockSetup, ctx: ExtensionContext): void {
	if (!setup.handlers.sessionStart) throw new Error("session_start handler not registered");
	void setup.handlers.sessionStart({ type: "session_start", reason: "resume" }, ctx);
}

async function runTool(
	setup: MockSetup,
	params: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
	const tool = setup.registerToolMock.mock.calls[0][0] as {
		execute: (
			toolCallId: string,
			p: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	};
	return tool.execute("test-call-id", params, undefined, undefined, createMockCtx([]));
}

async function getCount(setup: MockSetup): Promise<number> {
	const res = await runTool(setup, { action: "count" });
	return Number(res.content[0].text.replace(/[^0-9]/g, ""));
}

// ── 共享 fixtures ───────────────────────────────────

const NOW = 1_700_000_000_000;

function makeRegisterEntry(id: string, extra: Partial<PendingEntry> = {}): MockSessionEntry {
	return {
		customType: "pending:register",
		data: {
			id,
			type: "workflow",
			name: `op-${id}`,
			registeredAt: NOW,
			expiresAt: NOW + 3_600_000,
			sessionId: "sess-current",
			...extra,
		},
	};
}

function makeUnregisterEntry(id: string): MockSessionEntry {
	return { customType: "pending:unregister", data: { id } };
}

function rebuild(
	entries: MockSessionEntry[],
	currentSessionId: string,
	now: number,
): { activeIds: string[]; expiredToFlush: Array<{ id: string; status: string }> } {
	return rebuildFromEntries(createRegistry(), entries as unknown[], currentSessionId, now);
}

// ────────────────────────────────────────────────────
// state.ts 纯函数测试
// ────────────────────────────────────────────────────

describe("state pure functions", () => {
	describe("register", () => {
		it("registers a new active operation", () => {
			const r = createRegistry();
			const op: PendingEntry = {
				id: "w-1", type: "workflow", name: "test", status: "active",
				registeredAt: NOW, expiresAt: NOW + 3_600_000, sessionId: "s",
			};
			register(r, op);
			expect(getActive(r).map((o) => o.id)).toEqual(["w-1"]);
		});

		it("ignores duplicate active id (U6)", () => {
			const r = createRegistry();
			const op: PendingEntry = {
				id: "w-1", type: "workflow", name: "test", status: "active",
				registeredAt: NOW, expiresAt: NOW + 3_600_000, sessionId: "s",
			};
			register(r, op);
			register(r, { ...op, name: "dup" });
			expect(getActive(r)).toHaveLength(1);
			expect(getActive(r)[0].name).toBe("test");
		});
	});

	describe("unregister", () => {
		it("marks existing op non-active (U7)", () => {
			const r = createRegistry();
			register(r, {
				id: "w-1", type: "workflow", name: "test", status: "active",
				registeredAt: NOW, expiresAt: NOW + 3_600_000, sessionId: "s",
			});
			unregister(r, "w-1", "completed");
			expect(getActive(r)).toHaveLength(0);
		});

		it("ignores unknown id without error (U8)", () => {
			const r = createRegistry();
			expect(() => unregister(r, "nope", "completed")).not.toThrow();
		});
	});

	describe("rebuildFromEntries", () => {
		it("U1: register without unregister → 1 active", () => {
			const comp = rebuild([makeRegisterEntry("w-1")], "sess-current", NOW);
			expect(comp.activeIds).toEqual(["w-1"]);
			expect(comp.expiredToFlush).toEqual([]);
		});

		it("U2: register + matching unregister → 0 active", () => {
			const comp = rebuild([makeRegisterEntry("w-1"), makeUnregisterEntry("w-1")], "sess-current", NOW);
			expect(comp.activeIds).toEqual([]);
			expect(comp.expiredToFlush).toEqual([]);
		});

		it("[W4 翻档] U3 机器对现存类型不可达：workflow（process 档）超 TTL → 仍 active、无 flush", () => {
			// 翻档后三类型全 process 档：expiresAt 判定短路（isExpiredEntry 恒 false）。
			// 旧行为（session 档 1h TTL 过期 → flush expired unregister）已被移除——
			// 长任务注册不再被 TTL 静默清除（事故环 4 放大器），收口归注销发射点枚举 +
			// core 注册对账 sweep。
			const comp = rebuild(
				[makeRegisterEntry("w-1", { expiresAt: NOW - 1 })],
				"sess-current",
				NOW,
			);
			expect(comp.activeIds).toEqual(["w-1"]);
			expect(comp.expiredToFlush).toEqual([]);
		});

		it("[W4 读侧过滤③] U4 跨 session 残留 → 不入 registry、不补注销（读侧过滤替代 U4 中性化）", () => {
			// 翻档后 fork 继承的父级注册残留由 rebuild 读侧过滤兜住（≠ 当前 session →
			// 跳过），残留 entry 留在 session 文件（差集消费方各自过滤），落盘收口归
			// core 注册对账 sweep——不再补 expired unregister。
			const comp = rebuild(
				[makeRegisterEntry("w-1", { sessionId: "sess-other" })],
				"sess-current",
				NOW,
			);
			expect(comp.activeIds).toEqual([]);
			expect(comp.expiredToFlush).toEqual([]);
		});

		it("entries 含 null/undefined 元素 → 跳过不抛 TypeError（S-10）", () => {
			const comp = rebuildFromEntries(
				createRegistry(),
				[null, makeRegisterEntry("w-1"), undefined],
				"sess-current",
				NOW,
			);
			expect(comp.activeIds).toEqual(["w-1"]);
			expect(comp.expiredToFlush).toEqual([]);
		});
	});

	describe("normalizeRegisterEntry defaults (via rebuild)", () => {
		it("[W4 翻档] entry with only {id} → type=workflow（process 档）, name=id, sessionId=current, expiresAt=undefined", () => {
			const r = createRegistry();
			const result = rebuildFromEntries(
				r,
				[{ customType: "pending:register", data: { id: "w-min" } }],
				"sess-current",
				Date.now(),
			);
			expect(result.activeIds).toEqual(["w-min"]);
			const entry = r.operations.get("w-min")!;
			expect(entry.type).toBe("workflow");
			expect(entry.name).toBe("w-min");
			expect(entry.sessionId).toBe("sess-current");
			expect(entry.status).toBe("active");
			// 翻档后 workflow = process 档：无 TTL（normalizePendingType 默认归 workflow
			// 的偏好 = 缺失/未知 type 宁挂账不失明，清理通道 = core 对账 sweep）。
			expect(entry.expiresAt).toBeUndefined();
		});
	});
});

// ────────────────────────────────────────────────────
// index.ts 工厂集成测试（U1-U11）
// ────────────────────────────────────────────────────

describe("pendingNotificationsExtension factory", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setup = createMockPi();
		pendingNotificationsExtension(setup.pi);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("session_start rebuild (U1-U4)", () => {
		it("U1: 1 register no unregister → 1 active, no flush", async () => {
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1")]));
			expect(await getCount(setup)).toBe(1);
			const stateChangeCalls = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:register" || c[0] === "pending:unregister",
			);
			expect(stateChangeCalls).toHaveLength(0);
		});

		it("U2: register + unregister → 0 active", async () => {
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1"), makeUnregisterEntry("w-1")]));
			expect(await getCount(setup)).toBe(0);
		});

		it("[W4 翻档] expired register（process 档）→ 仍 active、不补 unregister entry", async () => {
			vi.setSystemTime(NOW + 3_700_000);
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1", { expiresAt: NOW })]));
			expect(await getCount(setup)).toBe(1);
			expect(setup.appendEntryMock).not.toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1" }),
			);
		});

		it("[W4 读侧过滤③] different sessionId → 不入 registry（active=0）、不补 unregister entry", async () => {
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1", { sessionId: "sess-old" })], "sess-current"));
			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).not.toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1" }),
			);
		});
	});

	describe("events.on pending:register (U5-U6)", () => {
		it("U5: register event → active + appendEntry", async () => {
			fireSessionStart(setup, createMockCtx([]));

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" });

			expect(await getCount(setup)).toBe(1);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:register",
				expect.objectContaining({ id: "w-1", type: "workflow", name: "test" }),
			);
		});

		it("U6: duplicate register event → ignored", async () => {
			fireSessionStart(setup, createMockCtx([]));

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "first" });
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "second" });

			expect(await getCount(setup)).toBe(1);
			const registerCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:register");
			expect(registerCalls).toHaveLength(1);
		});
	});

	describe("events.on pending:unregister (U7-U8)", () => {
		it("U7: unregister event → non-active + appendEntry", async () => {
			fireSessionStart(setup, createMockCtx([]));

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" });
			setup.appendEntryMock.mockClear();
			setup.handlers.pendingUnregister!({ id: "w-1", reason: "completed" });

			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1", reason: "completed" }),
			);
		});

		it("U8: unregister unknown id → ignored, no appendEntry, no throw", () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingUnregister!({ id: "nope", reason: "completed" })).not.toThrow();
			const stateChangeCalls = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:register" || c[0] === "pending:unregister",
			);
			expect(stateChangeCalls).toHaveLength(0);
		});
	});

	describe("tool count/list (U9-U10)", () => {
		it("U9: count returns active count", async () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });

			const res = await runTool(setup, { action: "count" });
			expect(res.content[0].text).toContain("1");
		});

		it("U10: list returns active list", async () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });
			setup.handlers.pendingRegister!({ id: "s-1", type: "subagent", name: "b" });

			const res = await runTool(setup, { action: "list" });
			const ids = (res.details as { items: PendingEntry[] }).items.map((i) => i.id);
			expect(ids.sort()).toEqual(["s-1", "w-1"]);
		});
	});

	describe("session_shutdown (U11)", () => {
		it("[W4 翻档] U11 对全部现存类型（process 档）不再发生：shutdown 不标 cancelled、不补 unregister", async () => {
			// process 档语义跨 shutdown 存活：任务收尾归任务自身/reaper/监督器，不由
			// session 退出裁定（设计 D4 连带面 3 显式接受）；清理痕迹由 core 注册对账
			// sweep 兜底。U11 机器留存待未来 session 档类型，勿误认清理仍在工作。
			fireSessionStart(setup, createMockCtx([]));
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });
			setup.handlers.pendingRegister!({ id: "s-1", type: "subagent", name: "b" });
			setup.appendEntryMock.mockClear();

			if (!setup.handlers.sessionShutdown) throw new Error("session_shutdown not registered");
			void setup.handlers.sessionShutdown({ type: "session_shutdown" }, createMockCtx([]));

			const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
			expect(unregisterCalls).toHaveLength(0);
			expect(await getCount(setup)).toBe(2);
		});
	});


	describe("safeAppendEntry error handling", () => {
		it("appendEntry throwing (stale context) does not break register listener, registry still updated", async () => {
			// listener 先 register(registry) 更新内存，再 safeAppendEntry；appendEntry 抛错被 catch，registry 仍已更新
			fireSessionStart(setup, createMockCtx([]));
			setup.appendEntryMock.mockImplementationOnce(() => {
				throw new Error("stale context");
			});

			expect(() => setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" })).not.toThrow();

			expect(await getCount(setup)).toBe(1);
		});
	});

	describe("parse null/malformed events", () => {
		it("parseRegisterEvent: null and missing-id data → no throw, no register entry", () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingRegister!(null)).not.toThrow();
			expect(() => setup.handlers.pendingRegister!({ type: "workflow" })).not.toThrow();

			const registerCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:register");
			expect(registerCalls).toHaveLength(0);
		});

		it("parseUnregisterEvent: null and missing-id data → no throw, no unregister entry", () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingUnregister!(null)).not.toThrow();
			expect(() => setup.handlers.pendingUnregister!({ reason: "completed" })).not.toThrow();

			const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
			expect(unregisterCalls).toHaveLength(0);
		});
	});
});

describe("countActiveFromEntries（纯差集，供 goal / subagent-workflow 复用）", () => {
	const mkRegister = (id: string, type: "subagent" | "workflow" = "subagent", overrides: Record<string, unknown> = {}) => ({
		type: "custom",
		customType: "pending:register",
		data: { id, type, name: id, registeredAt: 1000, expiresAt: 1000 + 3_600_000, sessionId: "s-1", ...overrides },
	});
	const mkUnregister = (id: string, reason = "completed") => ({
		type: "custom",
		customType: "pending:unregister",
		data: { id, reason },
	});

	it("空 entries → 0 活跃", () => {
		expect(countActiveFromEntries([])).toEqual({ count: 0, ids: [], entries: [] });
	});

	it("纯 register → count = register 数，返回完整 entry", () => {
		const res = countActiveFromEntries([mkRegister("bg-1"), mkRegister("bg-2", "workflow")]);
		expect(res.count).toBe(2);
		expect(res.ids).toEqual(["bg-1", "bg-2"]);
		expect(res.entries[0]).toMatchObject({ id: "bg-1", type: "subagent" });
	});

	it("register + unregister 同 id → 差集抵消", () => {
		expect(countActiveFromEntries([mkRegister("bg-1"), mkUnregister("bg-1")]).count).toBe(0);
	});

	it("混合：部分注销 → 只统计仍活跃的", () => {
		const res = countActiveFromEntries([
			mkRegister("bg-1"),
			mkRegister("bg-2"),
			mkUnregister("bg-1"),
		]);
		expect(res.count).toBe(1);
		expect(res.ids).toEqual(["bg-2"]);
	});

	it("types 过滤：只统计指定类型的活跃 pending", () => {
		const entries = [mkRegister("bg-1", "subagent"), mkRegister("wf-1", "workflow")];
		expect(countActiveFromEntries(entries, { types: ["subagent"] }).ids).toEqual(["bg-1"]);
		expect(countActiveFromEntries(entries, { types: ["workflow"] }).ids).toEqual(["wf-1"]);
		expect(countActiveFromEntries(entries, { types: ["subagent", "workflow"] }).count).toBe(2);
	});

	it("TTL 过期仍判活跃（刻意不校验 expiresAt，对齐 goal continuation 守卫语义）", () => {
		const expired = mkRegister("bg-1", "subagent", { registeredAt: 0, expiresAt: 1 });
		expect(countActiveFromEntries([expired]).count).toBe(1);
	});

	it("同 id 重复 register → 只算一次", () => {
		expect(countActiveFromEntries([mkRegister("bg-1"), mkRegister("bg-1")]).count).toBe(1);
	});

	it("entries 含 null/undefined 元素 → 跳过不抛 TypeError（S-10）", () => {
		// S-10 回归：外部调用方可能传入含 null/undefined 的 entries（session 文件坏行/脏数据），
		// 遍历时访问 raw.customType 前必须守卫，否则 TypeError 炸掉整个差集判定。
		const withNulls = [null, undefined, mkRegister("bg-1"), mkUnregister("bg-1"), null];
		expect(countActiveFromEntries(withNulls).count).toBe(0);
		const mixed = [undefined, null, mkRegister("bg-2")];
		expect(countActiveFromEntries(mixed).ids).toEqual(["bg-2"]);
		// register 循环同样守卫：unregister 遍历前的 null 不污染差集
		expect(countActiveFromEntries([null, undefined]).count).toBe(0);
	});

	it("malformed register（id 非 string）→ 跳过", () => {
		const bad = { type: "custom", customType: "pending:register", data: { id: 42 } };
		const good = mkRegister("bg-1");
		expect(countActiveFromEntries([bad, good]).ids).toEqual(["bg-1"]);
	});

	it("跨 session 残留（fork 继承的 register）缺省不校验 sessionId——传入 currentSessionId 时按 [W4 读侧过滤①] 跳过", () => {
		// 差集口向后兼容：不传 currentSessionId = 不过滤（既有调用方零改动）。
		// 模拟 P fork 主 session：继承来主 session 的 register（sessionId=s-0），已被 rebuild 补 unregister(expired)
		const inherited = mkRegister("parent-bg", "subagent", { sessionId: "s-0" });
		const flushed = mkUnregister("parent-bg", "expired");
		const own = mkRegister("my-bg");
		expect(countActiveFromEntries([inherited, flushed, own]).ids).toEqual(["my-bg"]);
	});

	it("[W4 读侧过滤①] currentSessionId 过滤：跨 session entry 跳过、本 session 计入", () => {
		const inherited = mkRegister("parent-bg", "subagent", { sessionId: "s-0" });
		const own = mkRegister("my-bg", "subagent", { sessionId: "s-1" });
		const bashOwn = mkRegister("bt-1", "bash", { sessionId: "s-1" });
		expect(
			countActiveFromEntries([inherited, own, bashOwn], { currentSessionId: "s-1" }).ids,
		).toEqual(["my-bg", "bt-1"]);
		// 同一输入不传基准 → 全量计入（向后兼容面不变）
		expect(countActiveFromEntries([inherited, own, bashOwn]).count).toBe(3);
	});

	it("[W4 读侧过滤①] entry 缺 sessionId 的旧形态条目视为本 session（不过滤，宁放行不误杀）", () => {
		const legacy = { type: "custom", customType: "pending:register", data: { id: "old-1", type: "subagent", name: "o" } };
		expect(
			countActiveFromEntries([legacy], { currentSessionId: "s-1" }).ids,
		).toEqual(["old-1"]);
	});
});

// ────────────────────────────────────────────────────
// D16 lifecycle 分档（M3）：process 档（type=bash）纯函数行为
// ────────────────────────────────────────────────────

/** bash register entry 的真实落盘形状：无 expiresAt 键（写入侧省略，D16） */
function makeBashRegisterEntry(id: string, overrides: Record<string, unknown> = {}): MockSessionEntry {
	return {
		customType: "pending:register",
		data: {
			id,
			type: "bash",
			name: `task-${id}`,
			registeredAt: NOW,
			sessionId: "sess-current",
			...overrides,
		},
	};
}

describe("D16 lifecycle 分档：常量与 type 归一化", () => {
	it("[W4 翻档] PENDING_LIFECYCLE：subagent/workflow/bash 全 process 档（session 档机器留存待未来类型）", () => {
		expect(PENDING_LIFECYCLE).toEqual({
			subagent: "process",
			workflow: "process",
			bash: "process",
		});
	});

	it("normalizePendingType：subagent/bash 直通，其余（缺失/未知/大小写不符）归 workflow", () => {
		expect(normalizePendingType("subagent")).toBe("subagent");
		expect(normalizePendingType("bash")).toBe("bash");
		expect(normalizePendingType("workflow")).toBe("workflow");
		expect(normalizePendingType(undefined)).toBe("workflow");
		expect(normalizePendingType("scheduler")).toBe("workflow");
		expect(normalizePendingType("Bash")).toBe("workflow");
	});
});

describe("D16 process 档（type=bash）纯函数行为", () => {
	it("读取侧不回填 TTL：无 expiresAt 的 bash entry → registry entry.expiresAt=undefined 且 active", () => {
		const r = createRegistry();
		const result = rebuildFromEntries(r, [makeBashRegisterEntry("bt-1")], "sess-current", NOW);
		expect(result.activeIds).toEqual(["bt-1"]);
		expect(result.expiredToFlush).toEqual([]);
		expect(r.operations.get("bt-1")!.expiresAt).toBeUndefined();
	});

	it("U3 不判过期：bash entry 注册超 1h（TTL 之外）→ 仍 active、无 expiredToFlush", () => {
		const entry = makeBashRegisterEntry("bt-1", { registeredAt: NOW - 3_700_000 });
		const comp = rebuild([entry], "sess-current", NOW);
		expect(comp.activeIds).toEqual(["bt-1"]);
		expect(comp.expiredToFlush).toEqual([]);
	});

	it("[W4 读侧过滤③] U4 跨 session 残留（含 bash）→ 不入 registry（读侧过滤一刀对全部类型生效）", () => {
		// 读侧过滤③不分类型：跨 session 残留在 rebuild 入口即被跳过（W6 的 bash 跨
		// session 可见性断言钉成的显式选择——子 session goal 不再为父 session bash
		// 任务 defer）。残留 entry 的落盘收口归 core 注册对账 sweep。
		const comp = rebuild(
			[makeBashRegisterEntry("bt-1", { sessionId: "sess-other" })],
			"sess-current",
			NOW,
		);
		expect(comp.activeIds).toEqual([]);
		expect(comp.expiredToFlush).toEqual([]);
	});

	it("[W4 翻档] 同形状（无 expiresAt 键）的 workflow entry → 不回填 TTL、照常 active（process 档）", () => {
		// 翻档后 workflow = process 档：读取侧不回填 TTL（normalizeRegisterEntry 对
		// process 档恒 undefined），注册不再被 1h TTL 静默清除（守卫不失明）。
		const legacy = {
			customType: "pending:register",
			data: { id: "w-1", type: "workflow", name: "w", registeredAt: NOW - 3_700_000, sessionId: "sess-current" },
		};
		const comp = rebuild([legacy], "sess-current", NOW);
		expect(comp.activeIds).toEqual(["w-1"]);
		expect(comp.expiredToFlush).toEqual([]);
	});

	it("差集路径识别 bash entry：register 计入且 type 保留，unregister 抵消", () => {
		const bashReg = makeBashRegisterEntry("bt-1");
		const res = countActiveFromEntries([bashReg] as unknown[]);
		expect(res.count).toBe(1);
		expect(res.entries[0].type).toBe("bash");
		expect(res.entries[0].expiresAt).toBeUndefined();

		expect(
			countActiveFromEntries([bashReg, makeUnregisterEntry("bt-1")] as unknown[]).count,
		).toBe(0);
	});

	it("types 过滤：bash 可作为过滤类型", () => {
		const entries = [makeBashRegisterEntry("bt-1"), makeRegisterEntry("w-1")] as unknown[];
		expect(countActiveFromEntries(entries, { types: ["bash"] }).ids).toEqual(["bt-1"]);
		expect(countActiveFromEntries(entries, { types: ["workflow"] }).ids).toEqual(["w-1"]);
	});
});

// ────────────────────────────────────────────────────
// D16 lifecycle 分档（M3）：process 档（type=bash）工厂行为
// ────────────────────────────────────────────────────

describe("D16 process 档（type=bash）工厂行为", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setup = createMockPi();
		pendingNotificationsExtension(setup.pi);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("register 写入：bash → 落盘 data 无 expiresAt 键且 type=bash 直通（不被归并为 workflow）", async () => {
		fireSessionStart(setup, createMockCtx([]));

		setup.handlers.pendingRegister!({ id: "bt-1", type: "bash", name: "run tests" });

		expect(await getCount(setup)).toBe(1);
		const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
		expect(regCall).toBeDefined();
		const data = regCall![1] as Record<string, unknown>;
		expect(data.type).toBe("bash");
		expect("expiresAt" in data).toBe(false);
	});

	it("[W4 翻档] workflow register → 落盘 data 无 expiresAt 键（process 档写入侧豁免）", async () => {
		fireSessionStart(setup, createMockCtx([]));

		setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "run" });

		const regCall = setup.appendEntryMock.mock.calls.find((c) => c[0] === "pending:register");
		const data = regCall![1] as Record<string, unknown>;
		expect("expiresAt" in data).toBe(false);
	});

	it("U3 工厂级：bash entry 超 1h 后 session_start rebuild → 仍 active、不补 unregister", async () => {
		vi.setSystemTime(NOW + 3_700_000);
		const stale = makeBashRegisterEntry("bt-1", { registeredAt: NOW });
		fireSessionStart(setup, createMockCtx([stale]));

		expect(await getCount(setup)).toBe(1);
		const flushCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
		expect(flushCalls).toHaveLength(0);
	});

	it("[W4 翻档] session_shutdown：bash 与 workflow（全 process 档）都不标 cancelled、内存仍 active", async () => {
		fireSessionStart(setup, createMockCtx([]));
		setup.handlers.pendingRegister!({ id: "bt-1", type: "bash", name: "run tests" });
		setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "run" });
		setup.appendEntryMock.mockClear();

		if (!setup.handlers.sessionShutdown) throw new Error("session_shutdown not registered");
		void setup.handlers.sessionShutdown({ type: "session_shutdown" }, createMockCtx([]));

		const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
		expect(unregisterCalls).toHaveLength(0);
		expect(await getCount(setup)).toBe(2);
	});

	it("[W4 读侧过滤③ 投影] fork 继承残留不入 registry：session 替换后 pending_notifications 工具不虚报跨 session 活跃", async () => {
		// A9② 场景：父 session（sess-parent）注册 bg-parent → fork 出子 session
		//（sess-child，继承父 entries）→ 子 session_start rebuild 按 sessionId 过滤
		// 残留 → 工具 count/list 只见子 session 自己的注册。
		const parentEntries = [
			{ customType: "pending:register", data: { id: "bg-parent", type: "subagent", name: "p", registeredAt: NOW, sessionId: "sess-parent" } },
		];
		fireSessionStart(setup, createMockCtx(parentEntries, "sess-child"));
		// 子 session 自己的新注册（listener 写入，sessionId=sess-child）
		setup.handlers.pendingRegister!({ id: "bg-own", type: "subagent", name: "own" });

		expect(await getCount(setup)).toBe(1);
		const res = await runTool(setup, { action: "list" });
		const ids = (res.details as { items: PendingEntry[] }).items.map((i) => i.id);
		expect(ids).toEqual(["bg-own"]);
	});
});
