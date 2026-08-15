/**
 * harness 断言纯函数单测（T1）。
 *
 * 运行：cd extensions/rename-session && npx vitest run e2e/harness.test.mjs
 * （vitest.config.ts include 是精确文件名 "e2e/harness.test.mjs"，既有 src/__tests__ 不受影响；
 *  场景脚本 run-aN.mjs 不在 CI 内——glob 写法会误导未来把 scenarios.test.mjs 收进 CI）
 */

import { describe, expect, it } from "vitest";

import {
	HarnessError,
	assertTitleGuards,
	classifyFailure,
	extractLastStopAssistant,
	parseLogMessages,
	rebuildPreview,
} from "./harness.mjs";

// ──────────────────────── rebuildPreview（与 llm.ts previewText 同构三分支） ────────────────────────

describe("rebuildPreview 三分支边界", () => {
	it("≤300 全文（恰好 300 含边界）", () => {
		const s300 = "a".repeat(300);
		expect(rebuildPreview("short")).toBe("short");
		expect(rebuildPreview("")).toBe("");
		expect(rebuildPreview(s300)).toBe(s300); // 恰好 300 走全文分支
	});

	it("301 触发截断：head 200 + 字面 … + tail 100（总长 301）", () => {
		const s301 = "a".repeat(301);
		const out = rebuildPreview(s301);
		expect(out.length).toBe(200 + 1 + 100);
		expect(out.slice(0, 200)).toBe("a".repeat(200));
		expect(out.slice(201)).toBe("a".repeat(100));
		expect(out[200]).toBe("…");
	});

	it("超长内容 head/tail 各取所需", () => {
		const s1000 = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join("");
		const out = rebuildPreview(s1000);
		expect(out.slice(0, 200)).toBe(s1000.slice(0, 200));
		expect(out.slice(201)).toBe(s1000.slice(-100));
		expect(out[200]).toBe("…");
	});

	it("码点截断不劈开代理对：emoji 在 head/tail 边界完整保留（无孤立代理）", () => {
		const emoji = "😀"; // U+1F600，占 2 个 UTF-16 码元 = 1 码点
		// tail 边界：301 码点（300 ASCII + emoji）→ tail 100 = 99 个 a + 完整 emoji
		const out1 = rebuildPreview("a".repeat(300) + emoji);
		expect(out1).toBe("a".repeat(200) + "…" + "a".repeat(99) + emoji);
		// head 边界：第 200 码点是 emoji → head 末尾完整保留
		// （UTF-16 码元实现会把该 emoji 劈成孤立高代理——本用例锁定码点实现）
		const head = "a".repeat(199) + emoji; // 200 码点
		const out2 = rebuildPreview(head + "b".repeat(200)); // 400 码点
		const chars2 = Array.from(out2);
		expect(chars2).toHaveLength(200 + 1 + 100);
		expect(chars2.slice(0, 200).join("")).toBe(head);
		expect(chars2[200]).toBe("…");
		expect(chars2.slice(201).join("")).toBe("b".repeat(100));
		// 无孤立代理：Array.from 后不存在落在代理区间的码点（代理都成对包含在星面码点内）
		const hasLoneSurrogate = (s) =>
			Array.from(s).some((ch) => {
				const c = ch.codePointAt(0);
				return c >= 0xd800 && c <= 0xdfff;
			});
		expect(hasLoneSurrogate(out1)).toBe(false);
		expect(hasLoneSurrogate(out2)).toBe(false);
	});

	it("非 string 输入抛 TypeError", () => {
		expect(() => rebuildPreview(123)).toThrow(TypeError);
	});
});

// ──────────────────────── parseLogMessages ────────────────────────

describe("parseLogMessages", () => {
	const payload = JSON.stringify([
		{ role: "user", text: "列出当前目录的 ts 文件并统计行数" },
		{ role: "assistant", text: "共 12 个 ts 文件" },
		{ role: "user", text: "根据以上对话，为这个会话生成一个 slug 式标题。" },
	]);

	it("解析标准 LLM request 日志行", () => {
		const line = `[rename-session] t=2026-08-15T03:41:33.287Z LLM request messages: ${payload}`;
		const msgs = parseLogMessages(line);
		expect(msgs).toHaveLength(3);
		expect(msgs[0]).toEqual({ role: "user", text: "列出当前目录的 ts 文件并统计行数" });
		expect(msgs[1].role).toBe("assistant");
		expect(msgs[2].role).toBe("user");
	});

	it("非 LLM request 行返回 null", () => {
		expect(parseLogMessages("[rename-session] t=2026-08-15T03:41:33.287Z skip: count=2")).toBeNull();
		expect(parseLogMessages("[rename-session] rename with model xiaomi-token-plan-cn/mimo-v2.5-pro")).toBeNull();
		expect(parseLogMessages("")).toBeNull();
		expect(parseLogMessages(null)).toBeNull();
	});

	it("JSON 损坏返回 null", () => {
		const line = "[rename-session] t=... LLM request messages: [{role: user,"; // 截断
		expect(parseLogMessages(line)).toBeNull();
	});

	it("成员缺字段抛 HarnessError（防御日志格式漂移）", () => {
		const bad = JSON.stringify([{ role: "user" }]);
		expect(() => parseLogMessages(`x LLM request messages: ${bad}`)).toThrow(HarnessError);
	});
});

