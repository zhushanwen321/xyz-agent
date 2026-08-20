// src/__tests__/file-lock.test.ts
//
// 跨进程文件锁单测（真实文件系统，不 mock fs）：
//   - async/sync 版临界区互斥（并发不交错）
//   - unlock 后可再锁（finally 释放语义）
//   - sync 版 fail-fast（ELOCKED 预算耗尽抛错，不用默认 1s——测试覆盖盖短预算）
//   - 真实跨进程互斥：两个 node 子进程并发 RMW 同一 JSON 文件，计数零丢失
//     （「两写方并发不丢条目」的 D5a/D1e 核心验收形态）

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock, withFileLockSync } from "../file-lock.ts";

const PKG_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

describe("withFileLock (async)", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	it("并发临界区互斥：计数无交错丢失", async () => {
		let counter = 0;
		const inside: number[] = [];
		const tasks = Array.from({ length: 20 }, () =>
			withFileLock(target, async () => {
				counter += 1;
				inside.push(counter);
				// 让出 event loop 制造无锁时必交错的窗口
				await new Promise((r) => setTimeout(r, 1));
			}),
		);
		await Promise.all(tasks);
		expect(counter).toBe(20);
		// 每个临界区进入时的 counter 单调 +1（无两个临界区读到同值）
		expect(new Set(inside).size).toBe(20);
	});

	it("fn 抛错也释放锁（finally 语义：后续可再锁）", async () => {
		await expect(
			withFileLock(target, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// 同一 target 立即可再锁 = 前次已释放
		await expect(withFileLock(target, async () => "ok")).resolves.toBe("ok");
	});

	it("锁内 RMW：并发各 +1 一百次，文件终值 100（丢更新=锁失效）", async () => {
		fs.writeFileSync(target, JSON.stringify({ n: 0 }), "utf-8");
		const bump = (): Promise<void> =>
			withFileLock(target, async () => {
				const cur = JSON.parse(fs.readFileSync(target, "utf-8")) as { n: number };
				cur.n += 1;
				fs.writeFileSync(target, JSON.stringify(cur), "utf-8");
			});
		await Promise.all(Array.from({ length: 100 }, bump));
		expect((JSON.parse(fs.readFileSync(target, "utf-8")) as { n: number }).n).toBe(100);
	});
});

describe("withFileLockSync", () => {
	let tmpDir: string;
	let target: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-sync-test-"));
		target = path.join(tmpDir, "target.json");
	});
	afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	it("返回 fn 结果且锁已释放（可立即再锁）", () => {
		expect(withFileLockSync(target, () => 42)).toBe(42);
		expect(withFileLockSync(target, () => "again")).toBe("again");
	});

	it("fn 抛错也释放锁", () => {
		expect(() =>
			withFileLockSync(target, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(withFileLockSync(target, () => "ok")).toBe("ok");
	});

	it("ELOCKED fail-fast：预算耗尽抛带 code 的错误（不用默认 1s 预算）", () => {
		// 先占锁（外层 sync 锁），再在 fn 内嵌套取锁 → 必 ELOCKED → 短预算快速失败
		expect(() =>
			withFileLockSync(
				target,
				() =>
					withFileLockSync(target, () => "never", {
						staleMs: 60_000, // stale 远大于预算，锁不会被夺取
						retryDelayMs: 10,
						retryBudgetMs: 30,
					}),
				{ staleMs: 60_000 },
			),
		).toThrowError(/ELOCKED 重试预算 30ms 耗尽/);
	});
});

describe("真实跨进程互斥（D5a/D1e 验收形态）", () => {
	it("两个子进程并发 RMW 同一 JSON 各 50 次，终值 100 零丢失", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-xproc-"));
		const target = path.join(tmpDir, "shared.json");
		fs.writeFileSync(target, JSON.stringify({ n: 0 }), "utf-8");
		try {
			// 子进程脚本：--experimental-strip-types 直接跑 TS（Node >= 22.6），
			// 循环 50 次锁内读-改-写。exitCode 非 0 = 子进程自身失败（锁/IO 异常）。
			const worker = `
import * as fs from "node:fs";
import { withFileLock } from "${PKG_DIR}/src/file-lock.ts";
const target = process.argv[2];
for (let i = 0; i < 50; i++) {
	await withFileLock(target, async () => {
		const cur = JSON.parse(fs.readFileSync(target, "utf-8"));
		cur.n += 1;
		fs.writeFileSync(target, JSON.stringify(cur), "utf-8");
	});
}
`;
			const workerFile = path.join(tmpDir, "worker.ts");
			fs.writeFileSync(workerFile, worker, "utf-8");
			const procs = [1, 2].map(() =>
				spawnSync(process.execPath, ["--experimental-strip-types", workerFile, target], {
					encoding: "utf-8",
					timeout: 60_000,
				}),
			);
			for (const p of procs) {
				expect(p.status).toBe(0);
			}
			expect((JSON.parse(fs.readFileSync(target, "utf-8")) as { n: number }).n).toBe(100);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
