// src/__tests__/index.test.ts —— 入口集成：registerTool(bash 同名 override) + 审计 hook 挂载
import { describe, expect, it, vi } from "vitest";

const { createBashToolDefinitionMock } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import baseToolEnhanceExtension from "../index.ts";

function createMockPi() {
	return {
		registerTool: vi.fn(),
		on: vi.fn(),
		appendEntry: vi.fn(),
	};
}

describe("baseToolEnhanceExtension entry", () => {
	it("registers the bash override tool by name", () => {
		createBashToolDefinitionMock.mockReset();
		createBashToolDefinitionMock.mockReturnValue({
			name: "bash",
			label: "bash",
			description: "official",
			parameters: {},
			execute: vi.fn(),
		});
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		const tool = pi.registerTool.mock.calls[0][0] as { name: string };
		expect(tool.name).toBe("bash");
	});

	it("mounts the tool error audit hook", () => {
		createBashToolDefinitionMock.mockReset();
		createBashToolDefinitionMock.mockReturnValue({
			name: "bash",
			label: "bash",
			description: "official",
			parameters: {},
			execute: vi.fn(),
		});
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
	});
});
