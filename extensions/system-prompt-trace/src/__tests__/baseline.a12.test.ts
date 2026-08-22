/**
 * A12 hash 基线跨重启恢复（spec：.cw-specs/trace-ext.json；设计 D2 复审 N2 / plan §2.1）。
 *
 * 三路径（优先级从高到低）：
 * 1. 进程内 resume：session_before_switch.targetSessionFile 直读目标文件取上一版 hash
 *    （switch 重建 extension runtime，基线经模块级 stash 传递——用「新闭包 + 共享 stash」模拟）
 * 2. app 重启直 spawn resume：agentDir 自持久化小文件（此链路无 switch 事件、reason=startup）
 * 3. 兜底：两路都读不到 → resume 必写一条（宁可多写不可漏记）
 *
 * 用真实临时目录 + 真实 fs 函数（非 mock 投影）；appendEntry 同步模拟 pi appendCustomEntry
 * 的落盘形状（session-manager.ts）。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	BASELINE_FILENAME,
	readLastPromptFromSessionFile,
	readPersistedBaseline,
	writePersistedBaseline,
} from "../baseline.js";
import { computePromptHash, createSystemPromptTrace } from "../trace.js";
import type { SystemPromptTrace, TraceContext, TraceEnv } from "../trace.js";
import { isSystemPromptTraceEntryData, SYSTEM_PROMPT_CUSTOM_TYPE } from "../types.js";
import type { SystemPromptTraceEntryData, SwitchStash } from "../types.js";

const P1 = "base prompt\nline-1";
const P2 = "base prompt\nline-1\nline-2-added";

interface FsHarness {
	logic: SystemPromptTrace;
	ctx: TraceContext;
	stash: SwitchStash;
	sessionFile: string;
	baselineFile: string;
	entries: SystemPromptTraceEntryData[];
	setPrompt(text: string): void;
	/** 真实链路中 new/fork 的新 session 有全新 id（fake ctx 不能固定 id，否则旧基线误命中） */
	setSessionId(id: string): void;
	/** 模拟 extension runtime 重建（switchSession teardown + createRuntime 重跑 factory：新闭包，共享 stash 与文件） */
	newLogic(): SystemPromptTrace;
	/** 读 sessionFile 的非空行（模拟 pi 落盘结果核对） */
	sessionLines(): string[];
}

let rootDir = "";

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "spt-a12-"));
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

