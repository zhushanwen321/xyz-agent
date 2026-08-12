import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matchGlob, readEnabledModels, resolveModel } from "../resolve.ts";

function makeModel(provider: string, id: string): Model<Api> {
	return { id, provider, name: id, api: "anthropic" as Api, baseUrl: "", reasoning: false } as unknown as Model<Api>;
}

function makeCtx(all: Model<Api>[], hasAuth: (m: Model<Api>) => boolean): ExtensionContext {
	return {
		modelRegistry: {
			getAll: () => all,
			hasConfiguredAuth: hasAuth,
		},
	} as unknown as ExtensionContext;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "llm-shared-scoped-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("resolveModel scoped", () => {
	it("TC7 glob 匹配按 enabledModels 顺序取首个可用", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/*", "openai/gpt-4o"] }));
		const claude = makeModel("anthropic", "claude");
		const gpt = makeModel("openai", "gpt-4o");
		const gemini = makeModel("google", "gemini");
		const ctx = makeCtx([claude, gpt, gemini], () => true);

		// enabledModels 首个 pattern anthropic/* 命中 claude
		expect(resolveModel(ctx, { type: "scoped" })).toBe(claude);
	});

	it("TC7 首个 pattern 无可用 model → 回退到下一个 pattern", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["google/*", "openai/gpt-4o"] }));
		const gpt = makeModel("openai", "gpt-4o");
		// getAll 不含 google，含 openai
		const ctx = makeCtx([gpt], () => true);
		expect(resolveModel(ctx, { type: "scoped" })).toBe(gpt);
	});

	it("review: scoped 同 pattern 多 model 命中序 —— 取 getAll() 遍历序首个", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/*"] }));
		const claude = makeModel("anthropic", "claude");
		const haiku = makeModel("anthropic", "haiku");

		// getAll 返回 [claude, haiku]，pattern anthropic/* 都匹配，取遍历序首个 claude
		const ctx1 = makeCtx([claude, haiku], () => true);
		expect(resolveModel(ctx1, { type: "scoped" })).toBe(claude);

		// 反序验证：取首个 haiku
		const ctx2 = makeCtx([haiku, claude], () => true);
		expect(resolveModel(ctx2, { type: "scoped" })).toBe(haiku);
	});

	it("TC8 enabledModels 缺失（无 settings.json）→ null（不抛错）", () => {
		const ctx = makeCtx([makeModel("a", "1")], () => true);
		expect(resolveModel(ctx, { type: "scoped" })).toBeNull();
	});

	it("TC8 settings.json 无 enabledModels 字段 → null", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ other: "field" }));
		const ctx = makeCtx([makeModel("a", "1")], () => true);
		expect(resolveModel(ctx, { type: "scoped" })).toBeNull();
	});

	it("TC8 enabledModels 空数组 → null", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: [] }));
		const ctx = makeCtx([makeModel("a", "1")], () => true);
		expect(resolveModel(ctx, { type: "scoped" })).toBeNull();
	});

	it("scoped glob 命中但全部无 auth → null", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["anthropic/*"] }));
		const claude = makeModel("anthropic", "claude");
		const ctx = makeCtx([claude], () => false);
		expect(resolveModel(ctx, { type: "scoped" })).toBeNull();
	});
});

describe("matchGlob", () => {
	it("TC9 * 通配 / 精确 / 多段匹配", () => {
		expect(matchGlob("*", "anything")).toBe(true);
		expect(matchGlob("*", "a/b/c")).toBe(true);
		expect(matchGlob("anthropic/*", "anthropic/claude")).toBe(true);
		expect(matchGlob("anthropic/*", "openai/gpt")).toBe(false);
		expect(matchGlob("openai/gpt-4o", "openai/gpt-4o")).toBe(true);
		// 精确匹配不含通配，后缀不同不匹配
		expect(matchGlob("openai/gpt-4o", "openai/gpt-4o-mini")).toBe(false);
		expect(matchGlob("*-router/*", "deepseek-router/deepseek-chat")).toBe(true);
		expect(matchGlob("*-router/*", "deepseek/deepseek-chat")).toBe(false);
	});

	it("TC9 特殊字符转义（pattern 含 . 等正则元字符，按字面匹配）", () => {
		// gpt-4o 中的 . 若不被转义会匹配任意字符；这里无 . 但有 -，- 在字符类外非特殊
		expect(matchGlob("v1.0/stable", "v1.0/stable")).toBe(true);
		expect(matchGlob("v1.0/stable", "v1X0/stable")).toBe(false); // . 被转义，不匹配任意字符
	});
});

describe("readEnabledModels", () => {
	it("TC10 解析 + 顺序保持（非字母序原样）", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["b/2", "a/1", "c/3"] }));
		expect(readEnabledModels()).toEqual(["b/2", "a/1", "c/3"]);
	});

	it("TC10 过滤非 string 元素", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: [1, "a/1", null, true, "b/2"] }));
		expect(readEnabledModels()).toEqual(["a/1", "b/2"]);
	});

	it("TC10 坏 JSON → []", () => {
		writeFileSync(join(dir, "settings.json"), "{not json");
		expect(readEnabledModels()).toEqual([]);
	});

	it("TC10 enabledModels 非数组 → []", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: "anthropic/*" }));
		expect(readEnabledModels()).toEqual([]);
	});

	it("TC10 顶层非对象 → []", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(["a/1"]));
		expect(readEnabledModels()).toEqual([]);
	});
});