// ──────────────────────── extractLastStopAssistant ────────────────────────

/** 造一条 message entry 行。 */
function msgLine(role, stopReason, blocksOrString) {
	return JSON.stringify({
		type: "message",
		id: Math.random().toString(36).slice(2),
		message: { role, stopReason, content: blocksOrString },
	});
}

describe("extractLastStopAssistant", () => {
	it("混合 stopReason 取最后一条 stop 的 assistant", () => {
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "x" }),
			msgLine("user", undefined, [{ type: "text", text: "q1" }]),
			msgLine("assistant", "toolUse", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
			msgLine("toolResult", undefined, [{ type: "text", text: "out" }]),
			msgLine("assistant", "stop", [{ type: "thinking", thinking: "..." }, { type: "text", text: "第一轮" }]),
			msgLine("user", undefined, [{ type: "text", text: "q2" }]),
			msgLine("assistant", "error", [{ type: "text", text: "err" }]),
			msgLine("assistant", "stop", [{ type: "text", text: "最终" }, { type: "text", text: "回复" }]),
		];
		expect(extractLastStopAssistant(lines)).toBe("最终 回复");
	});

	it("thinking/toolCall blocks 过滤、多 text 用空格 join（与 extractFinalText 同构）", () => {
		const lines = [
			msgLine("assistant", "stop", [
				{ type: "thinking", thinking: "推理" },
				{ type: "text", text: "A" },
				{ type: "toolCall", id: "t", name: "bash", arguments: {} },
				{ type: "text", text: "B" },
			]),
		];
		expect(extractLastStopAssistant(lines)).toBe("A B");
	});

	it("无 stop assistant 返回 null", () => {
		expect(extractLastStopAssistant([msgLine("assistant", "toolUse", [{ type: "text", text: "x" }])])).toBeNull();
		expect(extractLastStopAssistant([msgLine("user", undefined, [{ type: "text", text: "x" }])])).toBeNull();
		expect(extractLastStopAssistant([])).toBeNull();
	});

	it("content 非 blocks 数组（string）按无文本处理——与 extractFinalText 同构锁定", () => {
		// extractFinalText 对 string content 返回 ""；同构实现必须一致（不自行加 string 分支）
		expect(extractLastStopAssistant([msgLine("assistant", "stop", "直接字符串")])).toBe("");
	});

	it("坏 JSON 行跳过不整体失败", () => {
		const lines = ["{broken", msgLine("assistant", "stop", [{ type: "text", text: "ok" }])];
		expect(extractLastStopAssistant(lines)).toBe("ok");
	});

	it("非数组入参抛 TypeError", () => {
		expect(() => extractLastStopAssistant("not-array")).toThrow(TypeError);
	});
});

// ──────────────────────── assertTitleGuards（两层分离） ────────────────────────

