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
	it("回显剔除语义（分桶后）：非 AP 错误行 keys 不进签名——值/结构变化均同签名（错误行 token 是唯一坐标）", () => {
		const a = paramLayerErrorText(
			'  - assessments.0.impact: must be string\n  - name: must be string',
			'{"name": 1}',
		);
		// 回显值随便变（含嵌套大值）不算进展——「实参值变化 ≠ 进展」本意保留
		const b = paramLayerErrorText(
			'  - assessments.0.impact: must be string\n  - name: must be string',
			'{"name": {"deeply": {"nested": [1,2,3]}}}',
		);
		expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(b));
		// keys 结构变化（+extra）也不进签名：非 AP 错误行天然携带字段名，keys 并入会
		// 与错误行 token 形成对流失衡（required 渐进误杀，见分桶回归组）——分桶门控后
		// 同签名（旧实现此处为 not.toBe，语义反转是本次修复的刻意变更）
		const c = paramLayerErrorText(
			'  - assessments.0.impact: must be string\n  - name: must be string',
			'{"name": 1, "extra": 2}',
		);
		expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(c));
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

// ── required 渐进修复回归（F1·high：message 字段列表并入 token）──────────────
//
// TypeBox required 错误只有一条 bullet，路径位仅含 requiredProperties[0]
//（pi-ai validation.js formatValidationPath），其余缺失字段名只在 message
//（"must have required properties alpha, beta, gamma"，typebox locale en_US 逐字核实）。
// 旧实现只取路径位 → 模型修好非首字段（缺失列表收缩 = 真实进展）被判同签名 3 次误杀。
const REQUIRED_FIELDS = ["alpha", "beta", "gamma"];
function requiredError(fields: string[]): string {
	return paramLayerErrorText(
		`  - ${fields[0]}: must have required properties ${fields.join(", ")}`,
		"{}",
	);
}

describe("required 渐进修复签名区分（F1 回归：bullet 路径位仅含首字段）", () => {
	it("锁定事实：required bullet 路径位在不同缺失集合下不变（修非首字段不改变路径位）——旧方案误杀的根源", () => {
		// 三种缺失集合的 bullet 路径位均为 "alpha"（requiredProperties[0]）——
		// 只取路径位的旧实现在此全部同签名；message 字段列表是唯一的进展信号。
		for (const fields of [REQUIRED_FIELDS, ["alpha", "gamma"], ["alpha"]]) {
			expect(requiredError(fields).split("\n")[1])
				.toContain("- alpha: must have required properties");
		}
	});

	it("演化序列 [缺a,b,c] → [缺a,c] → [缺a] 每步产生新签名（message 字段列表并入 token）", () => {
		const s1 = normalizeErrorSignature(requiredError(REQUIRED_FIELDS));
		const s2 = normalizeErrorSignature(requiredError(["alpha", "gamma"]));
		const s3 = normalizeErrorSignature(requiredError(["alpha"]));
		expect(s2).not.toBe(s1);
		expect(s3).not.toBe(s2);
		// 全量缺失与部分缺失也不折叠
		expect(s1).not.toBe(s3);
	});

	it("闸门级：三步演化序列每步计数重起，不触发 terminal（误杀回归）", () => {
		const gate = new LoopGate();
		expect(gate.onToolExecEnd(true, requiredError(REQUIRED_FIELDS)))
			.toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		// 修好 beta（列表 [a,b,c] → [a,c]）：新签名 → 计数重起
		expect(gate.onToolExecEnd(true, requiredError(["alpha", "gamma"])))
			.toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		// 再修好 gamma（[a,c] → [a]）：仍新签名
		expect(gate.onToolExecEnd(true, requiredError(["alpha"])))
			.toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		expect(gate.terminal).toBe(false);
	});

	it("单缺失 required 与普通类型错误 bullet 同字段同签名（token 集合口径一致）", () => {
		// required message 字段经父路径前缀还原后 = 路径位 token，两种形态同字段不漂移
		expect(normalizeErrorSignature(requiredError(["alpha"])))
			.toBe(normalizeErrorSignature(paramLayerErrorText("  - alpha: must be string", "{}")));
	});

	it("嵌套 required：message 字段经父路径还原为全路径 token，不与根级同名字段混淆", () => {
		// bullet: `  - outer.inner: must have required properties inner, delta`
		// token = {outer.inner, outer.delta}（非 {outer.inner, inner, delta}）
		const nested = paramLayerErrorText("  - outer.inner: must have required properties inner, delta", "{}");
		const flat = paramLayerErrorText("  - inner: must have required properties inner, delta", "{}");
		expect(normalizeErrorSignature(nested)).not.toBe(normalizeErrorSignature(flat));
		// 同一嵌套集合内收缩仍产生新签名（渐进修复语义在嵌套路径下成立）
		const nestedShrunk = paramLayerErrorText("  - outer.inner: must have required properties inner", "{}");
		expect(normalizeErrorSignature(nested)).not.toBe(normalizeErrorSignature(nestedShrunk));
	});

	it("同缺失集合重复 3 次（模型没修任何字段）→ 仍触发 terminal（闸门有界语义不变）", () => {
		const gate = new LoopGate();
		const err = requiredError(REQUIRED_FIELDS);
		gate.onToolExecEnd(true, err);
		gate.onToolExecEnd(true, err);
		expect(gate.onToolExecEnd(true, err)).toEqual({ terminal: true, newlyTerminal: true });
	});
});

