import { describe, expect, it } from "vitest";

import { slugMeta, toSlug } from "../slug.js";

describe("toSlug", () => {
	it("空/空白输入回落 untitled", () => {
		expect(toSlug("")).toBe("untitled");
		expect(toSlug("   ")).toBe("untitled");
	});

	it("常规中英文与数字保留", () => {
		expect(toSlug("Fix Session 42")).toBe("fix-session-42");
		expect(toSlug("会话 甲乙")).toBe("会话-甲乙");
	});

	it("特殊字符折叠为单个分隔符且去首尾", () => {
		expect(toSlug("a//b__c")).toBe("a-b-c");
		expect(toSlug("--a--")).toBe("a");
		expect(toSlug("!!!")).toBe("untitled");
	});

	it("超长按 maxLen 截断", () => {
		expect(toSlug("abcdefghij", 4)).toBe("abcd");
		expect(toSlug("abcdefghij")).toHaveLength(10);
	});

	it("截断后剥尾部悬挂分隔符，空则回落 untitled（S-9）", () => {
		expect(toSlug("abc-def", 4)).toBe("abc");
		expect(toSlug("ab-cdef", 3)).toBe("ab");
	});

	it("astral 字符折叠为分隔符（安全字符集限 BMP，S-12）", () => {
		// isSafeChar 仅放行 BMP 内的 [a-z0-9 中文]；astral 平面（如 😀）按非安全字符折叠
		expect(toSlug("😀a")).toBe("a");
	});
});

describe("slugMeta", () => {
	it("聚合 slug 与指纹", () => {
		const meta = slugMeta("My Session");
		expect(meta.slug).toBe("my-session");
		expect(meta.fp).toBe("my session:10");
	});

	it("指纹对同一输入稳定", () => {
		expect(slugMeta("x").fp).toBe(slugMeta("x").fp);
		// 指纹长度取原始输入长度（normalizeToken 只影响前缀）。
		expect(slugMeta(" x ").fp).toBe("x:3");
	});
});
