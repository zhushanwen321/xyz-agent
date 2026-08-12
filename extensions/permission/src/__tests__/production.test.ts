/**
 * production.test.ts — createProductionClassifier + createPipelineDeps 装配测试。
 *
 * P3 收口后 createProductionClassifier(ctx) 走 ctx.modelRegistry（resolveModel +
 * getApiKeyAndHeaders）。测试用 mock ctx.modelRegistry + vi.mock llm-shared resolveModel
 * 精确控制 model 解析与凭证返回，覆盖：
 *  - TC1/TC2: toSelector 映射（'auto'→scoped / 'provider/model-id'→ref）
 *  - TC3: scoped 全空 fail-closed（resolveModel null → classifyRisk fallback）
 *  - TC4: OAuth 命中（resolveModel 返回 model + getApiKeyAndHeaders ok → auth 装配）
 *  - TC5: auth.ok=false → null fail-closed（narrow 不访问 auth.apiKey）
 *  - TC7: scoped 空 fallback available（CL-scoped-fallback 退化防护）
 *  - m1: 每次 createPipelineDeps 创建独立 classifier（CL-classifier-singleton）
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalContext } from "../approval.js";
import type { CheckPermissionDeps } from "../pipeline.js";
import { createPipelineDeps, createProductionClassifier, toSelector } from "../production.js";

// vi.mock 必须在 import 之前（vitest hoisting）。替换 llm-shared 的 resolveModel 为可控 mock，
// 默认透传 actual（真实读 settings.json），单测用 mockImplementation 精确控制。
vi.mock("@zhushanwen/pi-llm-shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@zhushanwen/pi-llm-shared")>();
	return {
		...actual,
		resolveModel: vi.fn(actual.resolveModel),
	};
});

// mock 后再 import，拿到的是 mock 版（用于单测配置返回值）
const { resolveModel: resolveModelShared } = await import("@zhushanwen/pi-llm-shared");

// ──────────────────────── fixtures ────────────────────────

/** 测试用 model（api 用未注册的 bogus 值，让 getApiProvider 返回 undefined → streamSimple throw → fallback） */
const MOCK_MODEL_A: Model<Api> = {
	id: "model-a",
	name: "Model A",
	api: "bogus-api" as Api,
	provider: "test-co",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

function makeApprovalCtx(): ApprovalContext {
	return {
		mode: "headless",
		ui: {
			notify() {},
			select() {
				return Promise.resolve(undefined);
			},
			custom() {
				return Promise.resolve(undefined);
			},
		},
	};
}

/** 构造 mock ctx（仅 modelRegistry 相关方法，其余字段 createProductionClassifier 不用） */
function makeMockCtx(over: {
	getAll?: () => Model<Api>[];
	getAvailable?: () => Model<Api>[];
	hasConfiguredAuth?: (m: Model<Api>) => boolean;
	find?: (provider: string, id: string) => Model<Api> | null;
	getApiKeyAndHeaders?: (m: Model<Api>) => Promise<{ ok: true; apiKey: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }>;
} = {}): ExtensionContext {
	const modelRegistry = {
		getAll: over.getAll ?? vi.fn(() => []),
		getAvailable: over.getAvailable ?? vi.fn(() => []),
		hasConfiguredAuth: over.hasConfiguredAuth ?? vi.fn(() => false),
		find: over.find ?? vi.fn(() => null),
		getApiKeyAndHeaders: over.getApiKeyAndHeaders ?? vi.fn(async () => ({ ok: false, error: "no auth" })),
	};
	return { modelRegistry } as unknown as ExtensionContext;
}

beforeEach(() => {
	vi.mocked(resolveModelShared).mockReset();
});

// ──────────────────────── TC1/TC2: toSelector 映射 ────────────────────────

describe("toSelector（C2：'auto'→scoped 向后兼容）", () => {
	it("TC1: 'auto' 映射为 scoped", () => {
		expect(toSelector("auto")).toEqual({ type: "scoped" });
	});

	it("TC2: 'provider/model-id' 映射为 ref", () => {
		expect(toSelector("anthropic/claude-sonnet")).toEqual({ type: "ref", ref: "anthropic/claude-sonnet" });
	});

	it("任意非 'auto' 字符串都视为 ref（含边角格式，由 resolveRef 判合法性）", () => {
		expect(toSelector("openai/gpt-4o")).toEqual({ type: "ref", ref: "openai/gpt-4o" });
	});
});

// ──────────────────────── createProductionClassifier ────────────────────────

describe("createProductionClassifier", () => {
	it("返回带 classifyRisk 的对象", () => {
		const classifier = createProductionClassifier(makeMockCtx());
		expect(typeof classifier.classifyRisk).toBe("function");
	});

	it("ref 模式 resolveModel 返回 null → classifyRisk fail-closed 返回 ask（不 throw）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(null);
		const classifier = createProductionClassifier(makeMockCtx());
		const result = await classifier.classifyRisk(
			{ toolName: "bash", command: "ls", cwd: "/tmp" },
			{ enabled: true, model: "nonexistent-provider/no-such-model", timeout: 5, autoApproveLowRisk: false, autoDenyHighRisk: true },
		);
		expect(result.outcome).toBe("ask");
		expect(result.risk_level).toBe("medium");
	});
});

