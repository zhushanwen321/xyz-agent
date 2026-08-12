import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache, getConfigPath, loadConfig, saveConfig } from "../config.ts";

// node:fs 的 ESM namespace 不可配置，vi.spyOn 对具名导出失效（vitest 限制）。
// 用 vi.mock 包装 readFileSync/renameSync（默认走 actual，个别 test override），
// 其他 fs 操作（writeFileSync/existsSync/statSync/mkdirSync...）原样透传 actual。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("node:fs");
	return {
		...actual,
		readFileSync: vi.fn(actual.readFileSync),
		renameSync: vi.fn(actual.renameSync),
	};
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "llm-shared-cfg-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	clearConfigCache();
	// 预创建 config/ 子目录（loadConfig fixture 直接 writeFileSync 需要目录已存在；
	// saveConfig 内部会自己 mkdir，但 loadConfig fixture 不会）
	mkdirSync(join(dir, "config"), { recursive: true });
});

afterEach(() => {
	vi.mocked(fs.readFileSync).mockClear();
	vi.mocked(fs.renameSync).mockClear();
	rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** 测试用 normalize：对象含 a → 原样，否则默认 {a:0}。 */
const normalize = (raw: unknown): { a: number } => {
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "a" in raw) {
		return { a: (raw as { a: number }).a };
	}
	return { a: 0 };
};

describe("getConfigPath", () => {
	it("TC17 走 getAgentDir（PI_CODING_AGENT_DIR 覆盖生效）", () => {
		expect(getConfigPath("rename-session")).toBe(join(dir, "config", "rename-session.json"));
	});
});

describe("loadConfig", () => {
	it("TC14 文件存在 → 解析 + normalize", () => {
		writeFileSync(join(dir, "config", "test.json"), JSON.stringify({ a: 1 }));
		expect(loadConfig("test", { a: 0 }, normalize)).toEqual({ a: 1 });
	});

	it("TC14 mtime+size 不变 → 命中缓存（readFileSync 只调一次）", () => {
		writeFileSync(join(dir, "config", "test.json"), JSON.stringify({ a: 1 }));
		vi.mocked(fs.readFileSync).mockClear();

		const r1 = loadConfig("test", { a: 0 }, normalize);
		const r2 = loadConfig("test", { a: 0 }, normalize);

		expect(r1).toEqual({ a: 1 });
		expect(r2).toEqual({ a: 1 });
		// statSync 命中缓存，readFileSync 只调一次
		expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledTimes(1);
	});

	it("TC14 缓存返回值是深拷贝（改返回值不污染缓存）", () => {
		writeFileSync(join(dir, "config", "test.json"), JSON.stringify({ a: 1 }));
		const r1 = loadConfig("test", { a: 0 }, normalize);
		r1.a = 999; // 篡改返回值
		const r2 = loadConfig("test", { a: 0 }, normalize);
		expect(r2).toEqual({ a: 1 }); // 缓存未被污染
	});

	it("TC15 文件不存在 → defaults", () => {
		expect(loadConfig("missing", { a: 0 }, normalize)).toEqual({ a: 0 });
	});

	it("TC15 坏 JSON → defaults + onWarning 回调", () => {
		writeFileSync(join(dir, "config", "bad.json"), "{not json");
		const onWarning = vi.fn();
		expect(loadConfig("bad", { a: 0 }, normalize, onWarning)).toEqual({ a: 0 });
		expect(onWarning).toHaveBeenCalledTimes(1);
	});
});

describe("saveConfig", () => {
	it("TC16 原子写：文件落盘 + 内容正确 + 无 tmp 残留", () => {
		const result = saveConfig("test", { b: 2 });
		expect(result.success).toBe(true);

		const cfgPath = join(dir, "config", "test.json");
		expect(existsSync(cfgPath)).toBe(true);
		expect(JSON.parse(readFileSync(cfgPath, "utf-8"))).toEqual({ b: 2 });
		expect(existsSync(`${cfgPath}.tmp`)).toBe(false); // 无 tmp 残留
	});

	it("TC16 文件 mode 0o600", () => {
		saveConfig("test", { b: 2 });
		const cfgPath = join(dir, "config", "test.json");
		const mode = statSync(cfgPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("TC16 写后 loadConfig 命中缓存返回新值（写后读竞态覆盖）", () => {
		saveConfig("test", { a: 5 });
		// saveConfig 写后已更新缓存，loadConfig 直接命中（不重读盘）
		vi.mocked(fs.readFileSync).mockClear();
		const loaded = loadConfig("test", { a: 0 }, normalize);
		expect(loaded).toEqual({ a: 5 });
		expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
	});

	it("review RK3: renameSync throw → {success:false} + tmp 被清理", () => {
		// mock renameSync 抛 EPERM，模拟 rename 失败（writeFileSync 已创建 tmp）
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("EPERM: operation not permitted, rename");
		});

		const result = saveConfig("fail", { x: 1 });

		expect(result.success).toBe(false);
		expect(result.error).toContain("EPERM");
		// tmp 文件被 catch 块的 unlinkSync 清理
		expect(existsSync(join(dir, "config", "fail.json.tmp"))).toBe(false);
		// 目标文件未被创建（rename 失败）
		expect(existsSync(join(dir, "config", "fail.json"))).toBe(false);
	});

	it("saveConfig 多次写同文件 → 每次成功 + 最新内容", () => {
		expect(saveConfig("test", { v: 1 }).success).toBe(true);
		expect(saveConfig("test", { v: 2 }).success).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "config", "test.json"), "utf-8"))).toEqual({ v: 2 });
	});
});
