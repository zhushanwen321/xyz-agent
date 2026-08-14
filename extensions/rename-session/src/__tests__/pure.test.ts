import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearConfigCache, getConfigPath } from "@zhushanwen/pi-llm-shared";

import {
	DEFAULT_RENAME_CONFIG,
	cleanTitle,
	countAssistantReplies,
	loadRenameConfig,
	normalizeRenameConfig,
	saveRenameConfig,
} from "../pure.js";

// ────────────────────────────────────────────────────
// countAssistantReplies（保留，不变）
// ────────────────────────────────────────────────────

describe("countAssistantReplies", () => {
	it("[user, assistant] → 1", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});

	it("[user, assistant, user, assistant] → 2", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
		];
		expect(countAssistantReplies(entries)).toBe(2);
	});

	it("过滤非 message（thinkingLevelChange / modelChange）→ 1", () => {
		const entries = [
			{ type: "thinkingLevelChange" },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "modelChange" },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});

	it("[user, assistant, toolResult entry] → 1（非 message entry 不计）", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "toolResult" },
		];
		expect(countAssistantReplies(entries)).toBe(1);
	});
});

// ────────────────────────────────────────────────────
// cleanTitle（收口自旧 extractTitle，输入改为 string：callLLM 已 extractText+trim）
// ────────────────────────────────────────────────────

describe("cleanTitle", () => {
	it("trim 首尾空白 → '修复登录 bug'", () => {
		expect(cleanTitle("  修复登录 bug  \n", 50)).toBe("修复登录 bug");
	});

	it("去引号 + markdown 强调 → '重构 API 层'", () => {
		expect(cleanTitle('"**重构 API 层**"', 50)).toBe("重构 API 层");
	});

	it("去中文引号 → '标题'", () => {
		expect(cleanTitle("“标题”", 50)).toBe("标题");
	});

	it("超长文本截断到 maxLength 码点", () => {
		const long = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题".repeat(3);
		const result = cleanTitle(long, 50);
		expect(Array.from(result).length).toBe(50);
	});

	it("空串 → ''", () => {
		expect(cleanTitle("", 50)).toBe("");
	});

	it("纯空白 → ''", () => {
		expect(cleanTitle("   \n\t  ", 50)).toBe("");
	});

	it("仅引号/markdown → ''（去完为空）", () => {
		expect(cleanTitle('""**``', 50)).toBe("");
	});

	it("maxLength 小于标题长度 → 截断", () => {
		expect(Array.from(cleanTitle("abcdefghij", 5)).length).toBe(5);
	});

	it("标题长度等于 maxLength → 原样", () => {
		expect(cleanTitle("abcde", 5)).toBe("abcde");
	});

	// ── B1: 内部空白归一化（多行标题不破坏 UI 渲染） ──

	it("B1: 多行标题（含 \n）→ 换行压成单空格", () => {
		expect(cleanTitle("重构API层\n更新文档", 50)).toBe("重构API层 更新文档");
	});

	it("B1: 混合空白（\r\n\t 多个）→ 全部压成单空格", () => {
		expect(cleanTitle("重构\tAPI\r\n层  更新", 50)).toBe("重构 API 层 更新");
	});

	it("B1: 首尾空白仍被 trim（归一化不影响首尾裁剪）", () => {
		expect(cleanTitle("  \n修复登录 bug\n  ", 50)).toBe("修复登录 bug");
	});
});

// ────────────────────────────────────────────────────
// DEFAULT_RENAME_CONFIG
// ────────────────────────────────────────────────────

describe("DEFAULT_RENAME_CONFIG", () => {
	it("默认值：enabled=false / model=scoped / maxTitleLength=50", () => {
		expect(DEFAULT_RENAME_CONFIG.enabled).toBe(false);
		expect(DEFAULT_RENAME_CONFIG.model).toEqual({ type: "scoped" });
		expect(DEFAULT_RENAME_CONFIG.maxTitleLength).toBe(50);
	});
});

