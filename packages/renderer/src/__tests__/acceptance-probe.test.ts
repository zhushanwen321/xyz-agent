import { describe, expect, it, vi } from "vitest";

import { loadProbeConfig } from "../lib/acceptance-probe.js";

function rawReader(files: Record<string, string>) {
	return vi.fn(async (path: string) => {
		if (path in files) {
			return files[path];
		}
		throw new Error(`missing: ${path}`);
	});
}

describe("loadProbeConfig", () => {
	it("聚合两份配置", async () => {
		const readRaw = rawReader({
			"probe-locale.json": JSON.stringify({ locale: "zh" }),
			"probe-theme.json": JSON.stringify({ theme: "dark" }),
		});
		const config = await loadProbeConfig(readRaw);
		expect(config).toEqual({ locale: "zh", theme: "dark" });
		expect(readRaw).toHaveBeenCalledTimes(2);
	});

	it("字段缺失抛错", async () => {
		const readRaw = rawReader({
			"probe-locale.json": JSON.stringify({ other: "zh" }),
			"probe-theme.json": JSON.stringify({ theme: "dark" }),
		});
		await expect(loadProbeConfig(readRaw)).rejects.toThrow("missing field: locale");
	});

	it("非 JSON 内容抛错", async () => {
		const readRaw = rawReader({
			"probe-locale.json": "not-json",
			"probe-theme.json": JSON.stringify({ theme: "dark" }),
		});
		await expect(loadProbeConfig(readRaw)).rejects.toThrow();
	});
});
