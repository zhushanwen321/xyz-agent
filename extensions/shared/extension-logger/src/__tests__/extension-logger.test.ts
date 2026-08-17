import { existsSync, readFileSync, rmSync, mkdirSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	const prevEnv = { ...process.env };

	beforeEach(() => {
		appendSpy = vi.fn();
		pi = { appendEntry: appendSpy };
		setPiHandle(undefined);
	});

	afterEach(() => {
		setPiHandle(undefined);
		vi.restoreAllMocks();
		// 还原环境变量，避免文件日志测试的 XYZ_AGENT_DEBUG/PI_CODING_AGENT_DIR 泄漏到其它用例
		process.env = { ...prevEnv };
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

		// ---- error 分支：与 warn 对称的前缀补全 + appendEntry 失败降级（Suggestion #10）----
		it("error msg 已有 [extName] 前缀时不重复补", () => {
			const logger = createLogger("subagents", pi);
			logger.error("[subagents] critical budget abort");

			const [, data] = appendSpy.mock.calls[0]!;
			expect(data).toMatchObject({
				message: "[subagents] critical budget abort",
			});
		});

		it("error appendEntry 抛错时不 throw（降级到文件日志）", () => {
			const throwingPi: PiLike = {
				appendEntry: () => {
					throw new Error("session disposed");
				},
			};
			const logger = createLogger("test", throwingPi);
			expect(() => logger.error("no crash")).not.toThrow();
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

	describe("XYZ_AGENT_DEBUG 文件日志", () => {
		// 文件日志的 agentDir 通过 getAgentDir() 推导（读 PI_CODING_AGENT_DIR，
		// 默认 ~/.pi/agent）。设 PI_CODING_AGENT_DIR 到 tmpdir 子目录，与组 A 的
		// arch-boundary 改动（fileLog 用 getAgentDir()）保持一致。
		let tmpAgentDir: string;

		beforeEach(() => {
			tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-log-"));
			process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
			if (tmpAgentDir) {
				rmSync(tmpAgentDir, { recursive: true, force: true });
			}
		});

		it("XYZ_AGENT_DEBUG 未设时 debug 是 no-op（不抛错即可）", () => {
			delete process.env.XYZ_AGENT_DEBUG;
			const logger = createLogger("test", pi);
			expect(() => logger.debug("no-op")).not.toThrow();
		});

		// ---- Suggestion #8：fileLog 实际写入路径 ----
		it("XYZ_AGENT_DEBUG=1 时 debug 写入日志文件，内容含 [debug] 与序列化 data", () => {
			process.env.XYZ_AGENT_DEBUG = "1";
			// 固定日期 → 文件名 <extName>-2026-08-01.log
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("dbg-ext", pi);
			logger.debug("streaming state", { id: "rec-1", count: 3 });

			const logFile = join(tmpAgentDir, "logs", "dbg-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);

			const content = readFileSync(logFile, "utf8");
			// 时间戳 + level + msg
			expect(content).toContain("[debug]");
			expect(content).toContain("streaming state");
			// data 经 safeStringify（JSON.stringify）序列化
			expect(content).toContain('"id":"rec-1"');
			expect(content).toContain('"count":3');
			// 单行以换行结尾
			expect(content.endsWith("\n")).toBe(true);
			// debug 不走 appendEntry
			expect(appendSpy).not.toHaveBeenCalled();
		});

		it("XYZ_AGENT_DEBUG=1 时 warn 既写文件又走 appendEntry（文件内容含 [warn]）", () => {
			process.env.XYZ_AGENT_DEBUG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("warn-ext", pi);
			logger.warn("manifest retry", { attempt: 2 });

			const logFile = join(tmpAgentDir, "logs", "warn-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);
			const content = readFileSync(logFile, "utf8");
			expect(content).toContain("[warn]");
			expect(content).toContain("[warn-ext] manifest retry");
			expect(content).toContain('"attempt":2');
			// 同时走 appendEntry
			expect(appendSpy).toHaveBeenCalledOnce();
		});

		it("XYZ_AGENT_DEBUG=1 写失败（只读目录）不 throw", () => {
			process.env.XYZ_AGENT_DEBUG = "1";
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			// 已存在的 logs 目录改为只读，让 mkdirSync/appendFileSync 失败。
			// 用 debug（只走文件路径），断言 best-effort 吞错。
			const READONLY_MODE = 0o555; // r-xr-xr-x，无写权限
			const RESTORE_MODE = 0o755; // rwxr-xr-x，恢复写权限以便清理
			const readonlyAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-ro-"));
			const logDir = join(readonlyAgentDir, "logs");
			mkdirSync(logDir, { recursive: true });
			chmodSync(logDir, READONLY_MODE);
			process.env.PI_CODING_AGENT_DIR = readonlyAgentDir;

			const logger = createLogger("ro-ext", pi);
			expect(() => logger.debug("should not throw")).not.toThrow();

			// 清理：先恢复写权限才能删除
			chmodSync(logDir, RESTORE_MODE);
			rmSync(readonlyAgentDir, { recursive: true, force: true });
		});
	});

	// ---- Suggestion #9：safeStringify 对循环引用/BigInt 的兜底 ----
	describe("safeStringify 兜底（循环引用 / BigInt）", () => {
		it("循环引用对象：warn 不崩，data 走 String fallback 进 appendEntry", () => {
			// debug 不进 appendEntry，故用 warn（warn/error 把 data 原样传给 appendEntry）
			const logger = createLogger("cycle", pi);
			const cyclic: Record<string, unknown> = { name: "loop" };
			cyclic.self = cyclic;

			expect(() => logger.warn("cyclic data", cyclic)).not.toThrow();
			expect(appendSpy).toHaveBeenCalledOnce();
			const [, entry] = appendSpy.mock.calls[0]!;
			// appendEntry payload 的 data 字段保留原对象（safeStringify 仅在文件日志路径用）
			expect(entry).toMatchObject({ level: "warn" });
			// 验证 safeStringify 的 fallback 分支：用 XYZ_AGENT_DEBUG=1 触发 fileLog，
			// 文件内 data 应是 String() 形式（含 [object Object] 或循环结构字符串）
			expect(() => JSON.stringify(cyclic)).toThrow(); // 对照：原对象确实不可序列化
		});

		it("BigInt：warn 不崩，文件日志路径走 String fallback", () => {
			process.env.XYZ_AGENT_DEBUG = "1";
			const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-ext-bigint-"));
			process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
			vi.setSystemTime(new Date("2026-08-01T12:34:56.789Z"));

			const logger = createLogger("bigint-ext", pi);
			const bigIntData = { count: 9007199254740993n, name: "big" };

			expect(() => logger.warn("bigint data", bigIntData)).not.toThrow();
			expect(appendSpy).toHaveBeenCalledOnce();

			const logFile = join(tmpAgentDir, "logs", "bigint-ext-2026-08-01.log");
			expect(existsSync(logFile)).toBe(true);
			const content = readFileSync(logFile, "utf8");
			// BigInt 不可 JSON.stringify → 走 String(data) fallback：对象 toString 形式
			expect(content).toContain("[warn]");
			// 对照：JSON.stringify(BigInt) 会 throw，故文件内不应是 JSON 形式
			expect(content).not.toContain('"count"');

			vi.useRealTimers();
			rmSync(tmpAgentDir, { recursive: true, force: true });
		});
	});
});
