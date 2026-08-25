// src/__tests__/index.test.ts —— 入口集成：工具注册（bash / bash_output / bash_kill）+ 审计 hook 挂载
import { describe, expect, it, vi } from "vitest";

const { createBashToolDefinitionMock } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => "/tmp/bte-fake-agent-dir",
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

function setupOfficialFactory() {
	createBashToolDefinitionMock.mockReset();
	createBashToolDefinitionMock.mockReturnValue({
		name: "bash",
		label: "bash",
		description: "official",
		parameters: {},
		execute: vi.fn(),
	});
}

describe("baseToolEnhanceExtension entry", () => {
	it("registers bash (override), bash_output and bash_kill tools by name", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		const names = pi.registerTool.mock.calls.map((call) => (call[0] as { name: string }).name);
		expect(names).toEqual(["bash", "bash_output", "bash_kill"]);
	});

	it("mounts the tool error audit hook", () => {
		setupOfficialFactory();
		const pi = createMockPi();

		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
	});
});
