// src/__tests__/maintenance-once.test.ts —— M5 幂等止血（实施单元 u-bte-guard，
// 设计 docs/design/file-lock-unification-and-reaper-sink.md §3.2 D3「守卫粒度」/
// §4 S6 内联版）：
//  - 同一进程内 session_start 双派发（pi factory 二调 handler 累积 + startup/resume
//    双发的真实形态）→ reapOrphanedTasks 仅首个派发执行（进程级 once flag）
//  - reconcilePendingEntries 是 session 级豁免类，不挂 flag，每次派发都执行
//  - 入口无条件 debug 日志按派发次数出现，含 reason 与 reapSkipped（S6 观测通道）
// 断言方式：reaper / reconcile / logger 全部间谍注入，观察调用次数与参数；
// once flag 是 index.ts 模块级状态，用 vi.resetModules + 动态 import 每用例重置。
import { describe, expect, it, vi, beforeEach } from "vitest";

const { reapOrphanedTasksMock, reconcileMock, loggerMock, officialBashFactoryMock, dataDirRef } =
	vi.hoisted(() => ({
		reapOrphanedTasksMock: vi.fn(),
		reconcileMock: vi.fn(),
		loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		officialBashFactoryMock: vi.fn(),
		dataDirRef: { dir: "/tmp/bte-fake-agent-dir" },
	}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: officialBashFactoryMock,
	getAgentDir: () => dataDirRef.dir,
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));
vi.mock("../reaper.ts", () => ({
	reapOrphanedTasks: reapOrphanedTasksMock,
}));
vi.mock("../background/pending-reconcile.ts", () => ({
	reconcilePendingEntries: reconcileMock,
}));

import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";

/** 重新解析 index.ts 模块图——模块级 once flag 随之归零。 */
async function loadExtensionWithFreshFlag() {
	vi.resetModules();
	return import("../index.ts");
}

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

beforeEach(() => {
	reapOrphanedTasksMock.mockReset();
	reapOrphanedTasksMock.mockResolvedValue(undefined);
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
	loggerMock.debug.mockClear();
	loggerMock.warn.mockClear();
	loggerMock.error.mockClear();
});

describe("session_start maintenance once-per-process guard (u-bte-guard)", () => {
	it("runs reapOrphanedTasks only on the first dispatch; reconcilePendingEntries on every dispatch", async () => {
		const mod = await loadExtensionWithFreshFlag();
		const pi = createMockPi();
		mod.default(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);
		const ctx = makeCtx();

		// 首个派发（startup）：reap 执行一次
		handler(makeEvent("startup"), ctx);
		await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1));
		expect(reapOrphanedTasksMock).toHaveBeenCalledTimes(1);
		expect(reapOrphanedTasksMock).toHaveBeenCalledWith(dataDirRef.dir);

		// 后续派发（resume / new）：reap 被 once flag 跳过，对账照常执行。
		// resume 双发是事故场景本体——factory 二调下同一事件被两组 handler 各跑一次
		handler(makeEvent("resume"), ctx);
		await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2));
		handler(makeEvent("new"), ctx);
		await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(3));

		expect(reapOrphanedTasksMock).toHaveBeenCalledTimes(1);
		expect(reconcileMock).toHaveBeenCalledTimes(3);
		expect(loggerMock.warn).not.toHaveBeenCalled();
	});

	it("emits the unconditional entry debug log per dispatch with reason and reapSkipped (S6 observation channel)", async () => {
		const mod = await loadExtensionWithFreshFlag();
		const pi = createMockPi();
		mod.default(pi as unknown as ExtensionAPI);
		const handler = getSessionStartHandler(pi);
		const ctx = makeCtx();

		handler(makeEvent("startup"), ctx);
		await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(1));
		handler(makeEvent("resume"), ctx);
		await vi.waitFor(() => expect(reconcileMock).toHaveBeenCalledTimes(2));

		// 每次派发恰好一条入口日志（无条件 = 不以任何条件短路），reason 取自事件，
		// reapSkipped 反映 once flag 状态：首个派发 false（将执行），其后 true（跳过）
		expect(loggerMock.debug).toHaveBeenCalledTimes(2);
		expect(loggerMock.debug).toHaveBeenNthCalledWith(1, "session_start maintenance dispatch", {
			detail: { reason: "startup", reapSkipped: false },
		});
		expect(loggerMock.debug).toHaveBeenNthCalledWith(2, "session_start maintenance dispatch", {
			detail: { reason: "resume", reapSkipped: true },
		});
	});
});
