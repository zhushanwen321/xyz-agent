// src/__tests__/answer-format.test.ts
//
// answer-format.ts 独立单元测试。
// 覆盖审查 S5 发现的覆盖盲区：
//   - parseAnswerParts 子串误匹配（"A" 不应命中 "AB"）
//   - formatAnswer 空 parts → null
//   - comment 分隔符边界

import { describe, expect, it } from "vitest";

import { formatAnswer, parseAnswerParts } from "../answer-format.js";
import { ANSWER_COMMENT_SEPARATOR } from "../types.js";

describe("formatAnswer", () => {
	it("returns null for empty parts (unanswered)", () => {
		expect(formatAnswer([])).toBeNull();
	});

	it("comment-only: empty parts + comment → separator-prefixed comment (MF-1)", () => {
		// parts 空但有 comment = allowComment 的「无选项适用但想说明原因」场景，
		// 不能返回 null（会把评论一起丢弃）；以 ANSWER_COMMENT_SEPARATOR 开头保持往返可解析
		expect(formatAnswer([], "some comment")).toBe(`${ANSWER_COMMENT_SEPARATOR}some comment`);
	});

	it("joins single part without separator", () => {
		expect(formatAnswer(["yes"])).toBe("yes");
	});

	it("joins multiple parts with ', '", () => {
		expect(formatAnswer(["A", "B", "C"])).toBe("A, B, C");
	});

	it("appends comment with ANSWER_COMMENT_SEPARATOR", () => {
		const result = formatAnswer(["A", "B"], "my comment");
		expect(result).toBe(`A, B${ANSWER_COMMENT_SEPARATOR}my comment`);
	});

	it("handles null comment (no separator appended)", () => {
		expect(formatAnswer(["A"], null)).toBe("A");
	});
});

