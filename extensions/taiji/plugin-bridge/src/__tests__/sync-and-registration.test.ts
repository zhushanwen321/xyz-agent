// sync-and-registration.test.ts — 启动 sync 循环与 registerTool 注册形状

import { describe, it, expect, vi } from "vitest";
import { BRIDGE_MARKER } from "@xyz-agent/extension-protocol";
import registerExtension from "../index.ts";

/**
 * 按 request.method 路由的 select mock：各 method 独立响应队列，队列空回 fallback。
 * session_start 触发时会同时发 bridge:sync 与 bridge:event（session_start 自身转发），
 * 按调用顺序排队的 mock 会串台，路由式与调用顺序解耦。
 */
function methodRouter(responses: Partial<Record<string, unknown[]>>, fallback: unknown = undefined) {
	const queues = new Map<string, unknown[]>(Object.entries(responses).map(([k, v]) => [k, [...(v ?? [])]]));
	return vi.fn((_title: string, options: [string]) => {
		const request = JSON.parse(options[0]) as { method: string };
		const queue = queues.get(request.method);
		if (queue && queue.length > 0) return Promise.resolve(queue.shift());
		return Promise.resolve(fallback);
	});
}

/** 注册到的工具条目形状（pi.registerTool 收到的完整定义） */
interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: Function;
}

/** select 通道 mock 形态（照 session-manager __tests__ 模式）；
 * registerToolImpl 可注入自定义注册行为（默认 push 进 registered） */
function createHarness(
	selectImpl: (...args: unknown[]) => unknown,
	registerToolImpl?: (tool: RegisteredTool) => void,
) {
	const registered: RegisteredTool[] = [];
	const handlers = new Map<string, Array<(data: unknown, ctx: unknown) => unknown>>();
	const selectMock = vi.fn(selectImpl);
	const pi = {
		registerTool: registerToolImpl ?? ((tool: RegisteredTool) => registered.push(tool)),
		on: (evt: string, handler: (data: unknown, ctx: unknown) => unknown) => {
			handlers.set(evt, [...(handlers.get(evt) ?? []), handler]);
		},
	};
	const ctx = {
		mode: "rpc" as const,
		hasUI: true,
		ui: { select: selectMock },
		sessionManager: { getSessionId: () => "sess-1" },
	};
	registerExtension(pi as never);
	return { registered, handlers, selectMock, ctx };
}

const SYNC_PAYLOAD = JSON.stringify({
	tools: [{ name: "sleep-tool", description: "Sleep for a duration", parameters: { type: "object", properties: { ms: { type: "number" } } } }],
	commands: [],
	success: true,
});

const ALL_EVENTS = [
	"session_start",
	"agent_start",
	"agent_end",
	"tool_call",
	"tool_result",
	"turn_end",
	"message_end",
	"session_compact",
	"session_tree",
	"before_agent_start",
];

function triggerSessionStart(handlers: Map<string, Array<(data: unknown, ctx: unknown) => unknown>>, ctx: unknown) {
	const handler = handlers.get("session_start")?.[0];
	if (!handler) throw new Error("session_start handler not registered");
	return handler({ type: "session_start", reason: "startup" }, ctx);
}

/** 按 request.method 过滤 select 调用 */
function callsOf(selectMock: ReturnType<typeof vi.fn>, method: string) {
	return selectMock.mock.calls
		.map((call) => call as unknown as [string, [string], unknown])
		.filter(([, options]) => JSON.parse(options[0]).method === method);
}

describe("factory 注册", () => {
	it("注册全部 10 个事件 handler（旧 bridge EVENTS 清单）", () => {
		const { handlers } = createHarness(vi.fn());
		for (const evt of ALL_EVENTS) {
			expect(handlers.get(evt)).toHaveLength(1);
		}
	});

	it("factory 同步返回（无顶层 await）且 factory 时不注册任何工具", () => {
		const { registered } = createHarness(vi.fn());
		// 工具只能来自 sync 应答——factory 阶段注册 = 编造清单
		expect(registered).toHaveLength(0);
	});

	it("session_start handler 同步返回（不阻塞 pi 启动 emit 链）", () => {
		// select 永不 resolve（无 runtime 响应的极端形态）——handler 仍必须立即返回
		const { handlers, ctx } = createHarness(() => new Promise<string>(() => {}));
		const ret = triggerSessionStart(handlers, ctx);
		expect(ret).toBeUndefined();
	});
});

