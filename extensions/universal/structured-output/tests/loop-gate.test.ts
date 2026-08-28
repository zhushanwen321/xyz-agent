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

// ── 错误签名归一化（D3：同错误不同回显 = 同签名）────────────────

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

	it("错误行不同 → 不同签名（模型推进）", () => {
		const a = paramLayerErrorText("  - impact: must be string", "{}");
		const b = paramLayerErrorText("  - impact: must be number", "{}");
		expect(normalizeErrorSignature(a)).not.toBe(normalizeErrorSignature(b));
	});

	it("签名含工具名与错误行（回显剔除后首行保留），尾部空白被 trim", () => {
		const sig = normalizeErrorSignature(
			paramLayerErrorText("  - magic: must be equal to constant", "{}"),
		);
		expect(sig).toBe(
			'Validation failed for tool "structured-output":\n  - magic: must be equal to constant',
		);
	});

	it("无 'Received arguments:' 标记（非参数层错误文本）→ 全文截断参与比较", () => {
		expect(normalizeErrorSignature("Schema validation failed: /count must be number"))
			.toBe("Schema validation failed: /count must be number");
	});

	it("超长签名截断到上限且稳定", () => {
		const long = "x".repeat(5000);
		const sig = normalizeErrorSignature(long);
		expect(sig.length).toBeLessThanOrEqual(500);
		expect(sig).toBe(normalizeErrorSignature(long + "different tail"));
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
