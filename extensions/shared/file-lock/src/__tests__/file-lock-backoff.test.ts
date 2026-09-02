// src/__tests__/file-lock-backoff.test.ts
//
// async 版退避重试参数单测（mock lock-core + fake timers，不碰真实文件系统）。
// 验收条款「async 退避参数 10×factor2 100ms~10s randomize」的精确断言：
//   - 默认 retries=10 → 首试 + 10 次重试 = 11 次 acquire
//   - 第 attempt 次失败后的等待 = min(round((random+1) * 100 * 2**attempt), 10_000)
//     （照抄 proper-lockfile 内部 retry 库公式；randomize 倍率 [1,2)）
//     → 前 6 段区间 [100*2^i, 200*2^i]，第 7 段起触顶 10s cap
//   - staleMs 默认 30_000 透传 core；opts.retries 可覆盖次数（0 → 首试失败即抛）

import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// mock 锁原语层：acquireLock 恒抛 ELOCKED（退避耗尽路径），调用时刻用 mock clock 记录
const { acquireLockMock } = vi.hoisted(() => ({ acquireLockMock: vi.fn() }));

vi.mock("../lock-core.ts", () => ({
	DEFAULT_STALE_MS: 30_000,
	acquireLock: acquireLockMock,
	acquireLockSync: vi.fn(),
}));

import { DEFAULT_STALE_MS, withFileLock } from "../file-lock.ts";

function elocked(): Error {
	return Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
}

describe("withFileLock 退避重试编排（对齐 retry 库 10×factor2 100ms~10s randomize）", () => {
	const target = path.join("/tmp", "file-lock-backoff-fake", "target.json");

	beforeEach(() => {
		acquireLockMock.mockReset();
		acquireLockMock.mockImplementation(async () => {
			throw elocked();
		});
	});

	it("默认参数：11 次 acquire（首试 + 10 重试），staleMs 30s 透传，最终抛 ELOCKED", async () => {
		vi.useFakeTimers();
		try {
			const acquisitionTimes: number[] = [];
			acquireLockMock.mockImplementation(async () => {
				acquisitionTimes.push(Date.now());
				throw elocked();
			});

			const pending = withFileLock(target, async () => "never");
			// 立即 attach 断言（reject 可能先于 timers 推进发生，晚 attach 会报 unhandledRejection）
			const settled = expect(pending).rejects.toMatchObject({ code: "ELOCKED" });
			// flush 首试 microtask（调度第一个退避 timer），再一次性推进全部退避等待
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000_000);
			await settled;

			expect(acquireLockMock).toHaveBeenCalledTimes(11);
			// 透传参数：staleMs 默认 30_000，log 未注入时为 undefined
			for (const call of acquireLockMock.mock.calls) {
				expect(call[1]).toMatchObject({ staleMs: DEFAULT_STALE_MS });
			}
			expect(acquisitionTimes).toHaveLength(11);
		} finally {
			vi.useRealTimers();
		}
	});

	it("退避序列：第 i 段等待 ∈ [100*2^i, 200*2^i]（randomize），第 7 段起触顶 10s", async () => {
		vi.useFakeTimers();
		try {
			const acquisitionTimes: number[] = [];
			acquireLockMock.mockImplementation(async () => {
				acquisitionTimes.push(Date.now());
				throw elocked();
			});

			const pending = withFileLock(target, async () => "never");
			const settled = expect(pending).rejects.toMatchObject({ code: "ELOCKED" });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000_000);
			await settled;

			expect(acquisitionTimes).toHaveLength(11);
			const gaps = acquisitionTimes.slice(1).map((t, i) => t - acquisitionTimes[i]!);
			expect(gaps).toHaveLength(10);
			for (let i = 0; i < gaps.length; i++) {
				// 第 i 段等待 ∈ [min(100*2^i, cap), min(200*2^i, cap)]：randomize 倍率 [1,2)，
				// i>=7 底数超 cap → 区间坍缩为 10000
				const floor = Math.min(100 * 2 ** i, 10_000);
				const ceiling = Math.min(200 * 2 ** i, 10_000);
				expect(gaps[i]).toBeGreaterThanOrEqual(floor);
				expect(gaps[i]).toBeLessThanOrEqual(ceiling);
			}
			// i=6 区间 [6400,12800) ∩ cap → [6400,10000]（不必然触顶）；i>=7 底数已超 cap，必然 10000
			for (let i = 7; i < gaps.length; i++) {
				expect(gaps[i]).toBe(10_000);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("opts.retries: 0 → 仅首试 1 次即抛 ELOCKED（次数可覆盖）", async () => {
		vi.useFakeTimers();
		try {
			const pending = withFileLock(target, async () => "never", { retries: 0 });
			const settled = expect(pending).rejects.toMatchObject({ code: "ELOCKED" });
			await vi.advanceTimersByTimeAsync(0);
			await settled;
			expect(acquireLockMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("非 ELOCKED 错误不重试，立即透传", async () => {
		acquireLockMock.mockImplementation(async () => {
			throw new Error("EPERM-ish");
		});
		await expect(withFileLock(target, async () => "never")).rejects.toThrow("EPERM-ish");
		expect(acquireLockMock).toHaveBeenCalledTimes(1);
	});

	it("获取成功后 fn 结果返回、release 被调用", async () => {
		const release = vi.fn(async () => {});
		acquireLockMock.mockImplementation(async () => release);
		await expect(withFileLock(target, async () => "ok")).resolves.toBe("ok");
		expect(release).toHaveBeenCalledTimes(1);
	});
});
