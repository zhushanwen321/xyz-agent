// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/loop-gate.test.ts
//
// LoopGate 闸门单测（D3/U2）——两层：
//   1. 纯状态机（LoopGate 类直调）：同签名计数递增 / 签名变化清零 / 成功清零 /
//      terminal 幂等 / 归一化函数契约
//   2. setupLoopGate 装配层（mock pi）：第 3 次同签名触发 terminal + shutdown +
//      appendEntry 日志 + onTerminal 回调；非 structured-output 工具失败不计入。
//
// 三视角：构建者白盒（状态机字段断言）+ 使用者黑盒（emit 驱动后断言 shutdown/
// appendEntry 可见副作用）+ 形态（日志文案含 §5.2 指引）。

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	LoopGate,
	MAX_CONSECUTIVE_FAILURES,
	normalizeErrorSignature,
	setupLoopGate,
} from "../src/loop-gate.js";

import {
	createMockPi,
	failedToolEndWith,
	loadExtension,
	paramLayerErrorText,
	restoreSchemaEnv,
	SCHEMA,
	SCHEMA_ENV_NAME,
	SUCCESS_TOOL_END,
	turnEndPayload,
} from "./mock-pi-fixture.js";

const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

afterEach(() => {
	restoreSchemaEnv(originalSchemaEnv);
	vi.restoreAllMocks();
});

// ── 纯状态机（构建者白盒）──────────────────────────────────────

describe("LoopGate state machine (D3)", () => {
	it("① 同签名计数递增：连续同签名失败 1→2 未达阈值不 terminal", () => {
		const gate = new LoopGate();
		const err = 'Validation failed for tool "structured-output":\n  - magic: must be equal to constant';
		expect(gate.onToolExecEnd(true, err)).toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		expect(gate.onToolExecEnd(true, err)).toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(2);
		expect(gate.terminal).toBe(false);
	});

	it("② 签名变化清零：不同错误文本 → 计数重起（新签名从此失败起算 1）", () => {
		const gate = new LoopGate();
		gate.onToolExecEnd(true, "error A");
		expect(gate.consecutiveFailures).toBe(1);
		// 签名变化：上一签名计数作废，新签名连续计数从本次失败起算
		gate.onToolExecEnd(true, "error B");
		expect(gate.consecutiveFailures).toBe(1);
		expect(gate.signature).toBe("error B");
		// 回到旧签名也重新起算（连续性被打断）
		gate.onToolExecEnd(true, "error A");
		expect(gate.consecutiveFailures).toBe(1);
	});

	it("③ 第 3 次同签名触发 terminal（newlyTerminal 恰一次），此后幂等", () => {
		const gate = new LoopGate();
		gate.onToolExecEnd(true, "same error");
		gate.onToolExecEnd(true, "same error");
		expect(gate.onToolExecEnd(true, "same error")).toEqual({ terminal: true, newlyTerminal: true });
		expect(gate.terminal).toBe(true);
		// terminal 后任何输入不再变化、不再重复触发（newlyTerminal=false）
		expect(gate.onToolExecEnd(true, "same error")).toEqual({ terminal: true, newlyTerminal: false });
		expect(gate.onToolExecEnd(false)).toEqual({ terminal: true, newlyTerminal: false });
		expect(gate.terminal).toBe(true);
	});

	it("④ 成功调用清零：失败×2 → 成功 → 失败×2 仍未 terminal，第 3 次失败才触发", () => {
		const gate = new LoopGate();
		gate.onToolExecEnd(true, "same error");
		gate.onToolExecEnd(true, "same error");
		gate.onToolExecEnd(false);
		expect(gate.consecutiveFailures).toBe(0);
		expect(gate.signature).toBeNull();
		gate.onToolExecEnd(true, "same error");
		gate.onToolExecEnd(true, "same error");
		expect(gate.terminal).toBe(false); // 清零后重起，2 次 < 3
		expect(gate.onToolExecEnd(true, "same error")).toEqual({ terminal: true, newlyTerminal: true });
	});

	it("⑤ 阈值常量 = 3（设计 §6.3：对齐 qwen-code；锁定防意外漂移）", () => {
		expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
	});

	it("⑥ 无错误文本时降级通用提示并参与签名计数", () => {
		const gate = new LoopGate();
		gate.onToolExecEnd(true);
		gate.onToolExecEnd(true);
		expect(gate.onToolExecEnd(true)).toEqual({ terminal: true, newlyTerminal: true });
	});
});

// ── 错误签名归一化（U3 审查项#7：字段/路径 token 集合哈希）──────────────

