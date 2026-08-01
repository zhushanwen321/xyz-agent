// src/__tests__/tool-error-handler.test.ts
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock 共享 logger，让 logger.warn 可被 spy
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
}));

import { setupToolErrorHandler } from "../hooks/tool-error-handler.ts";

// --- helper types ---
interface MockPi {
	on: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(overrides?: Partial<MockPi>): MockPi {
	return {
		on: vi.fn(),
		appendEntry: vi.fn(),
		...overrides,
	};
}

describe("setupToolErrorHandler", () => {
	it("registers a handler on the tool_execution_end event", () => {
		const pi = createMockPi();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
	});

	it("logs via logger.warn (not ctx.ui.notify) on isError:true", async () => {
		const pi = createMockPi();
		loggerMock.warn.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await handler({ isError: true, toolName: "read", toolCallId: "call-42" });

		// logger.warn 被调一次（内部走 appendEntry，不在 handler 里直接调 pi.appendEntry）
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"[unified-hooks] read error (callId=call-42)",
			expect.objectContaining({
				toolName: "read",
				toolCallId: "call-42",
				errorText: null,
			}),
		);
	});

	it("does nothing on isError:false (no logger.warn)", async () => {
		const pi = createMockPi();
		loggerMock.warn.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await handler({ isError: false, toolName: "bash", toolCallId: "call-99" });

		expect(loggerMock.warn).not.toHaveBeenCalled();
	});

	// --- edge cases ---

	it("propagates if pi.on throws during registration", () => {
		const pi = createMockPi({
			on: vi.fn(() => { throw new Error("registration failed"); }),
		});

		expect(() => setupToolErrorHandler(pi as unknown as ExtensionAPI)).toThrow("registration failed");
	});

	it("handles concurrent error events independently", async () => {
		const pi = createMockPi();
		loggerMock.warn.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await Promise.all([
			handler({ isError: true, toolName: "read", toolCallId: "e1" }),
			handler({ isError: true, toolName: "bash", toolCallId: "e2" }),
			handler({ isError: false, toolName: "edit", toolCallId: "e3" }),
		]);

		expect(loggerMock.warn).toHaveBeenCalledTimes(2);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"[unified-hooks] read error (callId=e1)",
			expect.objectContaining({ toolName: "read", toolCallId: "e1" }),
		);
		expect(loggerMock.warn).toHaveBeenCalledWith(
			"[unified-hooks] bash error (callId=e2)",
			expect.objectContaining({ toolName: "bash", toolCallId: "e2" }),
		);
	});

	// --- errorText 提取（核心能力）---

	it("从 result.content[0].text 提取错误文本（如 'hub disposed'）", async () => {
		const pi = createMockPi();
		loggerMock.warn.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await handler({
			isError: true,
			toolName: "subagent",
			toolCallId: "call-disposed",
			result: { content: [{ type: "text", text: "hub disposed" }] },
		});

		expect(loggerMock.warn).toHaveBeenCalledWith(
			"[unified-hooks] subagent error (callId=call-disposed)",
			expect.objectContaining({
				toolName: "subagent",
				toolCallId: "call-disposed",
				errorText: "hub disposed",
			}),
		);
	});

	it("result 缺失或无 content 时降级到无详情（不崩）", async () => {
		const pi = createMockPi();
		loggerMock.warn.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		// result 为 undefined（某些 headless 路径）
		await handler({ isError: true, toolName: "bash", toolCallId: "x1" });
		// result.content 为空数组
		await handler({ isError: true, toolName: "bash", toolCallId: "x2", result: { content: [] } });
		// result 不是对象
		await handler({ isError: true, toolName: "bash", toolCallId: "x3", result: "oops" });

		// 三次都降级为无详情
		expect(loggerMock.warn.mock.calls[0]![0]).toBe("[unified-hooks] bash error (callId=x1)");
		expect(loggerMock.warn.mock.calls[0]![1]).toHaveProperty("errorText", null);
		expect(loggerMock.warn.mock.calls[1]![1]).toHaveProperty("errorText", null);
		expect(loggerMock.warn.mock.calls[2]![1]).toHaveProperty("errorText", null);
	});
});
