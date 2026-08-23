// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/fingerprint.test.ts
//
// 指纹纯函数层测试：stableStringify 稳定性 / hash 长度 / extractSystem 四口径 /
// sentToolsOf / diffFingerprints / buildProbeEntry 的 baseline-全量、normal-增量、无变化-null。

import { describe, expect, it } from "vitest";

import {
	buildProbeEntry,
	diffFingerprints,
	extractSystem,
	HASH_LEN,
	hashOf,
	sentToolsOf,
	stableStringify,
	type Fingerprints,
} from "../fingerprint";

const fp = (over: Partial<Fingerprints> = {}): Fingerprints => ({
	spFull: "a".repeat(HASH_LEN),
	toolsSent: "b".repeat(HASH_LEN),
	contextFiles: "c".repeat(HASH_LEN),
	skills: "d".repeat(HASH_LEN),
	toolsList: "e".repeat(HASH_LEN),
	toolsReg: "f".repeat(HASH_LEN),
	append: "0".repeat(HASH_LEN),
	guidelines: "1".repeat(HASH_LEN),
	customPrompt: "2".repeat(HASH_LEN),
	...over,
});

describe("stableStringify", () => {
	it("key 顺序不同输出相同（防假变化的核心保证）", () => {
		expect(stableStringify({ a: 1, b: { d: 4, c: 3 } })).toBe(stableStringify({ b: { c: 3, d: 4 }, a: 1 }));
	});

	it("undefined 归一为 null", () => {
		expect(stableStringify(undefined)).toBe("null");
		expect(stableStringify({ x: undefined })).toBe(stableStringify({ x: null }));
	});

	it("数组保序、原始值直译", () => {
		expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
		expect(stableStringify("s")).toBe('"s"');
		expect(stableStringify(3)).toBe("3");
	});
});

describe("hashOf", () => {
	it(`hash 为 ${HASH_LEN} hex 字符且同输入同输出`, () => {
		const h = hashOf({ a: 1 });
		expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(hashOf({ a: 1 })).toBe(h);
		expect(hashOf({ b: 1 })).not.toBe(h);
	});

	it("key 顺序不影响 hash", () => {
		expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
	});
});

describe("extractSystem（payload 四口径）", () => {
	it("OpenAI 兼容：messages 内 role=system", () => {
		expect(extractSystem({ messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] })).toEqual([
			{ role: "system", content: "s" },
		]);
	});

	it("OpenAI 兼容：role=developer（pi useDeveloperRole 分支，实测命中）", () => {
		expect(extractSystem({ messages: [{ role: "developer", content: "s" }] })).toEqual([
			{ role: "developer", content: "s" },
		]);
	});

	it("Anthropic：顶层 system 数组", () => {
		expect(extractSystem({ system: [{ type: "text", text: "s" }], messages: [] })).toEqual([
			{ type: "text", text: "s" },
		]);
	});

	it("Google：顶层 systemInstruction 对象", () => {
		expect(extractSystem({ systemInstruction: { role: "system", parts: [] } })).toEqual({
			role: "system",
			parts: [],
		});
	});

	it("无 system 内容返回 null", () => {
		expect(extractSystem({ messages: [{ role: "user", content: "u" }] })).toBeNull();
		expect(extractSystem(null)).toBeNull();
		expect(extractSystem("str")).toBeNull();
	});
});

describe("sentToolsOf", () => {
	it("有 tools 返回数组，缺失返回 null", () => {
		expect(sentToolsOf({ tools: [{ name: "read" }] })).toEqual([{ name: "read" }]);
		expect(sentToolsOf({})).toBeNull();
		expect(sentToolsOf(null)).toBeNull();
	});
});

describe("diffFingerprints / buildProbeEntry", () => {
	it("diff 只报变化项", () => {
		expect(diffFingerprints(fp({ contextFiles: "x".repeat(HASH_LEN) }), fp())).toEqual(["contextFiles"]);
		expect(diffFingerprints(fp(), null)).toEqual([]);
	});

	it("baseline：全量 hash + changed ['*'] + cwd + startReason", () => {
		const cur = fp();
		const e = buildProbeEntry(cur, null, { seq: 1, needsBaseline: true, startReason: "startup", cwd: "/w" });
		expect(e).toEqual({
			v: 2,
			seq: 1,
			baseline: true,
			startReason: "startup",
			cwd: "/w",
			changed: ["*"],
			h: cur,
		});
	});

	it("normal：只存变化项（增量），不带 cwd", () => {
		const last = fp();
		const cur = fp({ contextFiles: "x".repeat(HASH_LEN) });
		const e = buildProbeEntry(cur, last, { seq: 3, needsBaseline: false, startReason: null, cwd: "/w" });
		expect(e).toEqual({
			v: 2,
			seq: 3,
			changed: ["contextFiles"],
			h: { contextFiles: "x".repeat(HASH_LEN) },
		});
	});

	it("无变化返回 null（不写 entry）", () => {
		expect(buildProbeEntry(fp(), fp(), { seq: 2, needsBaseline: false, startReason: null, cwd: "/w" })).toBeNull();
	});
});