// ────────────────────────────────────────────────────
// normalizeRenameConfig
// ────────────────────────────────────────────────────

describe("normalizeRenameConfig", () => {
	it("非对象（string/null/array）→ 全默认", () => {
		expect(normalizeRenameConfig("x")).toEqual(DEFAULT_RENAME_CONFIG);
		expect(normalizeRenameConfig(null)).toEqual(DEFAULT_RENAME_CONFIG);
		expect(normalizeRenameConfig([])).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("空对象 → 全默认", () => {
		expect(normalizeRenameConfig({})).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("合法完整配置 → 原样返回", () => {
		const cfg = { enabled: true, model: { type: "ref", ref: "deepseek/chat" }, maxTitleLength: 30 };
		expect(normalizeRenameConfig(cfg)).toEqual(cfg);
	});

	it("enabled 非 boolean → 回默认 false", () => {
		const r = normalizeRenameConfig({ enabled: "yes", model: { type: "available" } });
		expect(r.enabled).toBe(false);
		expect(r.model).toEqual({ type: "available" });
	});

	it("maxTitleLength 非正整数 → 回默认 50", () => {
		expect(normalizeRenameConfig({ maxTitleLength: 0 }).maxTitleLength).toBe(50);
		expect(normalizeRenameConfig({ maxTitleLength: -5 }).maxTitleLength).toBe(50);
		expect(normalizeRenameConfig({ maxTitleLength: 1.5 }).maxTitleLength).toBe(50);
		expect(normalizeRenameConfig({ maxTitleLength: "x" }).maxTitleLength).toBe(50);
	});

	it("model 非法（未知 type / 非 object）→ 回默认 scoped", () => {
		expect(normalizeRenameConfig({ model: { type: "unknown" } }).model).toEqual({ type: "scoped" });
		expect(normalizeRenameConfig({ model: "scoped" }).model).toEqual({ type: "scoped" });
	});

	it("model ref 缺 ref 字段 → 回默认", () => {
		expect(normalizeRenameConfig({ model: { type: "ref" } }).model).toEqual({ type: "scoped" });
		expect(normalizeRenameConfig({ model: { type: "ref", ref: 123 } }).model).toEqual({ type: "scoped" });
	});

	it("model fallback refs 非全 string → 回默认", () => {
		expect(
			normalizeRenameConfig({ model: { type: "fallback", refs: ["a/b", 1] } }).model,
		).toEqual({ type: "scoped" });
	});

	it("model 四形式各自合法时原样返回", () => {
		expect(normalizeRenameConfig({ model: { type: "ref", ref: "a/b" } }).model).toEqual({
			type: "ref",
			ref: "a/b",
		});
		expect(normalizeRenameConfig({ model: { type: "fallback", refs: ["a/b"] } }).model).toEqual({
			type: "fallback",
			refs: ["a/b"],
		});
		expect(normalizeRenameConfig({ model: { type: "available" } }).model).toEqual({
			type: "available",
		});
		expect(normalizeRenameConfig({ model: { type: "scoped" } }).model).toEqual({ type: "scoped" });
	});

	it("粒度容错：enabled 坏但 model/maxTitleLength 合法时各自独立处理", () => {
		const r = normalizeRenameConfig({
			enabled: "bad",
			model: { type: "available" },
			maxTitleLength: 20,
		});
		expect(r).toEqual({ enabled: false, model: { type: "available" }, maxTitleLength: 20 });
	});
});

// ────────────────────────────────────────────────────
// loadRenameConfig / saveRenameConfig（需 PI_CODING_AGENT_DIR 隔离到临时目录）
// ────────────────────────────────────────────────────

describe("loadRenameConfig / saveRenameConfig", () => {
	let tmpAgentDir: string;
	let origEnv: string | undefined;

	beforeEach(() => {
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-cfg-"));
		origEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		clearConfigCache();
	});

	afterEach(() => {
		if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = origEnv;
		clearConfigCache();
		fs.rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("配置路径 = <agentDir>/config/rename-session-ext-config.json（走 getAgentDir，实例隔离）", () => {
		expect(getConfigPath("rename-session")).toBe(
			path.join(tmpAgentDir, "config", "rename-session-ext-config.json"),
		);
	});

	it("文件不存在 → 返回默认配置（不抛错）", () => {
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("saveRenameConfig 后 loadRenameConfig 读回（跨缓存清空）", () => {
		const cfg = { enabled: true, model: { type: "ref", ref: "deepseek/chat" }, maxTitleLength: 30 };
		const saveResult = saveRenameConfig(cfg);
		expect(saveResult.success).toBe(true);
		clearConfigCache();
		expect(loadRenameConfig()).toEqual(cfg);
	});

	it("saveRenameConfig 实际落盘到隔离目录（不写 ~/.pi/agent）", () => {
		saveRenameConfig({ enabled: true, model: { type: "scoped" }, maxTitleLength: 50 });
		const filePath = path.join(tmpAgentDir, "config", "rename-session-ext-config.json");
		expect(fs.existsSync(filePath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		expect(raw.enabled).toBe(true);
	});

	it("坏 JSON 文件 → 返回默认（onWarning 不阻断）", () => {
		fs.mkdirSync(path.join(tmpAgentDir, "config"), { recursive: true });
		fs.writeFileSync(path.join(tmpAgentDir, "config", "rename-session-ext-config.json"), "{ bad json");
		expect(loadRenameConfig()).toEqual(DEFAULT_RENAME_CONFIG);
	});

	it("on → off 切换 enabled 字段落盘", () => {
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: true });
		clearConfigCache();
		expect(loadRenameConfig().enabled).toBe(true);
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: false });
		clearConfigCache();
		expect(loadRenameConfig().enabled).toBe(false);
	});

	// ── E3 旧开关一次性迁移（TC5-7：旧 auto-rename-enabled 文件 → 新 config enabled 字段） ──

	it("TC5: E3 迁移触发（旧开关文件存在 + 新配置不存在 → enabled=true 写入新配置 + 删旧文件）", () => {
		const legacyPath = path.join(tmpAgentDir, "auto-rename-enabled");
		fs.writeFileSync(legacyPath, "");

		const cfg = loadRenameConfig();

		expect(cfg.enabled).toBe(true);
		// 新配置已落盘且 enabled=true
		const newConfigPath = path.join(tmpAgentDir, "config", "rename-session-ext-config.json");
		expect(fs.existsSync(newConfigPath)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(newConfigPath, "utf-8"));
		expect(raw.enabled).toBe(true);
		// 旧开关文件被删（R1 mitigation：先写新配置成功再 unlink）
		expect(fs.existsSync(legacyPath)).toBe(false);
	});

	it("TC6: E3 不迁移（新配置已存在 + 旧开关存在 → enabled 按新配置，旧文件不动）", () => {
		const legacyPath = path.join(tmpAgentDir, "auto-rename-enabled");
		// 先写新配置 enabled=false，再放旧开关文件
		saveRenameConfig({ ...DEFAULT_RENAME_CONFIG, enabled: false });
		fs.writeFileSync(legacyPath, "");
		clearConfigCache();

		const cfg = loadRenameConfig();

		expect(cfg.enabled).toBe(false);
		// 旧文件未被删、未被改写
		expect(fs.existsSync(legacyPath)).toBe(true);
	});

	it("TC7: E3 不迁移（无旧开关 + 无新配置 → enabled 默认 false，不创建任何文件）", () => {
		const cfg = loadRenameConfig();
		expect(cfg.enabled).toBe(false);
		expect(fs.existsSync(path.join(tmpAgentDir, "config", "rename-session-ext-config.json"))).toBe(false);
		expect(fs.existsSync(path.join(tmpAgentDir, "auto-rename-enabled"))).toBe(false);
	});
});