// ── AP 渐进删除回归（D4：additionalProperties:false 默认注入）──────────────
//
// pi-ai 0.84.1 validation.js 本机探针实证：AP 错误 bullet 恒为
// "  - root: must not have additional properties"（根级非 required 错误不进
// formatValidationPath 特判 → 路径位恒 root，错误行块不含多余字段名）；实参回显是
// JSON.stringify(toolCall.arguments, null, 2)。模型逐个删除多余字段时错误行块
// 纹丝不动——旧实现折叠同签名、第 3 次 terminal 误杀；实参顶层 keys 集合是唯一
// 进展信号（keys 缩小 = 在删字段 = 真实进展）。
const AP_ERROR_LINE = "  - root: must not have additional properties";
/** 按 validation.js 实际格式构造 AP 错误：错误行块 + pretty-print 实参回显。 */
function apError(argObject: Record<string, unknown>): string {
	return paramLayerErrorText(AP_ERROR_LINE, JSON.stringify(argObject, null, 2));
}

describe("additionalProperties 渐进删除签名区分（AP 回归：D4 默认注入）", () => {
	it("锁定事实：AP 错误 bullet 路径位恒为 root（实参 keys 是唯一进展信号）", () => {
		for (const args of [{ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, { x: true }]) {
			expect(apError(args).split("\n")[1]).toContain("- root: must not have additional properties");
		}
	});

	it("三多余字段逐个删除：三步互异签名计数重起，不触发 terminal（误杀回归）", () => {
		const gate = new LoopGate();
		// 模拟真实演化：{summary, confidence, extra} → 删 extra → 删 confidence
		expect(gate.onToolExecEnd(true, apError({ summary: "s", confidence: 0.9, extra: true })))
			.toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		expect(gate.onToolExecEnd(true, apError({ summary: "s", confidence: 0.9 })))
			.toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		expect(gate.onToolExecEnd(true, apError({ summary: "s" })))
			.toEqual({ terminal: false, newlyTerminal: false });
		expect(gate.consecutiveFailures).toBe(1);
		expect(gate.terminal).toBe(false);
		// 签名级：三步互异
		const s1 = normalizeErrorSignature(apError({ summary: "s", confidence: 0.9, extra: true }));
		const s2 = normalizeErrorSignature(apError({ summary: "s", confidence: 0.9 }));
		const s3 = normalizeErrorSignature(apError({ summary: "s" }));
		expect(s1).not.toBe(s2);
		expect(s2).not.toBe(s3);
		expect(s1).not.toBe(s3);
	});

	it("同一多余字段反复失败（keys 集合不变）→ 同签名第 3 次仍触闸（闸门保护不丢失）", () => {
		const gate = new LoopGate();
		// keys 恒为 {summary}，仅值变化——不算进展，既有「值变化 ≠ 进展」语义在 AP 场景保留
		gate.onToolExecEnd(true, apError({ summary: "wrong" }));
		gate.onToolExecEnd(true, apError({ summary: "still wrong" }));
		expect(gate.consecutiveFailures).toBe(2);
		expect(gate.terminal).toBe(false);
		expect(gate.onToolExecEnd(true, apError({ summary: "third try" })))
			.toEqual({ terminal: true, newlyTerminal: true });
	});

	it("回显段 JSON 损坏 / 非 plain object → keys 不贡献，退化为错误行块口径（解析失败降级）", () => {
		const errorOnly = `Validation failed for tool "structured-output":\n${AP_ERROR_LINE}`;
		// 截断损坏的回显段：JSON.parse 失败 → 跳过 keys，与无回显段同签名
		const corrupted = `${errorOnly}\n\nReceived arguments:\n{"summary": "trunca`;
		expect(normalizeErrorSignature(corrupted)).toBe(normalizeErrorSignature(errorOnly));
		// 数组 / null 实参（协议外畸形形态）：不贡献 keys，退化同上
		const arrayEcho = `${errorOnly}\n\nReceived arguments:\n[1, 2]`;
		const nullEcho = `${errorOnly}\n\nReceived arguments:\nnull`;
		expect(normalizeErrorSignature(arrayEcho)).toBe(normalizeErrorSignature(errorOnly));
		expect(normalizeErrorSignature(nullEcho)).toBe(normalizeErrorSignature(errorOnly));
	});

	it("同 keys 不同错误行 → 仍靠错误 token 区分（keys 只补坐标不掩盖错误变化）", () => {
		const typeErr = paramLayerErrorText("  - count: must be number", '{"count": "x"}');
		const otherErr = paramLayerErrorText("  - name: must be string", '{"count": "x"}');
		expect(normalizeErrorSignature(typeErr)).not.toBe(normalizeErrorSignature(otherErr));
	});
});

// ── echo keys 分桶回归（第四轮实测：并集恒定陷阱）─────────────
//
// 误杀复现（旧实现，esbuild+node 探针实证）：6 required 字段 schema 模型每轮修 1 个
// ——修好的字段从错误行缺失列表「迁移」到实参回显 keys，req token 集缩小恰好被
// keys 集增大抵消，token 并集恒为 {f1..f6} → 签名恒定 → 第 3 次 terminal 误杀。
// 修复：keys 按「是否存在 AP 错误行」门控并入（key:<name> 前缀桶）；required/
// 格式场景 keys 退出签名。五类演进语义锁定：①②③④⑤编号对应修复方案的验证清单
//（②④的 AP/required 单形态另由既有用例组锁定：AP「三多余字段逐个删除」/
// required「同缺失集合重复 3 次」、AP「同一多余字段反复失败」）。
const SIX_FIELDS = ["f1", "f2", "f3", "f4", "f5", "f6"];
/**
 * required 渐进修复第 fixedCount 轮后的真实错误形态：缺失列表 = 后缀字段（bullet
 * 路径位 = 首个缺失字段），实参回显含已修好的前 fixedCount 个字段（探针同构）。
 */
function progressiveRequiredError(fixedCount: number): string {
	const missing = SIX_FIELDS.slice(fixedCount);
	return paramLayerErrorText(
		`  - ${missing[0]}: must have required properties ${missing.join(", ")}`,
		JSON.stringify(Object.fromEntries(SIX_FIELDS.slice(0, fixedCount).map((f) => [f, 1])), null, 2),
	);
}
/** required + AP 混合错误：缺失字段 bullet + AP bullet + pretty-print 实参回显。 */
function mixedRequiredApError(missing: string[], args: Record<string, unknown>): string {
	return paramLayerErrorText(
		[
			`  - ${missing[0]}: must have required properties ${missing.join(", ")}`,
			AP_ERROR_LINE,
		].join("\n"),
		JSON.stringify(args, null, 2),
	);
}

describe("echo keys 分桶（并集恒定陷阱回归）", () => {
	it("锁定事实：旧并集口径下三步 token 并集恒定（缺失→keys 对流）——误杀根源", () => {
		// 模拟旧实现口径（req tokens ∪ 裸名 keys）：修好字段从缺失集迁入 keys 集，并集恒为全量
		const legacyUnion = (fixed: number): Set<string> =>
			new Set([...SIX_FIELDS.slice(fixed), ...SIX_FIELDS.slice(0, fixed)]);
		expect(legacyUnion(0)).toEqual(legacyUnion(1));
		expect(legacyUnion(1)).toEqual(legacyUnion(2));
	});

	it("① 核心回归：6 required 字段每轮修 1 个（缺失缩小 + keys 增大），每步新签名计数重起不触闸", () => {
		const gate = new LoopGate();
		for (let fixed = 0; fixed < 5; fixed++) {
			expect(gate.onToolExecEnd(true, progressiveRequiredError(fixed)))
				.toEqual({ terminal: false, newlyTerminal: false });
			expect(gate.consecutiveFailures).toBe(1); // keys 不进签名：缺失集缩小 = 新签名
		}
		expect(gate.terminal).toBe(false);
		// 签名级：前 3 轮互异（旧实现此三步同签名 fields(6)#…——上方探针复现场景）
		const sigs = [0, 1, 2].map((f) => normalizeErrorSignature(progressiveRequiredError(f)));
		expect(new Set(sigs).size).toBe(3);
	});

	it("② AP 渐进删除：keys 桶缩小 = 新签名（key: 前缀；演进链全量断言见既有 AP 组）", () => {
		expect(normalizeErrorSignature(apError({ a: 1, b: 2 })))
			.not.toBe(normalizeErrorSignature(apError({ a: 1 })));
	});

	it("③ required+AP 混合：两类桶 token 并存，任一桶变化 = 新签名（req 桶/keys 桶各自生效）", () => {
		// 轮 1：缺 f1,f2 且实参带多余 extra（req 桶 + AP 桶同时报错）
		const r1 = mixedRequiredApError(["f1", "f2"], { extra: 1 });
		// 轮 2：修好 f2（req 桶 {f1,f2}→{f1} 缩小；keys {extra}→{f2,extra} 增大）
		// ——旧实现并集恒 {f1,f2,root,extra} 同签名（对流陷阱的混合形态），分桶后互异
		const r2 = mixedRequiredApError(["f1"], { f2: 2, extra: 1 });
		// 轮 3：删掉 extra（req 桶不变；keys 桶缩小）
		const r3 = mixedRequiredApError(["f1"], { f2: 2 });
		const s1 = normalizeErrorSignature(r1);
		const s2 = normalizeErrorSignature(r2);
		const s3 = normalizeErrorSignature(r3);
		expect(s1).not.toBe(s2); // req 桶变化 → 新签名
		expect(s2).not.toBe(s3); // keys 桶变化 → 新签名
		expect(s1).not.toBe(s3);
		// 闸门级：三步计数重起不触闸
		const gate = new LoopGate();
		for (const r of [r1, r2, r3]) {
			expect(gate.onToolExecEnd(true, r)).toEqual({ terminal: false, newlyTerminal: false });
			expect(gate.consecutiveFailures).toBe(1);
		}
	});

	it("④ 同错反复（混合形态）：两类桶 token 恒同 → 第 3 次仍触闸（闸门有界语义保留）", () => {
		const gate = new LoopGate();
		const err = mixedRequiredApError(["f1"], { f2: 2, extra: 1 });
		gate.onToolExecEnd(true, err);
		gate.onToolExecEnd(true, err);
		expect(gate.onToolExecEnd(true, err)).toEqual({ terminal: true, newlyTerminal: true });
	});

	it("⑤ 纯格式错误（pattern/format）：路径 token 语义与分桶前一致——同集合同签名（keys 不干扰），集合缩小新签名", () => {
		const formatError = (fields: string[], echo: string): string =>
			paramLayerErrorText(fields.map((f) => `  - ${f}: must match format "email"`).join("\n"), echo);
		// 同路径集合：回显 keys 变化（+extra）不进签名 → 同签名（错误行 token 独家刻画）
		expect(normalizeErrorSignature(formatError(["email"], '{"email": "x"}')))
			.toBe(normalizeErrorSignature(formatError(["email"], '{"email": "x", "extra": 1}')));
		// 修好一个格式错误 → 路径集合缩小 → 新签名
		expect(normalizeErrorSignature(formatError(["email", "url"], "{}")))
			.not.toBe(normalizeErrorSignature(formatError(["email"], "{}")));
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
