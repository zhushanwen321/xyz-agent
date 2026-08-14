import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { resolveModel } from "../resolve.ts";

/** 构造最小 Model（cast 绕过必填字段，单测只关心 provider/id）。 */
function makeModel(provider: string, id: string): Model<Api> {
	return { id, provider, name: id, api: "anthropic" as Api, baseUrl: "", reasoning: false } as unknown as Model<Api>;
}

/** 构造 mock ExtensionContext（只填 modelRegistry 的 resolveModel 依赖的方法）。 */
function makeCtx(registry: {
	find?: (provider: string, modelId: string) => Model<Api> | undefined;
	getAll?: () => Model<Api>[];
	getAvailable?: () => Model<Api>[];
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
}): ExtensionContext {
	return {
		modelRegistry: {
			find: vi.fn(registry.find ?? (() => undefined)),
			getAll: vi.fn(registry.getAll ?? (() => [])),
			getAvailable: vi.fn(registry.getAvailable ?? (() => [])),
			hasConfiguredAuth: vi.fn(registry.hasConfiguredAuth ?? (() => false)),
			getApiKeyAndHeaders: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

describe("resolveModel", () => {
	describe("ref 精确匹配", () => {
		it("TC3 find 命中 + hasConfiguredAuth → 返回 model", () => {
			const m = makeModel("deepseek-router", "deepseek-chat");
			const ctx = makeCtx({ find: () => m, hasConfiguredAuth: () => true });
			expect(resolveModel(ctx, { type: "ref", ref: "deepseek-router/deepseek-chat" })).toBe(m);
		});

		it("TC4 find 命中但 hasConfiguredAuth=false → null", () => {
			const m = makeModel("a", "1");
			const ctx = makeCtx({ find: () => m, hasConfiguredAuth: () => false });
			expect(resolveModel(ctx, { type: "ref", ref: "a/1" })).toBeNull();
		});

		it("TC4 find 未命中（undefined）→ null（静默降级不抛错）", () => {
			const ctx = makeCtx({ find: () => undefined, hasConfiguredAuth: () => true });
			expect(resolveModel(ctx, { type: "ref", ref: "x/9" })).toBeNull();
		});
	});

	describe("fallback 按序", () => {
		it("TC5 遍历 refs，首个可用的返回（提前返回不遍历完）", () => {
			const m1 = makeModel("a", "1");
			const m2 = makeModel("b", "2");
			const m3 = makeModel("c", "3");
			const find = vi.fn((p: string, id: string) => {
				if (p === "a" && id === "1") return m1;
				if (p === "b" && id === "2") return m2;
				if (p === "c" && id === "3") return m3;
				return undefined;
			});
			const hasAuth = vi.fn((m: Model<Api>) => m === m2); // 只有 m2 有 auth
			const ctx = makeCtx({ find, hasConfiguredAuth: hasAuth });

			expect(resolveModel(ctx, { type: "fallback", refs: ["a/1", "b/2", "c/3"] })).toBe(m2);
			expect(find).toHaveBeenCalledWith("a", "1");
			expect(find).toHaveBeenCalledWith("b", "2");
			// m1 无 auth 提前跳过，m2 命中后立即返回，不查 c/3
			expect(find).not.toHaveBeenCalledWith("c", "3");
		});

		it("TC5 全部无 auth → null", () => {
			const m1 = makeModel("a", "1");
			const ctx = makeCtx({ find: () => m1, hasConfiguredAuth: () => false });
			expect(resolveModel(ctx, { type: "fallback", refs: ["a/1", "b/2"] })).toBeNull();
		});
	});

	describe("available", () => {
		it("TC6 非空数组取首个", () => {
			const mA = makeModel("a", "1");
			const mB = makeModel("b", "2");
			const ctx = makeCtx({ getAvailable: () => [mA, mB] });
			expect(resolveModel(ctx, { type: "available" })).toBe(mA);
		});

		it("TC6 空数组 → null", () => {
			const ctx = makeCtx({ getAvailable: () => [] });
			expect(resolveModel(ctx, { type: "available" })).toBeNull();
		});
	});

	describe("ref 非法格式（parseRef 防护）", () => {
		it("C3: ref 无 '/'（如 'abc'）→ null，不调 find", () => {
			const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
			const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
			expect(resolveModel(ctx, { type: "ref", ref: "abc" })).toBeNull();
			expect(find).not.toHaveBeenCalled();
		});

		it("C3: ref 以 '/' 开头（如 '/model'）→ null，不调 find", () => {
			const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
			const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
			expect(resolveModel(ctx, { type: "ref", ref: "/model" })).toBeNull();
			expect(find).not.toHaveBeenCalled();
		});

		it("C3: ref 以 '/' 结尾（如 'provider/'）→ null，不调 find", () => {
			const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
			const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
			expect(resolveModel(ctx, { type: "ref", ref: "provider/" })).toBeNull();
			expect(find).not.toHaveBeenCalled();
		});
	});

	describe("fallback 空数组", () => {
		it("C3: {type:'fallback', refs:[]} → null，不调 find", () => {
			const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
			const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
			expect(resolveModel(ctx, { type: "fallback", refs: [] })).toBeNull();
			expect(find).not.toHaveBeenCalled();
		});
	});
});
