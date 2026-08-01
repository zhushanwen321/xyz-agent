import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createLogger,
	getLogger,
	setPiHandle,
	type PiLike,
} from "../index.js";

describe("extension-logger", () => {
	let appendSpy: ReturnType<typeof vi.fn>;
	let pi: PiLike;

	beforeEach(() => {
		appendSpy = vi.fn();
		pi = { appendEntry: appendSpy };
		setPiHandle(undefined);
	});

	afterEach(() => {
		setPiHandle(undefined);
		vi.restoreAllMocks();
	});

	describe("createLogger", () => {
		it("warn 走 pi.appendEntry，customType 前缀为 <extName>:log", () => {
			const logger = createLogger("test-ext", pi);
			logger.warn("manifest write failed", { id: "rec-1" });

			expect(appendSpy).toHaveBeenCalledOnce();
			const [customType, data] = appendSpy.mock.calls[0]!;
			expect(customType).toBe("test-ext:log");
			expect(data).toMatchObject({
				level: "warn",
				message: "[test-ext] manifest write failed",
				data: { id: "rec-1" },
			});
		});

		it("error 走 pi.appendEntry，level 为 error", () => {
			const logger = createLogger("subagents", pi);
			logger.error("budget abort failed");

			expect(appendSpy).toHaveBeenCalledOnce();
			const [, data] = appendSpy.mock.calls[0]!;
			expect(data).toMatchObject({
				level: "error",
				message: "[subagents] budget abort failed",
			});
		});

		it("msg 已有 [extName] 前缀时不重复补", () => {
			const logger = createLogger("subagents", pi);
			logger.warn("[subagents] skip malformed manifest");

			const [, data] = appendSpy.mock.calls[0]!;
			expect(data).toMatchObject({
				message: "[subagents] skip malformed manifest",
			});
		});

		it("appendEntry 抛错时不 throw（降级到文件日志）", () => {
			const throwingPi: PiLike = {
				appendEntry: () => {
					throw new Error("session disposed");
				},
			};
			const logger = createLogger("test", throwingPi);
			expect(() => logger.warn("no crash")).not.toThrow();
		});
	});

	describe("pi handle 延迟注入", () => {
		it("createLogger 时不传 pi，后续 setPiHandle 后 warn 生效", () => {
			const logger = createLogger("delayed");
			// 注入前——appendEntry 不该被调用（pi=undefined）
			logger.warn("before injection");
			expect(appendSpy).not.toHaveBeenCalled();

			// 注入后——同一 logger 实例的 warn 生效（闭包读 globalPi 实时值）
			setPiHandle(pi);
			logger.warn("after injection");
			expect(appendSpy).toHaveBeenCalledOnce();
		});
	});

	describe("getLogger singleton", () => {
		it("同名多次调用返回同一实例", () => {
			const a = getLogger("subagents");
			const b = getLogger("subagents");
			expect(a).toBe(b);
		});

		it("getLogger 创建的 logger 接受后续 setPiHandle", () => {
			const logger = getLogger("workflow");
			logger.warn("no pi yet");
			expect(appendSpy).not.toHaveBeenCalled();

			setPiHandle(pi);
			logger.warn("pi injected");
			expect(appendSpy).toHaveBeenCalledOnce();
		});
	});

	describe("debug 不走 appendEntry", () => {
		it("debug 不调 appendEntry（即使 pi 已注入）", () => {
			const logger = createLogger("test", pi);
			logger.debug("streaming intermediate state");
			expect(appendSpy).not.toHaveBeenCalled();
		});
	});

	describe("PI_EXT_DEBUG 文件日志", () => {
		it("PI_EXT_DEBUG 未设时 debug 是 no-op（不抛错即可）", () => {
			delete process.env.PI_EXT_DEBUG;
			const logger = createLogger("test", pi);
			expect(() => logger.debug("no-op")).not.toThrow();
		});
	});
});
