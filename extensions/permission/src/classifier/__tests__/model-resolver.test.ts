/**
 * MRT 系列：model-resolver.ts 单元测试（picker 相关 API）。
 *
 * P3 收口后 classifier 不再用本模块（改走 llm-shared resolveModel + ctx.modelRegistry）。
 * resolveClassifierModel / findCheapestModel 已废弃删除。本测试仅覆盖 picker 所需的：
 *  - loadModelsJson（文件缺失返回 null + onWarning）
 *  - flattenModels（拍平 + hasApiKey 推断）
 *
 * 用真实 fs + 临时目录（不用 mock fs），与 config.test.ts 风格一致。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { flattenModels, loadModelsJson } from "../model-resolver.js";

let tempDir: string;
let modelsJsonPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-perm-mr-"));
	modelsJsonPath = join(tempDir, "models.json");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const MODELS_JSON = {
	providers: {
		"cheap-co": {
			baseUrl: "http://x",
			apiKey: "k1",
			api: "openai-completions",
			models: [
				{ id: "mini", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
				{ id: "big", cost: { input: 1.0, output: 1.0, cacheRead: 0, cacheWrite: 0 } },
			],
		},
		"noauth-co": {
			baseUrl: "http://y",
			// 无 apiKey
			api: "openai-completions",
			models: [{ id: "ultra-cheap", cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		},
		"noapi-co": {
			baseUrl: "http://z",
			apiKey: "k3",
			// 无 api
			models: [{ id: "ghost", cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		},
	},
};

function writeModels(data: unknown): void {
	writeFileSync(modelsJsonPath, JSON.stringify(data), "utf-8");
}

describe("MRT1: loadModelsJson", () => {
	it("文件不存在 → null（不抛错）", () => {
		expect(existsSync(modelsJsonPath)).toBe(false);
		expect(loadModelsJson(undefined, modelsJsonPath)).toBeNull();
	});

	it("合法 JSON → 返回解析对象", () => {
		writeModels(MODELS_JSON);
		const data = loadModelsJson(undefined, modelsJsonPath);
		expect(data?.providers).toBeDefined();
	});

	it("损坏 JSON → null + onWarning 被调用", () => {
		writeFileSync(modelsJsonPath, "{ broken json", "utf-8");
		const warnings: string[] = [];
		const data = loadModelsJson((m) => warnings.push(m), modelsJsonPath);
		expect(data).toBeNull();
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("models.json");
	});
});

describe("MRT2: flattenModels", () => {
	it("拍平所有 provider.model，过滤无 api 的 model", () => {
		const entries = flattenModels(MODELS_JSON);
		const ids = entries.map((e) => e.id).sort();
		// noapi-co/ghost 无 api → 过滤；其余保留
		expect(ids).toEqual(["big", "mini", "ultra-cheap"]);
	});

	it("hasApiKey 从 provider.apiKey 推断", () => {
		const entries = flattenModels(MODELS_JSON);
		const cheap = entries.find((e) => e.id === "mini");
		const noauth = entries.find((e) => e.id === "ultra-cheap");
		expect(cheap?.hasApiKey).toBe(true);
		expect(noauth?.hasApiKey).toBe(false);
	});

	it("apiKey 值从 provider.apiKey 透传（MRT2 补充：不只断言 hasApiKey 布尔）", () => {
		const entries = flattenModels(MODELS_JSON);
		const cheap = entries.find((e) => e.id === "mini");
		const noauth = entries.find((e) => e.id === "ultra-cheap");
		// 有 apiKey 的 provider：apiKey 字段透传真实值（"k1"）
		expect(cheap?.apiKey).toBe("k1");
		// 无 apiKey 的 provider：apiKey 字段为 undefined（而非空串）
		expect(noauth?.apiKey).toBeUndefined();
		// 同 provider 下所有 model 共享 provider.apiKey
		const big = entries.find((e) => e.id === "big");
		expect(big?.apiKey).toBe("k1");
	});
});
