// src/__tests__/file-lock-compromise.test.ts
//
// 锁妥协（compromise）路径单测（真实文件系统 + 真实 proper-lockfile，仅 mock 共享 logger）：
//   - onCompromised 标记：持锁期间 lockfile 被外部删除 → proper-lockfile 的 mtime
//     保活定时器 stat 发现 ENOENT → setLockAsCompromised → onCompromised 回调
//   - unlock 失败留痕：compromised 后 release() 拒绝（ERELEASED）→ finally catch 记
//     logger.debug「不外抛、不静默」——fn 结果不受影响
//
// 时序依据（proper-lockfile@4.1.2 lib/lockfile.js）：保活间隔 update =
// max(min(stale/2, stale/2), 1000)，staleMs: 2000 时 = 1000ms——fn 内删锁后等待
// 1300ms 让保活定时器跑完一轮，compromise 必然在 fn 返回前发生。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withFileLock } from "../file-lock.ts";

// mock 掉共享 logger，使 loggerMock.debug 可被断言（真实 logger 落盘不可观察）
const { loggerMock } = vi.hoisted(() => ({
	loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: vi.fn(),
}));

describe("withFileLock 锁妥协路径（compromise）", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-compromise-"));
		target = path.join(tmpDir, "target.json");
		loggerMock.debug.mockClear();
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	it("fn 执行期间锁被外部删除 → fn 正常返回 + unlock 失败记 debug（不外抛）", async () => {
		const result = await withFileLock(
			target,
			async () => {
				// 模拟持锁进程崩溃后被对端夺取/清理：lockfile 是目录（proper-lockfile 用 mkdir 上锁）
				fs.rmSync(`${target}.lock`, { recursive: true, force: true });
				// 等保活定时器（staleMs:2000 → update 1000ms）stat lockfile 发现 ENOENT
				// → onCompromised 标记 compromised + released=true
				await new Promise((r) => setTimeout(r, 1300));
				return "fn-done";
			},
			{ staleMs: 2000 },
		);

		// compromise 发生在 fn 执行期间：try 开头的 compromised 检查已过，fn 结果原样返回
		expect(result).toBe("fn-done");
		// finally 中 release() 因 released=true 拒绝 ERELEASED → catch 记 debug 留痕
		expect(loggerMock.debug).toHaveBeenCalledTimes(1);
		expect(String(loggerMock.debug.mock.calls[0]![0])).toContain("unlock failed after compromise");
		expect(JSON.stringify(loggerMock.debug.mock.calls[0]![1])).toContain("Lock is already released");
		// 真实 proper-lockfile 计时（staleMs 2000 + 1300ms 等待）+ CI 慢盘，放宽预算防 flaky
	}, 15000);
});