describe("启动 sync（设计 §3.3-D4）", () => {
	it("session_start 触发 sync：select 用 BRIDGE_MARKER + bridge:sync 载荷，工具注册透传 parameters", async () => {
		const selectMock = methodRouter({ "bridge:sync": [SYNC_PAYLOAD] });
		const { registered, handlers, ctx } = createHarness(selectMock);
		triggerSessionStart(handlers, ctx);
		await vi.waitFor(() => expect(registered).toHaveLength(1));

		// session_start 双职责：一笔 bridge:sync + 一笔 bridge:event（session_start 自身也在转发清单里）
		const syncCalls = callsOf(selectMock, "bridge:sync");
		expect(syncCalls).toHaveLength(1);
		expect(callsOf(selectMock, "bridge:event")).toHaveLength(1);
		const [title, options] = syncCalls[0];
		expect(title).toBe(BRIDGE_MARKER);
		const request = JSON.parse(options[0]);
		expect(request).toEqual({ method: "bridge:sync" });

		const tool = registered[0];
		expect(tool.name).toBe("sleep-tool");
		expect(tool.label).toBe("sleep-tool");
		expect(tool.description).toBe("Sleep for a duration");
		// 直接透传（不做 schema 塑形，权威在 runtime plugin-service）——回包经 JSON 往返，
		// 引用相等不可断言，深度相等即证明 pi 侧零加工
		expect(tool.parameters).toStrictEqual({ type: "object", properties: { ms: { type: "number" } } });
	});

	it("commands 恒空被忽略（设计 §3.3-D7，死代码不复制）——无 registerCommand 调用路径", async () => {
		const selectMock = methodRouter({ "bridge:sync": [SYNC_PAYLOAD] });
		const { registered, handlers, ctx } = createHarness(selectMock);
		triggerSessionStart(handlers, ctx);
		await vi.waitFor(() => expect(registered).toHaveLength(1));
		// commands: [] 在 SYNC_PAYLOAD 里——若被消费会产生 pi.registerCommand 调用（harness 未提供该方法，消费即 TypeError）
		expect(callsOf(selectMock, "bridge:sync")).toHaveLength(1);
	});

	it("畸形工具条目跳过且不拖垮整批", async () => {
		const payload = JSON.stringify({
			tools: [
				{ name: "good", description: "ok", parameters: { type: "object" } },
				{ name: "bad-schema", description: "top-level not object", parameters: { type: "string" } },
				{ name: 42, description: "name not string", parameters: { type: "object" } },
			],
			commands: [],
			success: true,
		});
		const selectMock = methodRouter({ "bridge:sync": [payload] });
		const { registered, handlers, ctx } = createHarness(selectMock);
		triggerSessionStart(handlers, ctx);
		await vi.waitFor(() => expect(registered).toHaveLength(1));
		expect(registered[0].name).toBe("good");
	});

	it("error 回包 → 退避重试，后续成功即注册（场景 D 恢复路径）", async () => {
		vi.useFakeTimers();
		try {
			const selectMock = methodRouter({
				"bridge:sync": [JSON.stringify({ error: "Plugin system not available" }), SYNC_PAYLOAD],
			});
			const { registered, handlers, ctx } = createHarness(selectMock);
			triggerSessionStart(handlers, ctx);
			await vi.advanceTimersByTimeAsync(0);
			expect(registered).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(2_000);
			await vi.waitFor(() => expect(registered).toHaveLength(1));
			// sync 两笔（首发失败 + 退避重试成功）；bridge:event 一笔（session_start 转发，回包被丢弃不影响）
			expect(callsOf(selectMock, "bridge:sync")).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("重试到顶 30 次 → Degraded（零注册，不再重试）", async () => {
		vi.useFakeTimers();
		try {
			const selectMock = methodRouter({}); // 所有 method 回 undefined → sync 恒失败
			const { registered, handlers, ctx } = createHarness(selectMock);
			triggerSessionStart(handlers, ctx);
			await vi.advanceTimersByTimeAsync(0);
			// 29 次 2s 退避全部走完（30 attempts = 1 immediate + 29 delayed）
			await vi.advanceTimersByTimeAsync(29 * 2_000 + 1_000);
			expect(callsOf(selectMock, "bridge:sync")).toHaveLength(30);
			expect(registered).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("并发生起 sync 防抖：同一时刻仅一个循环 in flight", async () => {
		const selectMock = methodRouter({ "bridge:sync": [SYNC_PAYLOAD] });
		const { handlers, ctx } = createHarness(selectMock);
		// 两次 session_start（startup + new）背靠背触发——共享同一 in-flight promise
		triggerSessionStart(handlers, ctx);
		triggerSessionStart(handlers, ctx);
		await new Promise((r) => setTimeout(r, 0));
		// sync 只发一笔（防抖命中）；event 转发每触发一次一笔（两笔，各自独立 fire-and-forget）
		expect(callsOf(selectMock, "bridge:sync")).toHaveLength(1);
		expect(callsOf(selectMock, "bridge:event")).toHaveLength(2);
	});

	it("registerTool throw 被循环整体兜底：退避重试后成功注册，无 unhandled rejection 逃逸", async () => {
		vi.useFakeTimers();
		// session_start 的 `void ensureSynced(ctx)` 无人 await——若 runSyncLoop 循环体
		// 不兜底，registerTool 的同步 throw 会变 unhandledRejection 逃逸到进程级
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// 第一笔 sync 回包正常，但 pi.registerTool 同步 throw（模拟 pi 内部错误）；
			// 第二笔退避重试成功——证明 throw 走 {ok:false} 同路径而非打断循环
			let throwOnce = true;
			const selectMock = methodRouter({ "bridge:sync": [SYNC_PAYLOAD, SYNC_PAYLOAD] });
			const { registered, handlers, ctx } = createHarness(selectMock, (tool) => {
				if (throwOnce) {
					throwOnce = false;
					throw new Error("pi internal registerTool failure");
				}
				registered.push(tool);
			});
			triggerSessionStart(handlers, ctx);

			await vi.advanceTimersByTimeAsync(0);
			// 第一次 attempt 被 catch 兜底：零注册、promise 已 settle（无 unhandled）
			expect(registered).toHaveLength(0);
			expect(rejections).toEqual([]);

			await vi.advanceTimersByTimeAsync(2_000);
			await vi.waitFor(() => expect(registered).toHaveLength(1));
			expect(registered[0].name).toBe("sleep-tool");
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			vi.useRealTimers();
		}
	});
});