// 大 schema 渐进修复场景的原料：错误行块 ≈1.3K chars（远超 500c 前缀），
// 修复列表尾部字段时消息前缀（首 500c）纹丝不动——旧前缀方案在此折叠成同签名。
const ALL_FIELDS: string[] = Array.from({ length: 40 }, (_, i) => `field${String(i).padStart(2, "0")}`);
function validationError(fields: string[]): string {
	return paramLayerErrorText(
		fields.map((f) => `  - ${f}: must be string`).join("\n"),
		"{}",
	);
}
/** 错误行块首 500c（剔除回显后）——旧 500c 前缀签名方案的等价物，用于锁定误杀场景。 */
function legacyHead(text: string): string {
	return text.split("\n\nReceived arguments:")[0]!.slice(0, 500);
}

describe("normalizeErrorSignature", () => {
	it("剔除 'Received arguments:' 起的实参回显：同错误行不同回显 → 同签名", () => {
		const a = paramLayerErrorText(
			'  - assessments.0.impact: must be string\n  - name: must be string',
			'{"name": 1}',
		);
		const b = paramLayerErrorText(
			'  - assessments.0.impact: must be string\n  - name: must be string',
			'{"name": "x", "extra": {"deeply": {"nested": [1,2,3]}}}',
		);
		expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
	});

	it("字段集合不变 → 同签名（含同字段不同错误类型——集合不变 = 无进展，语义收紧）；集合不同 → 新签名", () => {
		// 同为 {impact}：must be string → must be number，旧前缀方案算「推进」，
		// 集合哈希方案下字段集合不变 = 仍卡在同一字段 = 无进展
		const a = paramLayerErrorText("  - impact: must be string", "{}");
		const b = paramLayerErrorText("  - impact: must be number", "{}");
		expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
		// 集合 {impact} → {impact, extra}：新签名
		const c = paramLayerErrorText("  - impact: must be string\n  - extra: must be number", "{}");
		expect(normalizeErrorSignature(a)).not.toBe(normalizeErrorSignature(c));
	});

	it("渐进修复产生新签名：大 schema 下修复尾部字段（前缀不变）→ 签名变化（审查项#7 改写：原碰撞断言反转为区分断言）", () => {
		const bigError = validationError(ALL_FIELDS);
		const afterTailFixed = validationError(ALL_FIELDS.slice(0, -1));
		// 前置锁定：两者错误行块首 500c 完全相同——旧前缀方案必然同签名（误杀）
		expect(legacyHead(bigError)).toBe(legacyHead(afterTailFixed));
		// 新方案：失败字段集合 {f00..f39} → {f00..f38} 缩小 → 新签名（模型在推进）
		expect(normalizeErrorSignature(bigError)).not.toBe(normalizeErrorSignature(afterTailFixed));
	});

	it("ajv instancePath 形态（日常模式）：'/count' 提取为字段 token，与 bullet 形态同字段同签名", () => {
		expect(normalizeErrorSignature("Schema validation failed: /count must be number"))
			.toBe(normalizeErrorSignature("  - count: must be number"));
	});

	it("提取失败 fallback：无字段 token → 500c 裸前缀签名，超长截断且稳定", () => {
		const long = "Connection reset by peer ".repeat(300);
		const sig = normalizeErrorSignature(long);
		expect(sig.length).toBeLessThanOrEqual(500);
		expect(sig).toBe(normalizeErrorSignature(long + "tail that must not matter"));
	});

	it("超长无 token 错误（'x'×5000）fallback 截断到上限且稳定", () => {
		const long = "x".repeat(5000);
		const sig = normalizeErrorSignature(long);
		expect(sig.length).toBeLessThanOrEqual(500);
		expect(sig).toBe(normalizeErrorSignature(long + "different tail"));
	});
});

// ── 签名哈希化的闸门级验收（审查项#7）──────────────────────────

describe("LoopGate signature hashing (progressive-fix acceptance)", () => {
	it("渐进修复（字段集合缩小）→ 每步新签名计数重起，不触发 terminal；停止修复后第 3 次同签名才 terminal", () => {
		const gate = new LoopGate();
		let fields = [...ALL_FIELDS];
		// 渐进修复链：40 → 30 个字段，每步集合缩小 = 新签名 = 连续计数重起，永不及 3
		for (let i = 0; i < 10; i++) {
			expect(gate.onToolExecEnd(true, validationError(fields))).toEqual({
				terminal: false,
				newlyTerminal: false,
			});
			expect(gate.consecutiveFailures).toBe(1);
			fields = fields.slice(0, -1);
		}
		// 停止修复：同一集合重复——失败有界语义不变，第 3 次同签名触发 terminal
		const stalled = validationError(fields);
		gate.onToolExecEnd(true, stalled);
		expect(gate.consecutiveFailures).toBe(1);
		gate.onToolExecEnd(true, stalled);
		expect(gate.consecutiveFailures).toBe(2);
		expect(gate.onToolExecEnd(true, stalled)).toEqual({ terminal: true, newlyTerminal: true });
	});

	it("同集合不同实参 → 同签名计数递增（实参变化不等于进展——归一化语义保留）", () => {
		const gate = new LoopGate();
		gate.onToolExecEnd(true, paramLayerErrorText("  - alpha: must be string", '{"alpha":1}'));
		gate.onToolExecEnd(true, paramLayerErrorText("  - alpha: must be string", '{"alpha":"totally different echo"}'));
		expect(gate.consecutiveFailures).toBe(2);
		expect(gate.terminal).toBe(false);
	});
});