function makeHarness(initialPrompt: string): FsHarness {
	const dir = join(rootDir, `sess-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const sessionFile = join(dir, "session.jsonl");
	const baselineFile = join(dir, BASELINE_FILENAME);
	const entries: SystemPromptTraceEntryData[] = [];
	let prompt = initialPrompt;
	let sessionId = "sess-a12";
	const stash: SwitchStash = { pending: null };

	const env: TraceEnv = {
		readLastPromptFromFile: (filePath) => readLastPromptFromSessionFile(filePath, "target-file"),
		readPersistedBaseline: (sessionId) => readPersistedBaseline(baselineFile, sessionId),
		writePersistedBaseline: (sessionId, hash, version) =>
			writePersistedBaseline(baselineFile, sessionId, hash, version),
	};

	const ctx: TraceContext = {
		getSystemPrompt: () => prompt,
		getSessionId: () => sessionId,
		appendEntry: (customType, data) => {
			if (!isSystemPromptTraceEntryData(data)) {
				throw new Error(`entry data shape invalid: ${JSON.stringify(data)}`);
			}
			// 模拟 pi appendCustomEntry 落盘形状（session-manager.ts）
			appendFileSync(
				sessionFile,
				JSON.stringify({
					type: "custom",
					customType,
					data,
					id: `e${entries.length + 1}`,
					parentId: null,
					timestamp: new Date().toISOString(),
				}) + "\n",
			);
			entries.push(data);
		},
	};

	const makeLogic = (): SystemPromptTrace => createSystemPromptTrace(env, stash);

	return {
		logic: makeLogic(),
		ctx,
		stash,
		sessionFile,
		baselineFile,
		entries,
		setPrompt: (text) => {
			prompt = text;
		},
		setSessionId: (id) => {
			sessionId = id;
		},
		newLogic: makeLogic,
		sessionLines: () => {
			try {
				return readFileSync(sessionFile, "utf-8").split("\n").filter((l) => l.trim() !== "");
			} catch {
				return [];
			}
		},
	};
}

describe("A12 hash 基线跨重启恢复", () => {
	it("路径 1（进程内 resume）：targetSessionFile 直读命中且 hash 未变 → 不重写（跨 switch 去重）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial
		expect(h.entries).toHaveLength(1);

		// 旧 runtime 在 before_switch 直读目标文件 → stash
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile);
		expect(h.stash.pending).toMatchObject({ hash: computePromptHash(P1), version: 1 });

		// 新 runtime（switch 后重建）消费 stash；hash 相同 → 不写
		const logic2 = h.newLogic();
		logic2.onSessionStart("resume", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.sessionLines()).toHaveLength(1);
	});

	it("路径 1（进程内 resume）：基线 hash 变化 → 写 resume v2，diff 摘要的 parent 全文来自目标文件", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile);

		h.setPrompt(P2);
		const logic2 = h.newLogic();
		logic2.onSessionStart("resume", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		expect(h.entries[1]).toMatchObject({ version: 2, reason: "resume", hash: computePromptHash(P2) });
		expect(typeof h.entries[1]?.parentVersionDiffSummary).toBe("string");
		expect(h.entries[1]?.parentVersionDiffSummary).toContain("+1 -0 lines");
	});

	it("路径 2（app 重启直 spawn）：自持久化小文件命中且 hash 未变 → 不写（reason=startup、无 switch 事件）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial + 基线小文件已写
		expect(readPersistedBaseline(h.baselineFile, "sess-a12")).toMatchObject({
			hash: computePromptHash(P1),
			version: 1,
		});

		// app 重启：全新闭包 + 空 stash（无 before_switch 可用）
		const logic2 = h.newLogic();
		expect(logic2).toBeDefined();
		logic2.onSessionStart("startup", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
	});

	it("路径 2（app 重启直 spawn）：基线命中但 prompt 已变 → 写 resume v2（无 parent 全文，diff 摘要缺省）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1

		h.setPrompt(P2);
		const logic2 = h.newLogic();
		logic2.onSessionStart("startup", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		// 基线存在 → 该 session 已有历史版本 → resume（而非 initial 重新计数）
		expect(h.entries[1]).toMatchObject({ version: 2, reason: "resume" });
		expect(h.entries[1]?.parentVersionDiffSummary).toBeUndefined();
	});

	it("路径 3（兜底）：两路基线都读不到且 reason=resume → 必写一条", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("resume", undefined, h.ctx); // 无 stash、无小文件
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("基线小文件损坏 → 视为无基线，resume 必写一条", () => {
		const h = makeHarness(P1);
		writeFileSync(h.baselineFile, "{ not valid json");
		h.logic.onSessionStart("resume", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("目标文件无留痕 entry（旧 session 先于本 extension）→ 无基线 → resume 必写 v1", () => {
		const h = makeHarness(P1);
		appendFileSync(h.sessionFile, JSON.stringify({ type: "message", message: { role: "user" } }) + "\n");
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile);
		expect(h.stash.pending).toBeNull();

		const logic2 = h.newLogic();
		logic2.onSessionStart("resume", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("cancelled switch 的 stash 残留不污染后续 new session（消费但不采用）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile); // switch 随后被取消，无 session_start 消费
		expect(h.stash.pending).not.toBeNull();

		// 之后用户开了全新 session：新 sessionId + reason=new → stash 被消费但不采用，从 v1 重新计数
		const logic2 = h.newLogic();
		h.setSessionId("sess-a12-new");
		logic2.onSessionStart("new", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		expect(h.entries[1]).toMatchObject({ version: 1, reason: "initial" });
	});

	it("fork（暂定语义，待 P2 实测定）：previousSessionFile 直读作基线，hash 未变不写", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1（落进 h.sessionFile）

		// pi 原生 fork 不经 session_before_switch：基线来自 session_start.previousSessionFile（新 sessionId 无持久化基线）
		const logic2 = h.newLogic();
		h.setSessionId("sess-a12-fork");
		logic2.onSessionStart("fork", h.sessionFile, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
	});

	it("readLastPromptFromSessionFile：损坏行跳过、取最后一条有效留痕；文件缺失 → null", () => {
		const scanDir = mkdtempSync(join(rootDir, "scan-"));
		const file = join(scanDir, "s.jsonl");
		const entryV1 = {
			type: "custom",
			customType: SYSTEM_PROMPT_CUSTOM_TYPE,
			data: { version: 1, hash: "hash-v1", reason: "initial", fullText: "old text", charCount: 8 },
		};
		const entryV2 = {
			type: "custom",
			customType: SYSTEM_PROMPT_CUSTOM_TYPE,
			data: { version: 2, hash: "hash-v2", reason: "change", fullText: "new text", charCount: 8 },
		};
		writeFileSync(file, [JSON.stringify(entryV1), "{ broken json", JSON.stringify(entryV2), ""].join("\n"));
		expect(readLastPromptFromSessionFile(file, "target-file")).toMatchObject({
			hash: "hash-v2",
			version: 2,
			fullText: "new text",
			source: "target-file",
		});
		expect(readLastPromptFromSessionFile(join(scanDir, "missing.jsonl"), "target-file")).toBeNull();
	});

	it("自持久化小文件读写回路：write 后 read 命中同 session；其他 session → null", () => {
		const file = join(rootDir, "baseline.json");
		writePersistedBaseline(file, "sid-1", "hash-x", 3);
		expect(readPersistedBaseline(file, "sid-1")).toEqual({ hash: "hash-x", version: 3, source: "persisted" });
		expect(readPersistedBaseline(file, "sid-other")).toBeNull();
	});
});