describe("parseAnswerParts", () => {
	it("extracts selected labels by exact match", () => {
		const labels = ["yes", "no", "maybe"];
		const result = parseAnswerParts("yes, no", labels);
		expect(result.selected).toEqual(["yes", "no"]);
		expect(result.comment).toBeUndefined();
	});

	// S5 核心：防子串误匹配——"A" 不应命中 label "AB"
	it("does NOT match substring labels (A vs AB)", () => {
		const labels = ["A", "AB", "ABC"];
		// 答案 "A, AB" 应精确匹配两个 label，而非 "A" 匹配三次
		const result = parseAnswerParts("A, AB", labels);
		expect(result.selected).toEqual(["A", "AB"]);
	});

	it("does NOT match 'A' when only 'AB' is in answer", () => {
		const labels = ["A", "AB"];
		// 答案 "AB" 只应命中 "AB"，不应命中 "A"
		const result = parseAnswerParts("AB", labels);
		expect(result.selected).toEqual(["AB"]);
	});

	it("preserves order of appearance in answer (not label order)", () => {
		const labels = ["A", "B", "C"];
		// 用户选择顺序可能与 options 定义顺序不同
		const result = parseAnswerParts("C, A", labels);
		expect(result.selected).toEqual(["C", "A"]);
	});

	it("extracts comment after ANSWER_COMMENT_SEPARATOR", () => {
		const labels = ["yes"];
		const answer = `yes${ANSWER_COMMENT_SEPARATOR}because reasons`;
		const result = parseAnswerParts(answer, labels);
		expect(result.selected).toEqual(["yes"]);
		expect(result.comment).toBe("because reasons");
	});

	it("handles full-width comma (，) as separator", () => {
		const labels = ["A", "B"];
		const result = parseAnswerParts("A，B", labels);
		expect(result.selected).toEqual(["A", "B"]);
	});

	it("returns non-matching tokens as neither selected nor comment (Other free text)", () => {
		const labels = ["yes", "no"];
		// "custom text" 不匹配任何 label → 是 Other 自由文本
		const result = parseAnswerParts("custom text", labels);
		expect(result.selected).toEqual([]);
		expect(result.comment).toBeUndefined();
	});

	it("handles empty answer string", () => {
		const result = parseAnswerParts("", ["A", "B"]);
		expect(result.selected).toEqual([]);
		expect(result.comment).toBeUndefined();
	});

	it("handles answer with only comment (no selected labels)", () => {
		const labels = ["A"];
		const answer = `${ANSWER_COMMENT_SEPARATOR}just a comment`;
		const result = parseAnswerParts(answer, labels);
		expect(result.selected).toEqual([]);
		expect(result.comment).toBe("just a comment");
	});

	// MF-2 回归：label 自身含 ANSWER_COMMENT_SEPARATOR（LLM 生成 label 常见形态）时，
	// 首个分隔符切分会把 label 拦腰截断 → token 无法精确匹配 → 选中值静默丢失
	describe("MF-2: label contains ANSWER_COMMENT_SEPARATOR", () => {
		const labels = ["Postgres — prod", "SQLite"];

		it("whole answer exactly matches separator-containing label → selected, no comment", () => {
			const result = parseAnswerParts("Postgres — prod", labels);
			expect(result.selected).toEqual(["Postgres — prod"]);
			expect(result.comment).toBeUndefined();
		});

		it("selection + comment → later separator becomes split point", () => {
			const result = parseAnswerParts("Postgres — prod — fast", labels);
			expect(result.selected).toEqual(["Postgres — prod"]);
			expect(result.comment).toBe("fast");
		});

		it("two selections where first label contains separator", () => {
			const result = parseAnswerParts("Postgres — prod, SQLite — my note", labels);
			expect(result.selected).toEqual(["Postgres — prod", "SQLite"]);
			expect(result.comment).toBe("my note");
		});

		it("comment containing separator keeps full remainder", () => {
			const result = parseAnswerParts("Postgres — prod — fast — very fast", labels);
			expect(result.selected).toEqual(["Postgres — prod"]);
			expect(result.comment).toBe("fast — very fast");
		});
	});

	it("returns non-matching body tokens as otherTokens (Other free text)", () => {
		const result = parseAnswerParts("custom text", ["yes", "no"]);
		expect(result.selected).toEqual([]);
		expect(result.otherTokens).toEqual(["custom text"]);
	});

	it("otherTokens excludes matched labels and comment", () => {
		const result = parseAnswerParts("A, custom text — note", ["A", "B"]);
		expect(result.selected).toEqual(["A"]);
		expect(result.otherTokens).toEqual(["custom text"]);
		expect(result.comment).toBe("note");
	});

	// MF-6 回归：两个 label 都含分隔符时（"Postgres — prod, MySQL"），分隔符扫描会把
	// 首个分隔符当切分点 → body "Postgres" 无匹配 → 剩余 "prod, MySQL" 被误判为 comment，
	// 两个选中项全部静默丢失。纯多选分支（所有逗号 token 均为 label）在扫描前短路。
	describe("MF-6: pure multi-select where every label contains separator", () => {
		const labels = ["Postgres — prod", "MySQL"];

		it("all comma tokens are labels → selected all, no comment", () => {
			const result = parseAnswerParts("Postgres — prod, MySQL", labels);
			expect(result.selected).toEqual(["Postgres — prod", "MySQL"]);
			expect(result.comment).toBeUndefined();
			expect(result.otherTokens).toEqual([]);
		});

		it("comment form not broken: non-label token 'MySQL — note' skips the branch", () => {
			// "MySQL — note" 非 label → 不进纯多选分支；分隔符扫描取「body 整串可解析为
			// 选中项」的最靠后切分（"Postgres — prod, MySQL" 两个 token 均 label）→
			// 选中两项 + comment "note"（与 MF-2 多选 + comment 语义一致）
			const result = parseAnswerParts("Postgres — prod, MySQL — note", labels);
			expect(result.selected).toEqual(["Postgres — prod", "MySQL"]);
			expect(result.comment).toBe("note");
		});

		it("three selections all containing separators", () => {
			const labels3 = ["Postgres — prod", "MySQL — prod", "SQLite — prod"];
			const result = parseAnswerParts("Postgres — prod, MySQL — prod, SQLite — prod", labels3);
			expect(result.selected).toEqual(["Postgres — prod", "MySQL — prod", "SQLite — prod"]);
			expect(result.comment).toBeUndefined();
		});
	});

	// MF-7 回归：重叠前缀 label（短 label 是长 label 的前缀）时，分隔符扫描取「首个 body
	// 含 label token」的切分会停在短 label 处，把长 label 的剩余部分误判为 comment。
	// 修复：优先「body 整串精确命中 label」的切分点，多个命中取最靠后者（最长匹配）。
	describe("MF-7: overlapping prefix labels prefer whole-body label split", () => {
		const labels = ["Postgres", "Postgres — prod"];

		it("longest whole-body label wins → 'Postgres — prod' + comment 'x'", () => {
			const result = parseAnswerParts("Postgres — prod — x", labels);
			expect(result.selected).toEqual(["Postgres — prod"]);
			expect(result.comment).toBe("x");
		});

		it("short label + comment containing long-label prefix (inherent ambiguity, documented tradeoff)", () => {
			// 长 label 不在候选时（labels 只有 "Postgres"），同一文本解析为
			// 选短 label + comment "prod — x"——文本层面唯一可解析的归属
			const result = parseAnswerParts("Postgres — prod — x", ["Postgres"]);
			expect(result.selected).toEqual(["Postgres"]);
			expect(result.comment).toBe("prod — x");
		});

		it("multi-select + comment with prefix labels → split after all labels", () => {
			// "Postgres — prod, SQLite" 两个 token 均 label → 切分点取最后分隔符，
			// body 完整保留两项选中，comment "note"（首个整串命中 "Postgres" 不截断）
			const labels3 = ["Postgres", "Postgres — prod", "SQLite"];
			const result = parseAnswerParts("Postgres — prod, SQLite — note", labels3);
			expect(result.selected).toEqual(["Postgres — prod", "SQLite"]);
			expect(result.comment).toBe("note");
		});
	});

	// S-17 行为固化：Other 自由文本自身含 " — "（如 "custom — text"）与
	// 「选中/Other + comment」形态在纯解析层面固有歧义，保持首个分隔符切分行为
	// （body "custom" + comment "text"），不做解析层区分（见 answer-format.ts 注释）。
	describe("S-17: Other free text containing separator (behavior freeze)", () => {
		it("separator inside Other text → first-separator split, documented ambiguity", () => {
			const result = parseAnswerParts("custom — text", ["yes", "no"]);
			expect(result.selected).toEqual([]);
			expect(result.otherTokens).toEqual(["custom"]);
			expect(result.comment).toBe("text");
		});

		it("Other text with separator + matched label before it", () => {
			const result = parseAnswerParts("yes, custom — text", ["yes", "no"]);
			expect(result.selected).toEqual(["yes"]);
			expect(result.otherTokens).toEqual(["custom"]);
			expect(result.comment).toBe("text");
		});
	});
});
