// src/__tests__/tool-error-handler.test.ts
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { setupToolErrorHandler } from "../hooks/tool-error-handler.ts";

// 回归防护：源码已删泛化 logger.warn 双写（D5），若被重新引入测试必须红。
// mock 掉共享 logger，使 loggerMock.warn 可被断言未被调。
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

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

	it("appendEntry with dedicated customType on isError:true", async () => {
		const pi = createMockPi();
		pi.appendEntry.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await handler({ isError: true, toolName: "read", toolCallId: "call-42" });

		// 契约载体 = 专属 customType "unified-hooks:tool-error"
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		// 回归防护（D5）：泛化 logger.warn 双写不得回归
		expect(loggerMock.warn).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"unified-hooks:tool-error",
			expect.objectContaining({
				toolName: "read",
				toolCallId: "call-42",
				errorText: null,
			}),
		);
	});

	it("does nothing on isError:false (no appendEntry)", async () => {
		const pi = createMockPi();
		pi.appendEntry.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await handler({ isError: false, toolName: "bash", toolCallId: "call-99" });

		expect(pi.appendEntry).not.toHaveBeenCalled();
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
		pi.appendEntry.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await Promise.all([
			handler({ isError: true, toolName: "read", toolCallId: "e1" }),
			handler({ isError: true, toolName: "bash", toolCallId: "e2" }),
			handler({ isError: false, toolName: "edit", toolCallId: "e3" }),
		]);

		expect(pi.appendEntry).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"unified-hooks:tool-error",
			expect.objectContaining({ toolName: "read", toolCallId: "e1" }),
		);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"unified-hooks:tool-error",
			expect.objectContaining({ toolName: "bash", toolCallId: "e2" }),
		);
	});

	// --- errorText 提取（核心能力）---

	it("从 result.content[0].text 提取错误文本（如 'hub disposed'）", async () => {
		const pi = createMockPi();
		pi.appendEntry.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		await handler({
			isError: true,
			toolName: "subagent",
			toolCallId: "call-disposed",
			result: { content: [{ type: "text", text: "hub disposed" }] },
		});

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"unified-hooks:tool-error",
			expect.objectContaining({
				toolName: "subagent",
				toolCallId: "call-disposed",
				errorText: "hub disposed",
			}),
		);
	});

	it("result 缺失或无 content 时降级到无详情（不崩）", async () => {
		const pi = createMockPi();
		pi.appendEntry.mockClear();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown) => Promise<void>;

		// result 为 undefined（某些 headless 路径）
		await handler({ isError: true, toolName: "bash", toolCallId: "x1" });
		// result.content 为空数组
		await handler({ isError: true, toolName: "bash", toolCallId: "x2", result: { content: [] } });
		// result 不是对象
		await handler({ isError: true, toolName: "bash", toolCallId: "x3", result: "oops" });

		// 三次都降级为无详情
		expect(pi.appendEntry).toHaveBeenCalledTimes(3);
		expect(pi.appendEntry.mock.calls[0]![1]).toHaveProperty("errorText", null);
		expect(pi.appendEntry.mock.calls[1]![1]).toHaveProperty("errorText", null);
		expect(pi.appendEntry.mock.calls[2]![1]).toHaveProperty("errorText", null);
	});
});
