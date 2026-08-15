/**
 * E2E 场景 A1-A5 的 vitest 包装（cw test gate 兼容）。
 *
 * 背景：cw test gate 用 vitest 输出解析器统计 `N passed` / `N failed`，
 * `node e2e/run-all.mjs` 的自定义表格输出解析不到（passed=0）。本文件把 5 个
 * 场景包装成 vitest test（从 run-aN.mjs import 场景函数），gate 即可统计。
 *
 * gate 语义转换：runScenario 内部 catch 不抛（单场景失败不阻断后续），返回
 * { ok, kind?, error?, logs }；vitest test 视角必须把不 ok 转为 throw 使 test 失败。
 * A2 的 KEBAB_NON_COMPLIANT（模型遵从问题）在独立执行路径不翻 exit code、交人工处置，
 * 但在 gate 语义下计失败（throw 含实际标题）——与 run-a2.mjs 头注释的处置约定一致。
 *
 * 真实模型 + 真实 pi 子进程，串行跑全量约 5-6 分钟（A2 三个 session 最长）。
 * 人工汇总 runner 仍是 e2e/run-all.mjs（输出四分类汇总 + RESULTS.md 追加），与本文件互补。
 */

import { describe, it } from "vitest";

import { runA1 } from "./run-a1.mjs";
import { runA2 } from "./run-a2.mjs";
import { runA3 } from "./run-a3.mjs";
import { runA4 } from "./run-a4.mjs";
import { runA5 } from "./run-a5.mjs";

/**
 * 场景结果 → gate 语义：ok=false 或 A2 kebab 非合规时 throw（vitest test 失败）。
 * 错误信息带失败分类 + 完整场景日志（runScenario 已把 FAIL 行与 stack 收进 logs）。
 */
function toGate(result) {
	if (!result.ok) {
		throw new Error(
			`[${result.name}] FAIL [${result.kind ?? "assertion"}]: ${result.error?.message ?? result.error}\n` +
				result.logs.join("\n"),
		);
	}
	if (result.kebabNonCompliant) {
		const k = result.kebabNonCompliant;
		throw new Error(
			`[${result.name}] KEBAB_NON_COMPLIANT [${k.label}] 实际标题 "${k.title}": ${k.violation}` +
				`（模型遵从问题，按 spec 人工处置路径；gate 语义计失败）`,
		);
	}
}

// timeout 按实测耗时 3 倍以上余量：A1 11.4s / A2 192.2s / A3 33.3s / A4 11.7s / A5 34.1s。
// A2 用 2100s：2026-08-15 实测模型延迟系统性变慢（前日 A2 全程 192s，当日单 case 超 300s
// 两次击穿旧上限），run-a2.mjs 场景内 settled 上限随之调至 600s；本值按新理论最坏
// （3 case × (settled 600s + rename wait 45s + spawn 开销) ≈ 1950s）取整。
describe("E2E 场景 A1-A5（真实 pi + 真实模型）", () => {
	it("A1 工具型首轮：round 末触发 + 两段输入证据链", async () => {
		toGate(await runA1());
	}, 120_000);

	it("A2 slug 标题风格：中文 / 英文 / 跟进型 ×3 prompt 标题守卫", async () => {
		toGate(await runA2());
	}, 2_100_000);

	it("A3 防覆盖手动命名：3a 静态 + 3b 竞态 + 3c 一次性语义", async () => {
		toGate(await runA3());
	}, 120_000);

	it("A4 error 轮不命名 + --session 续跑后下一成功轮命名", async () => {
		toGate(await runA4());
	}, 120_000);

	it("A5 超时兜底：hang provider 30s 超时不落库 + pi 存活", async () => {
		toGate(await runA5());
	}, 120_000);
});
