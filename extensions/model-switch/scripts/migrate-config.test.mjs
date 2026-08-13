/**
 * migrate-config.mjs 单元测试（幂等迁移语义）
 *
 * 用真实 fs + 临时 agentDir，直接 import 脚本导出的函数（不 spawn 子进程）。
 * 运行命令：npx vitest run scripts/migrate-config.test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateConfig, migrateFile, resolveAgentDir } from "./migrate-config.mjs";

let agentDir;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-ms-migrate-test-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("resolveAgentDir", () => {
	it("优先 argv[2]，其次 PI_CODING_AGENT_DIR，最后默认 ~/.pi/agent", () => {
		expect(resolveAgentDir("/a/b", {})).toBe("/a/b");
		expect(resolveAgentDir(undefined, { PI_CODING_AGENT_DIR: "/env/dir" })).toBe("/env/dir");
		expect(resolveAgentDir(undefined, {})).toBe(join(process.env.HOME, ".pi", "agent"));
	});
});

describe("migrateFile", () => {
	it("旧存在、新不存在 → 搬移 + 旧路径消失", () => {
		const oldPath = join(agentDir, "model-policy.json");
		writeFileSync(oldPath, JSON.stringify({ version: 2 }), "utf-8");

		const result = migrateFile(agentDir, "model-policy.json", join("config", "model-switch.json"));

		expect(result.migrated).toBe(true);
		expect(existsSync(oldPath)).toBe(false);
		const newPath = join(agentDir, "config", "model-switch.json");
		expect(existsSync(newPath)).toBe(true);
		expect(JSON.parse(readFileSync(newPath, "utf-8")).version).toBe(2);
	});

	it("新已存在 → 不覆盖新文件，保留旧文件（不删，防数据丢失）", () => {
		const oldPath = join(agentDir, "model-policy.json");
		const newPath = join(agentDir, "config", "model-switch.json");
		mkdirSync(join(agentDir, "config"), { recursive: true });
		writeFileSync(oldPath, JSON.stringify({ version: 1 }), "utf-8");
		writeFileSync(newPath, JSON.stringify({ version: 2 }), "utf-8");

		const result = migrateFile(agentDir, "model-policy.json", join("config", "model-switch.json"));

		expect(result.migrated).toBe(false);
		expect(existsSync(oldPath)).toBe(true);
		expect(JSON.parse(readFileSync(newPath, "utf-8")).version).toBe(2);
	});

	it("旧不存在 → noop（幂等，重复执行安全）", () => {
		const result = migrateFile(agentDir, "model-policy.json", join("config", "model-switch.json"));

		expect(result.migrated).toBe(false);
		expect(existsSync(join(agentDir, "config", "model-switch.json"))).toBe(false);
	});

	it("重复执行第二次 noop（幂等）", () => {
		const oldPath = join(agentDir, "model-policy.json");
		writeFileSync(oldPath, "{}", "utf-8");

		migrateFile(agentDir, "model-policy.json", join("config", "model-switch.json"));
		const second = migrateFile(agentDir, "model-policy.json", join("config", "model-switch.json"));

		expect(second.migrated).toBe(false);
		expect(existsSync(join(agentDir, "config", "model-switch.json"))).toBe(true);
	});

	it("config 目录不存在时自动创建", () => {
		const oldPath = join(agentDir, "model-policy.json");
		writeFileSync(oldPath, "{}", "utf-8");

		migrateFile(agentDir, "model-policy.json", join("config", "model-switch.json"));

		expect(existsSync(join(agentDir, "config", "model-switch.json"))).toBe(true);
	});
});

describe("migrateConfig (model-switch)", () => {
	it("完整迁移 model-policy.json → config/model-switch.json", () => {
		const oldPath = join(agentDir, "model-policy.json");
		writeFileSync(oldPath, JSON.stringify({ version: 2 }), "utf-8");

		migrateConfig(agentDir);

		expect(existsSync(oldPath)).toBe(false);
		expect(existsSync(join(agentDir, "config", "model-switch.json"))).toBe(true);
	});
});
