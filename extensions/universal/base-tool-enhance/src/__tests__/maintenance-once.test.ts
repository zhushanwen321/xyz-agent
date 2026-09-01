// src/__tests__/maintenance-once.test.ts —— 收殓下沉后的 session_start 维护链
// 语义（实施单元 u-bte-remove，设计 docs/design/file-lock-unification-and-reaper-
// sink.md §3.2 D2「extension 删 session_start reaper」/ §3.3 D3 粒度段 / §4 S6
// 「批 2 后 reap 类操作不再执行」）：
//  - reconcilePendingEntries 是 session 级豁免类，每 session_start 派发都执行
//    （startup/resume/new 多派发 ×N——含 factory 二调 handler 累积的真实形态）
//  - 触发面消失：reaper.ts 已删除（import 即失败）+ 维护链不再触发全局文件锁
//    （withFileLock——原 reapOrphanedTasks 的 reaper.lock 路径）
//  - 入口无条件 debug 日志按派发次数出现，detail 仅含 reason（reapSkipped 字段
//    随 reap 调用移除，S6 观测通道语义更新）
// 断言方式：reconcile / logger / file-lock 全部间谍注入，观察调用次数与参数。
import { describe, expect, it, vi, beforeEach } from "vitest";

const { reconcileMock, loggerMock, officialBashFactoryMock, dataDirRef, withFileLockMock } =
	vi.hoisted(() => ({
		reconcileMock: vi.fn(),
		loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		officialBashFactoryMock: vi.fn(),
		dataDirRef: { dir: "/tmp/bte-fake-agent-dir" },
		withFileLockMock: vi.fn(),
	}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: officialBashFactoryMock,
	getAgentDir: () => dataDirRef.dir,
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));
// 全局扫描探针：withFileLock 是原 reapOrphanedTasks 持 reaper.lock 的唯一锁路径
// （registry 写走的是 withFileLockSync）——维护链触发它 = 全局扫描回流
vi.mock("@zhushanwen/pi-file-lock", () => ({
	withFileLock: withFileLockMock,
	withFileLockSync: vi.fn(() => {
		throw new Error("unexpected registry write in maintenance chain");
	}),
}));
vi.mock("../background/pending-reconcile.ts", () => ({
	reconcilePendingEntries: reconcileMock,
}));

import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";

function createMockPi() {
	return {
		registerTool: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
		sendMessage: vi.fn(),
	};
}

function getSessionStartHandler(pi: ReturnType<typeof createMockPi>) {
	const handler = pi.on.mock.calls.find((call) => call[0] === "session_start")?.[1];
	expect(handler).toBeTypeOf("function");
	return handler as (event: SessionStartEvent, ctx: unknown) => void;
}

function makeEvent(reason: SessionStartEvent["reason"]): SessionStartEvent {
	return { type: "session_start", reason };
}

function makeCtx() {
	return {
		sessionManager: { getSessionId: () => "sid-once", getEntries: () => [] },
	};
}

async function loadExtension() {
	return import("../index.ts");
}

beforeEach(() => {
	reconcileMock.mockReset();
	// 官方 bash 工厂返回最小工具定义（override 定义 spread initial.name）
	officialBashFactoryMock.mockReset();
	officialBashFactoryMock.mockReturnValue({
		name: "bash",
		label: "bash",
		description: "official",
		parameters: {},
		execute: vi.fn(),
	});
	withFileLockMock.mockReset();
	loggerMock.debug.mockClear();
	loggerMock.warn.mockClear();
	loggerMock.error.mockClear();
});

describe("session_start maintenance chain after reap sink (u-bte-remove)", () => {
	it("no longer ships a reaper: the module is gone from the extension (trigger surface removed)", async () => {
		await expect(import("../reaper.ts")).rejects.toThrow();
	});

	it("runs reconcilePendingEntries on EVERY session_start dispatch (session-scoped exempt, D3)", async () => {
		const mod = await loadExtension();
		const pi = createMockPi();
		mod.default(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);
		const ctx = makeCtx();

		// 多派发覆盖真实形态：startup + resume 双发（桌面端每次激活）+ new；
		// factory 二调 handler 累积时同一事件被多组 handler 各跑一次，同理多次执行
		handler(makeEvent("startup"), ctx);
		handler(makeEvent("resume"), ctx);
		handler(makeEvent("new"), ctx);

		expect(reconcileMock).toHaveBeenCalledTimes(3);
		expect(reconcileMock).toHaveBeenNthCalledWith(1, expect.anything(), dataDirRef.dir, "sid-once", []);
		expect(reconcileMock).toHaveBeenLastCalledWith(expect.anything(), dataDirRef.dir, "sid-once", []);
		// 无全局扫描：维护链不触发原 reaper 的跨进程锁路径，也无告警
		expect(withFileLockMock).not.toHaveBeenCalled();
		expect(loggerMock.warn).not.toHaveBeenCalled();
	});

	it("emits the unconditional entry debug log per dispatch with reason only (S6 observation channel)", async () => {
		const mod = await loadExtension();
		const pi = createMockPi();
		mod.default(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);
		const ctx = makeCtx();

		handler(makeEvent("startup"), ctx);
		handler(makeEvent("resume"), ctx);

		// 每次派发恰好一条入口日志（无条件 = 不以任何条件短路），reason 取自事件；
		// reapSkipped 字段已随 reap 下沉移除（u-bte-remove 变更登记，S6「批 2 后
		// reap 类操作不再执行」）
		expect(loggerMock.debug).toHaveBeenCalledTimes(2);
		expect(loggerMock.debug).toHaveBeenNthCalledWith(1, "session_start maintenance dispatch", {
			detail: { reason: "startup" },
		});
		expect(loggerMock.debug).toHaveBeenNthCalledWith(2, "session_start maintenance dispatch", {
			detail: { reason: "resume" },
		});
	});

	it("keeps reconcile failures non-fatal: warn logged, dispatch chain not throwing", async () => {
		reconcileMock.mockImplementation(() => {
			throw new Error("reconcile boom");
		});
		const mod = await loadExtension();
		const pi = createMockPi();
		mod.default(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);

		// 对账抛错被维护链吞掉记 warn（僵尸停留差集，下一 session_start 幂等重查）
		expect(() => handler(makeEvent("resume"), makeCtx())).not.toThrow();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"session_start pending reconcile failed; zombies retried next session start",
			expect.objectContaining({ detail: expect.objectContaining({ err: "reconcile boom" }) }),
		);
	});
});