// ──────────────────────── resolveModelAndAuth 装配（C3） ────────────────────────

describe("resolveModelAndAuth 装配（resolveModel + getApiKeyAndHeaders）", () => {
	const CTX = { toolName: "bash", command: "ls", cwd: "/tmp" };
	const CFG = { enabled: true, model: "auto", timeout: 5, autoApproveLowRisk: false, autoDenyHighRisk: true };

	it("TC3: scoped enabledModels 空 + available 空 → resolveModel null → fail-closed ask（getApiKeyAndHeaders 不被调）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(null);
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "should-not-reach" }));
		const ctx = makeMockCtx({ getApiKeyAndHeaders });
		const classifier = createProductionClassifier(ctx);
		const result = await classifier.classifyRisk(CTX, CFG);
		expect(result.outcome).toBe("ask");
		expect(result.confidence).toBe(0);
		// 关键：resolveModel null 时不应触达 getApiKeyAndHeaders
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("TC4: scoped 命中 model + getApiKeyAndHeaders ok → auth 装配（apiKey 来自 getApiKeyAndHeaders，场景 3 OAuth）", async () => {
		vi.mocked(resolveModelShared).mockImplementation((_ctx, selector) =>
			selector.type === "scoped" ? MOCK_MODEL_A : null,
		);
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "oauth-key-xxx" }));
		const ctx = makeMockCtx({ getApiKeyAndHeaders });
		const classifier = createProductionClassifier(ctx);
		// streamSimple 走真实 getApiProvider，bogus-api 未注册 → throw → classifier catch → fallback ask。
		// 本测试验证装配层（resolve→auth 链路通），streamSimple apiKey 透传由 classifier.test.ts CT5 覆盖。
		const result = await classifier.classifyRisk(CTX, CFG);
		expect(result.outcome).toBe("ask"); // streamSimple throw 的 fallback（非 null 路径）
		// 关键：resolveModel 返回 model 后，getApiKeyAndHeaders 被调用且收到该 model（证明 OAuth resolve→auth 通）
		expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(MOCK_MODEL_A);
		// scoped 命中只调 1 次 resolveModel（不走 available fallback）
		expect(vi.mocked(resolveModelShared)).toHaveBeenCalledTimes(1);
	});

	it("TC5: getApiKeyAndHeaders 返回 auth.ok=false → null fail-closed（narrow 不访问 auth.apiKey，不 throw）", async () => {
		vi.mocked(resolveModelShared).mockReturnValue(MOCK_MODEL_A);
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: false as const, error: "token expired" }));
		const ctx = makeMockCtx({ getApiKeyAndHeaders });
		const classifier = createProductionClassifier(ctx);
		const result = await classifier.classifyRisk(CTX, CFG);
		expect(result.outcome).toBe("ask");
		expect(result.confidence).toBe(0);
		expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
	});

	it("TC7: scoped 空 fallback available 命中（CL-scoped-fallback：有 auth provider 但无 enabledModels 不退化）", async () => {
		// scoped（首次）返回 null，available（fallback）返回 MOCK_MODEL_A
		vi.mocked(resolveModelShared).mockImplementation((_ctx, selector) =>
			selector.type === "available" ? MOCK_MODEL_A : null,
		);
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "available-key" }));
		const ctx = makeMockCtx({ getApiKeyAndHeaders });
		const classifier = createProductionClassifier(ctx);
		const result = await classifier.classifyRisk(CTX, CFG);
		// fallback 命中 available → getApiKeyAndHeaders 被调（非 scoped 的 null 直接返回）
		expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(MOCK_MODEL_A);
		// scoped 调 1 次（null）+ available fallback 调 1 次 = 2 次
		expect(vi.mocked(resolveModelShared)).toHaveBeenCalledTimes(2);
		// streamSimple bogus-api throw → fallback ask（但已证明 resolveModelAndAuth 非 null）
		expect(result.outcome).toBe("ask");
	});
});

