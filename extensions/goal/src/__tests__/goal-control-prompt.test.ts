// 提示词质量回归：goal_control tool description + runtime 错误文案必须是
// "可纠正的行为约束器"，而非干巴巴的错误。
//
// agent（LLM）唯一能看到的 tool 元信息就是 description + 报错文案。description 用中文
// 重写（动作 create/complete/report_blocked + 规则 + §2.5 终态语义），删除英文 Examples/Don't
// 段；runtime throw 保留 .trim() 空串校验 + 'Correct:' 纠正正例（缺失必填已前移到 schema
// discriminated union 层拒绝，C3）。
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把中文语义/纠错文案/
// union 结构删掉。读源码而非 import，避免 mock 链（goal-control-adapter.ts 依赖
// pi-ai/typebox/pi-tui/ExtensionAPI 等值导入）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = readFileSync(
	join(__dirname, "../adapters/goal-control-adapter.ts"),
	"utf-8",
);

/** 提取 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
	const m = src.match(/description:\s*`([\s\S]*?)`/);
	if (!m) throw new Error("description template literal not found");
	return m[1];
}

const DESCRIPTION = extractDescription(ADAPTER_SRC);

// ── description 中文化 + 动作覆盖 ──

describe("goal_control description — 中文化 + 动作覆盖", () => {
	it("含管理目标总述", () => {
		expect(DESCRIPTION).toContain("管理当前会话的目标");
	});

	it("含 create 动作", () => {
		expect(DESCRIPTION).toContain("create");
	});

	it("含 complete 动作 + 满足 successCriteria 条件", () => {
		expect(DESCRIPTION).toContain("complete");
		expect(DESCRIPTION).toContain("满足每条 successCriteria 条件");
	});

	it("含 report_blocked 动作", () => {
		expect(DESCRIPTION).toContain("report_blocked");
	});
});

// ── §2.5 终态语义（TC8）──

describe("goal_control description — §2.5 终态语义", () => {
	it("A4: create 失败提示 /goal resume 或 /goal clear（中文）", () => {
		expect(DESCRIPTION).toContain("请让用户运行 /goal resume 或 /goal clear");
	});

	it("complete 报告最终 token 用量", () => {
		expect(DESCRIPTION).toContain("报告最终 token 用量");
	});

	it("pause/resume/budget 归用户经 /goal 控制", () => {
		expect(DESCRIPTION).toContain("pause/resume 和 budget 变更由用户经 /goal 命令控制");
	});

	it("达到阻塞阈值后报告，不反复报告同一阻塞", () => {
		expect(DESCRIPTION).toContain("不要反复报告同一阻塞");
	});
});

// ── 删除英文 Examples/Don't 段 ──

describe("goal_control description — 删除 Examples/Don't 英文段", () => {
	it("不含 Examples JSON 正例段（{\"action\":\"create\"}）", () => {
		// Examples 段已删，description 不再含裸 JSON 正例
		expect(DESCRIPTION).not.toContain('{"action":"create"');
	});

	it("不含 Don't 段", () => {
		expect(DESCRIPTION).not.toMatch(/Don't/);
	});
});

// ── schema discriminated union（C3，CT3）──

describe("goal_control schema — discriminated union（C3）", () => {
	it("源码含 Type.Union", () => {
		expect(ADAPTER_SRC).toMatch(/Type\.Union\(/);
	});

	it("各分支 additionalProperties:false", () => {
		expect(ADAPTER_SRC).toContain("additionalProperties: false");
	});

	it("无 timeBudgetMinutes 字段（time budget 已移除）", () => {
		expect(ADAPTER_SRC).not.toMatch(/timeBudgetMinutes/);
	});
});

// ── promptGuidelines 主动触发引导 ──

describe("goal_control promptGuidelines — complete/report_blocked 主动触发引导", () => {
	it("源码含 promptGuidelines 字段", () => {
		expect(ADAPTER_SRC).toMatch(/promptGuidelines:\s*\[/);
	});

	it("含 complete 主动触发信号（proactively + objective is actually achieved）", () => {
		expect(ADAPTER_SRC).toMatch(/complete:.*proactively call.*objective is actually achieved/s);
	});

	it("含 report_blocked 主动触发信号（proactively + ≥3 approaches + 不反复报告）", () => {
		expect(ADAPTER_SRC).toMatch(/report_blocked:.*proactively call.*≥3 distinct alternative approaches/s);
		expect(ADAPTER_SRC).toContain("do not repeatedly report the same blocker");
	});
});

// ── runtime 错误文案含 'Correct:' 纠正正例 ──

describe("goal_control runtime 错误文案 — 含 'Correct:' 纠正正例（≥4 处）", () => {
	it("源码含 ≥4 处 'Correct:'（4 条空串 throw 各一带正例）", () => {
		// objective/successCriteria/evidence/reason 四条空串 throw 各应带完整 JSON 正例，
		// 让弱模型在报错后无需猜测即可纠正。读整份源码统计出现次数。
		const matches = ADAPTER_SRC.match(/Correct:/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
	});

	it("objective 报错带 Correct 正例", () => {
		expect(ADAPTER_SRC).toMatch(/'objective' must not be empty[\s\S]*?Correct:/);
	});

	it("evidence 报错带 Correct 正例", () => {
		expect(ADAPTER_SRC).toMatch(/'evidence' must not be empty[\s\S]*?Correct:/);
	});
});

// ── 描述修正（A1/slug optional）──

describe("goal_control 描述修正（A1/slug optional）", () => {
	it("A1: 全文不含 'at least 3 approaches'（reason schema desc/throw 已删强制 ≥3 声明）", () => {
		expect(ADAPTER_SRC).not.toMatch(/at least 3 approaches/);
	});

	it("A1: reason throw 含 'what you tried'", () => {
		expect(ADAPTER_SRC).toMatch(/'reason' must not be empty[\s\S]*?what you tried/);
	});

	it("slug 真 optional：schema desc 中文含'可选'，handleCreate 不再 throw slug 必填", () => {
		expect(ADAPTER_SRC).toContain("可选。");
		expect(ADAPTER_SRC).not.toMatch(/'slug' is required/);
	});
});
