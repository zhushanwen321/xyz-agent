// src/execution/__tests__/list-fields.test.ts
//
// [v4 A-6] recordToListItem 字段派生单测。
//
// 验证 list 输出的新增字段派生正确：
//   - parent：从 record.parentRecordId 派生（顶层 record → undefined）
//   - resumable：从 isResumable 派生（running && 无活进程句柄）
//   - closedReason：透传 record.closedReason（SP-4 级联关闭告知替代）
//
// Mock 策略：vi.mock lifecycle-predicates 的 isResumable，控制其返回值模拟「有/无
// 活进程句柄」两种 running 子态。isResumable 真实逻辑（running && !hasLiveProcessHandle）
// 由 lifecycle-predicates.test.ts 覆盖；本测试聚焦 recordToListItem 的字段派生与透传。

import { describe, expect, it, vi } from "vitest";

// mock lifecycle-predicates：控制 isResumable 返回值。
// recordToListItem 内部 import 的 isResumable 经 vitest 自动接线拿到此 mock 版本。
vi.mock("../../execution/lifecycle-predicates.ts", () => ({
	isResumable: vi.fn(),
}));

import { recordToListItem } from "../../interface/subagent-actions.ts";
import { isResumable } from "../../execution/lifecycle-predicates.ts";
import type { ClosedReason, SubagentRecord } from "../types.ts";

// ── SubagentRecord stub 工厂（最小合法 record） ──

function makeRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "sa-test",
		agent: "general-purpose",
		task: "test task",
		slug: "test-slug",
		status: "running",
		mode: "background",
		startedAt: Date.now(),
		rootSessionId: "session-main",
		parentRecordId: undefined,
		depth: 0,
		endedAt: undefined,
		turns: 0,
		totalTokens: 0,
		model: "test/model",
		thinkingLevel: undefined,
		eventLog: [],
		displayItems: [],
		result: undefined,
		error: undefined,
		sessionFile: undefined,
		...over,
	};
}

describe("recordToListItem — parent/resumable/closedReason (v4 A-6)", () => {
	// ═══ parent：从 record.parentRecordId 派生 ═══

	it("parent：嵌套 record（parentRecordId='sa-A'）→ parent='sa-A'", () => {
		const rec = makeRecord({ parentRecordId: "sa-A" });
		expect(recordToListItem(rec).parent).toBe("sa-A");
	});

	it("parent：根层 record（parentRecordId=undefined）→ parent=undefined", () => {
		const rec = makeRecord({ parentRecordId: undefined });
		expect(recordToListItem(rec).parent).toBeUndefined();
	});

	// ═══ resumable：isResumable 透传（mock 模拟有/无活进程句柄） ═══

	it("resumable：running + 无活进程句柄（isResumable=true）→ true（B-1 续聊态）", () => {
		vi.mocked(isResumable).mockReturnValue(true);
		const rec = makeRecord({ status: "running" });
		expect(recordToListItem(rec).resumable).toBe(true);
	});

	it("resumable：running + 有活进程句柄（isResumable=false）→ false（正在执行）", () => {
		vi.mocked(isResumable).mockReturnValue(false);
		const rec = makeRecord({ status: "running" });
		expect(recordToListItem(rec).resumable).toBe(false);
	});

	it("resumable：closed（isResumable=false）→ false（终态不可续聊）", () => {
		vi.mocked(isResumable).mockReturnValue(false);
		const rec = makeRecord({ status: "closed" });
		expect(recordToListItem(rec).resumable).toBe(false);
	});

	// ═══ closedReason：透传 record.closedReason ═══

	it("closedReason：closed + closedReason='parent-fork' → 透传", () => {
		const rec = makeRecord({
			status: "closed",
			closedReason: "parent-fork" as ClosedReason,
		});
		expect(recordToListItem(rec).closedReason).toBe("parent-fork");
	});

	it("closedReason：closed + closedReason='parent-new' → 透传（SP-4 级联关闭场景）", () => {
		const rec = makeRecord({
			status: "closed",
			closedReason: "parent-new" as ClosedReason,
		});
		expect(recordToListItem(rec).closedReason).toBe("parent-new");
	});

	it("closedReason：running record（无 closedReason）→ undefined", () => {
		const rec = makeRecord({ status: "running" });
		expect(recordToListItem(rec).closedReason).toBeUndefined();
	});
});