// ──────────────────────── createPipelineDeps ────────────────────────

describe("createPipelineDeps", () => {
	it("装配完整 CheckPermissionDeps（5 个字段齐全）", () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		expect(deps).toBeInstanceOf(Object);
		expect(typeof deps.analyzeBashStructure).toBe("function");
		expect(typeof deps.matchRulesForArgv).toBe("function");
		expect(typeof deps.getDefaultRules).toBe("function");
		expect(typeof deps.classifier.classifyRisk).toBe("function");
		expect(typeof deps.requestUserApproval).toBe("function");
	});

	it("getDefaultRules 返回内置危险规则（12 条）", () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		const rules = deps.getDefaultRules();
		expect(rules.length).toBe(12);
		expect(rules.every((r) => r.source === "builtin-danger")).toBe(true);
	});

	it("analyzeBashStructure 是真实实现（干净命令 → clean=true）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		const analysis = await deps.analyzeBashStructure("ls -la");
		expect(analysis.clean).toBe(true);
		expect(analysis.commands).toEqual([["ls", "-la"]]);
	});

	it("requestUserApproval 走 headless 分支（M1：signal abort → fail-closed deny）", async () => {
		const deps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		// M1：headless 无 signal 时永挂，故用已 aborted 的 signal 触发 fail-closed deny。
		const controller = new AbortController();
		controller.abort();
		const decision = await deps.requestUserApproval(
			{ toolName: "bash", command: "rm", reason: "test" },
			{ toolName: "bash", command: "rm", cwd: "/tmp" },
			controller.signal,
		);
		expect(decision.approved).toBe(false);
		expect(decision.reason).toContain("headless");
	});

	it("deps 满足 CheckPermissionDeps 类型（结构兼容）", () => {
		const deps: CheckPermissionDeps = createPipelineDeps(makeApprovalCtx(), makeMockCtx());
		// 仅验证类型兼容（运行时已在上面测试）
		expect(deps).toBeDefined();
	});

	it("m1：每次 createPipelineDeps 创建独立 classifier（CL-classifier-singleton：modelRegistry 绑 ctx 不安全）", () => {
		const ctx = makeMockCtx();
		const deps1 = createPipelineDeps(makeApprovalCtx(), ctx);
		const deps2 = createPipelineDeps(makeApprovalCtx(), ctx);
		// 每次 createPipelineDeps 都新建 classifier（无模块级单例）
		expect(deps1.classifier).not.toBe(deps2.classifier);
		expect(deps1.classifier.classifyRisk).not.toBe(deps2.classifier.classifyRisk);
	});
});