describe("assertTitleGuards", () => {
	it("合规标题通过（中文词组 / 英文 kebab）", () => {
		expect(assertTitleGuards("修复登录超时")).toEqual({ ok: true, violations: [] });
		expect(assertTitleGuards("refactor-config-loader")).toEqual({ ok: true, violations: [] });
		expect(assertTitleGuards("fix-login-timeout")).toEqual({ ok: true, violations: [] });
	});

	it("风格层：中文代词开头", () => {
		const r = assertTitleGuards("我来修复登录超时");
		expect(r.ok).toBe(false);
		expect(r.violations).toHaveLength(1);
		expect(r.violations[0]).toMatchObject({ layer: "style", rule: "no-pronoun-start" });
	});

	it("风格层：英文代词开头（This/We/I 词首）且不误伤普通词", () => {
		expect(assertTitleGuards("this-session-is-about-fixing-bugs").violations.map((v) => v.rule)).toContain(
			"no-pronoun-start",
		);
		expect(assertTitleGuards("we-should-refactor").violations.map((v) => v.rule)).toContain("no-pronoun-start");
		expect(assertTitleGuards("i-fixed-the-bug").violations.map((v) => v.rule)).toContain("no-pronoun-start");
		// 前缀拼接词不受影响（\b 语义）
		expect(assertTitleGuards("widget-dashboard").ok).toBe(true);
		expect(assertTitleGuards("ios-app-icon").ok).toBe(true);
	});

	it("风格层：时态助词结尾（了/过/中）", () => {
		for (const t of ["修复完成了", "测试跑过", "重构进行中"]) {
			const r = assertTitleGuards(t);
			expect(r.ok).toBe(false);
			expect(r.violations.map((v) => v.rule)).toContain("no-tense-ending");
			expect(r.violations[0].layer).toBe("style");
		}
		// 组合形态：代词开头 + 时态结尾，两条风格违规并存
		const r = assertTitleGuards("我帮你修复了");
		expect(r.violations.map((v) => v.rule).sort()).toEqual(["no-pronoun-start", "no-tense-ending"]);
		expect(r.violations.every((v) => v.layer === "style")).toBe(true);
	});

	it("风格层：纯英文须小写 kebab-case（spec 正则 ^[a-z0-9]+(-[a-z0-9]+)*$，点号不算合规）", () => {
		const r = assertTitleGuards("Refactor Config Loader");
		expect(r.ok).toBe(false);
		expect(r.violations.map((v) => v.rule)).toContain("english-kebab-case");
		// 含点号的版本号形态不匹配 spec 正则（风格层遵 spec；cleanTitle 只保证不清中间点，两回事）
		expect(assertTitleGuards("v1.2.3-release").violations.map((v) => v.rule)).toContain("english-kebab-case");
		// 混合中文跳过 kebab 检查（语言跟随人工抽查范畴）
		expect(assertTitleGuards("修复 Fix Login").ok).toBe(true);
	});

	it("防回归层：≤50 码点（恰好 50 通过，51 违规；码点而非 UTF-16 长度）", () => {
		expect(assertTitleGuards("修".repeat(50)).ok).toBe(true);
		expect(assertTitleGuards("修".repeat(51)).violations.map((v) => v.rule)).toContain("max-length");
		// emoji 占 2 码元 1 码点：50 个 emoji = 50 码点 = 100 码元，应通过
		expect(assertTitleGuards("😀".repeat(50)).ok).toBe(true);
		// maxCodePoints 可参数化（对齐配置非默认值的场景）
		expect(assertTitleGuards("修".repeat(11), { maxCodePoints: 10 }).ok).toBe(false);
	});

	it("防回归层：句尾标点（断言集 = cleanTitle 清洗集）", () => {
		for (const t of ["修复登录超时。", "修复登录超时！", "修复超时？", "修复超时：", "修复超时，"]) {
			const r = assertTitleGuards(t);
			expect(r.ok).toBe(false);
			expect(r.violations).toHaveLength(1);
			expect(r.violations[0]).toMatchObject({ layer: "regression", rule: "no-trailing-punct" });
		}
		// 英文标题带句尾标点：kebab 与 trailing-punct 双违规并存（spec 正则不含标点，记录交互）
		const r = assertTitleGuards("fix-bug.");
		expect(r.violations.map((v) => v.rule).sort()).toEqual(["english-kebab-case", "no-trailing-punct"]);
	});

	it("空/非字符串标题归防回归层", () => {
		expect(assertTitleGuards("").violations[0].layer).toBe("regression");
		expect(assertTitleGuards(undefined).ok).toBe(false);
	});
});

// ──────────────────────── classifyFailure（四分类） ────────────────────────

describe("classifyFailure", () => {
	it("HarnessError kind 直通四分类", () => {
		expect(classifyFailure(new HarnessError("assertion", "x"))).toBe("assertion");
		expect(classifyFailure(new HarnessError("timeout", "x"))).toBe("timeout");
		expect(classifyFailure(new HarnessError("pi-crash", "x"))).toBe("pi-crash");
		expect(classifyFailure(new HarnessError("api-error", "x"))).toBe("api-error");
	});

	it("rpc kind：pi 已死归 pi-crash，否则归 assertion", () => {
		expect(classifyFailure(new HarnessError("rpc", "x", { piAlive: false }))).toBe("pi-crash");
		expect(classifyFailure(new HarnessError("rpc", "x", { piAlive: true }))).toBe("assertion");
	});

	it("AssertionError → assertion", () => {
		try {
			expect(1).toBe(2);
		} catch (e) {
			expect(classifyFailure(e)).toBe("assertion");
		}
	});

	it("超时特征 → timeout", () => {
		const e = new Error("waitFor(agent_settled) timed out after 60000ms");
		expect(classifyFailure(e)).toBe("timeout");
		const e2 = new Error("x");
		e2.name = "TimeoutError";
		expect(classifyFailure(e2)).toBe("timeout");
	});

	it("网络/API 特征 → api-error", () => {
		expect(classifyFailure(new Error("Connection error."))).toBe("api-error");
		expect(classifyFailure(new Error("fetch failed"))).toBe("api-error");
		const e401 = new Error("Request failed with status code 401");
		expect(classifyFailure(e401)).toBe("api-error");
	});

	it("无法识别的裸错误兜底 assertion（不吞失败）", () => {
		expect(classifyFailure(new Error("随便什么错"))).toBe("assertion");
		expect(classifyFailure("not even an error")).toBe("assertion");
	});
});
