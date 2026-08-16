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
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
}): ExtensionContext {
	return {
		modelRegistry: {
			find: vi.fn(registry.find ?? (() => undefined)),
			hasConfiguredAuth: vi.fn(registry.hasConfiguredAuth ?? (() => false)),
			getApiKeyAndHeaders: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

describe("resolveModel（仅 ref 精确指定）", () => {
	it("find 命中 + hasConfiguredAuth → 返回 model", () => {
		const m = makeModel("deepseek-router", "deepseek-chat");
		const ctx = makeCtx({ find: () => m, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "deepseek-router/deepseek-chat" })).toBe(m);
	});

	it("find 命中但 hasConfiguredAuth=false → null", () => {
		const m = makeModel("a", "1");
		const ctx = makeCtx({ find: () => m, hasConfiguredAuth: () => false });
		expect(resolveModel(ctx, { type: "ref", ref: "a/1" })).toBeNull();
	});

	it("find 未命中（undefined）→ null（静默降级不抛错）", () => {
		const ctx = makeCtx({ find: () => undefined, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "x/9" })).toBeNull();
	});

	it("ref 无 '/'（如 'abc'）→ null，不调 find", () => {
		const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
		const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "abc" })).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});

	it("ref 以 '/' 开头（如 '/model'）→ null，不调 find", () => {
		const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
		const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "/model" })).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});

	it("ref 以 '/' 结尾（如 'provider/'）→ null，不调 find", () => {
		const find = vi.fn((_provider: string, _modelId: string): Model<Api> | undefined => undefined);
		const ctx = makeCtx({ find, hasConfiguredAuth: () => true });
		expect(resolveModel(ctx, { type: "ref", ref: "provider/" })).toBeNull();
		expect(find).not.toHaveBeenCalled();
	});
});