// ── 装配层（setupLoopGate + mock pi：使用者黑盒 + 形态）───────────

describe("setupLoopGate assembly (via mock pi)", () => {
	it("第 3 次同签名失败 → shutdown 调用恰一次 + appendEntry 含指引 + onTerminal 恰一次", async () => {
		const pi = createMockPi();
		const onTerminal = vi.fn();
		setupLoopGate(pi, { onTerminal });

		const ev = failedToolEndWith(paramLayerErrorText("  - magic: must be equal to constant", '{"magic":"nope"}'));
		await pi.emit("tool_execution_end", ev);
		await pi.emit("tool_execution_end", failedToolEndWith(paramLayerErrorText("  - magic: must be equal to constant", '{"magic":"still-nope"}')));
		expect(pi.ctx.shutdown).not.toHaveBeenCalled();

		await pi.emit("tool_execution_end", failedToolEndWith(paramLayerErrorText("  - magic: must be equal to constant", '{"magic":"third"}')));
		expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
		expect(onTerminal).toHaveBeenCalledTimes(1);

		// 形态：appendEntry 持久化记录（session JSONL 通道，不进 LLM 上下文）
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const [entryType, entryData] = pi.appendEntry.mock.calls[0]!;
		expect(entryType).toBe("structured-output:gate");
		expect(entryData).toMatchObject({ event: "terminated", consecutiveFailures: 3 });

		// 第 4 次失败不重复 shutdown / 日志 / 回调（幂等）
		await pi.emit("tool_execution_end", ev);
		expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(onTerminal).toHaveBeenCalledTimes(1);
	});

	it("非 structured-output 工具的失败不计入（bash 失败 ×5 无 shutdown）", async () => {
		const pi = createMockPi();
		setupLoopGate(pi);

		for (let i = 0; i < 5; i++) {
			await pi.emit("tool_execution_end", failedToolEndWith("exit code 1", "bash"));
		}
		expect(pi.ctx.shutdown).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("成功调用清零：失败×2 → 成功 → 失败×2 不触发 shutdown", async () => {
		const pi = createMockPi();
		setupLoopGate(pi);

		const err = paramLayerErrorText("  - count: must be number", "{}");
		await pi.emit("tool_execution_end", failedToolEndWith(err));
		await pi.emit("tool_execution_end", failedToolEndWith(err));
		await pi.emit("tool_execution_end", SUCCESS_TOOL_END);
		await pi.emit("tool_execution_end", failedToolEndWith(err));
		await pi.emit("tool_execution_end", failedToolEndWith(err));
		expect(pi.ctx.shutdown).not.toHaveBeenCalled();
	});

	it("非合法事件形态（缺 isError/toolName 字段）安全忽略", async () => {
		const pi = createMockPi();
		setupLoopGate(pi);
		await pi.emit("tool_execution_end", { type: "tool_execution_end" });
		await pi.emit("tool_execution_end", null);
		expect(pi.ctx.shutdown).not.toHaveBeenCalled();
	});
});

// ── 端到端装配（index.ts workflow 模式整体分岔）─────────────────

describe("index assembly: gate wired into workflow mode", () => {
	it("workflow 模式下 3 次同签名失败 → terminal 后 turn_end 不 steer（hook 保险分支）", async () => {
		const pi = createMockPi();
		await loadExtension(pi, SCHEMA);

		// 3 次同签名失败（同一错误文本 = 同签名）：闸门 terminal + shutdown
		const err = "Schema validation failed: /count must be number";
		for (let i = 0; i < 3; i++) {
			await pi.emit("tool_execution_end", failedToolEndWith(err));
		}
		expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);

		// terminal 后 turn_end：hook 守卫链第 0 条（state.terminal）拦截 → 不 steer
		await pi.emit("turn_end", turnEndPayload());
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("失败次数未达阈值时 turn_end steer 行为不受闸门影响（软硬闸门分层）", async () => {
		const pi = createMockPi();
		await loadExtension(pi, SCHEMA);

		await pi.emit("tool_execution_end", failedToolEndWith("Schema validation failed: /count must be number"));
		await pi.emit("turn_end", turnEndPayload());
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi.ctx.shutdown).not.toHaveBeenCalled();
	});
});
