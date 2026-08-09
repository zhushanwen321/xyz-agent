// src/__tests__/answer-codec.test.ts
// encodeAnswer 单向序列化 round-trip 测试（TC-09）。
// 反向验证用 @xyz-agent/extension-protocol 的解码 helper（getAskUserAnswer / getAskUserOther）
// ——该 helper 是 proto answers 格式的唯一解码 SSOT，encode 输出必须与其字节级对齐。
import { getAskUserAnswer, getAskUserOther } from "@xyz-agent/extension-protocol";
import { describe, expect, it } from "vitest";

import { encodeAnswer } from "../answer-codec";

describe("encodeAnswer", () => {
	it("single-select: 主 key 写选中 label，other=null 不写 __other；getAskUserAnswer 解码得 string", () => {
		const answers = encodeAnswer({ selected: ["A"], other: null }, { key: "db", multiSelect: false });
		expect(answers).toEqual({ db: "A" });
		expect(getAskUserAnswer(answers, { question: "db", options: [{ label: "A" }] })).toBe("A");
	});

	it("multi-select: 主 key 写 JSON.stringify(selected)；getAskUserAnswer 解码得 string[]", () => {
		const answers = encodeAnswer({ selected: ["A", "B"], other: null }, { key: "lang", multiSelect: true });
		expect(answers).toEqual({ lang: '["A","B"]' });
		expect(getAskUserAnswer(answers, { question: "lang", multiSelect: true })).toEqual(["A", "B"]);
	});

	it("selected 空 + other 有值: 只写 ${key}__other 不写主 key；getAskUserOther 解码得文本", () => {
		const answers = encodeAnswer({ selected: [], other: "foo" }, { key: "db", multiSelect: false });
		expect(answers).toEqual({ db__other: "foo" });
		expect(getAskUserOther(answers, { question: "db" })).toBe("foo");
	});

	it("selected 空 + other null/空串: 返回 {}（未答，调用方不写入）", () => {
		expect(encodeAnswer({ selected: [], other: null }, { key: "db", multiSelect: false })).toEqual({});
		expect(encodeAnswer({ selected: [], other: "" }, { key: "db", multiSelect: true })).toEqual({});
	});

	it("selected 与 other 同时有值: 主 key + __other 都写；两个 helper 各自解码", () => {
		const answers = encodeAnswer(
			{ selected: ["A"], other: "custom" },
			{ key: "db", multiSelect: false },
		);
		expect(answers).toEqual({ db: "A", db__other: "custom" });
		expect(getAskUserAnswer(answers, { question: "db", options: [{ label: "A" }] })).toBe("A");
		expect(getAskUserOther(answers, { question: "db" })).toBe("custom");
	});
});
