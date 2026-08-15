#!/usr/bin/env node
/**
 * rename-session E2E 总结 runner：顺序跑 A1-A5，单场景失败不阻断后续，
 * 最后汇总表 + 总 exit code（任一 assertion 类失败 → 1；A2 的 KEBAB_NON_COMPLIANT
 * 是模型遵从问题，不翻 exit code 但在汇总中如实呈现）。
 *
 * 用法：cd extensions/rename-session && node e2e/run-all.mjs
 * 调试保留现场：E2E_KEEP_TMP=1 node e2e/run-all.mjs
 */

import { runA1 } from "./run-a1.mjs";
import { runA2 } from "./run-a2.mjs";
import { runA3 } from "./run-a3.mjs";
import { runA4 } from "./run-a4.mjs";
import { runA5 } from "./run-a5.mjs";

const SCENARIOS = [
	{ name: "A1", run: runA1 },
	{ name: "A2", run: runA2 },
	{ name: "A3", run: runA3 },
	{ name: "A4", run: runA4 },
	{ name: "A5", run: runA5 },
];

const t0 = Date.now();
const results = [];
for (const s of SCENARIOS) {
	console.log(`\n════════ ${s.name} ════════`);
	// runScenario 内部 catch（失败不阻断后续），此处 await 不会抛
	results.push(await s.run());
}

// ── 汇总 ──
console.log(`\n════════ E2E 汇总（${((Date.now() - t0) / 1000).toFixed(1)}s）════════`);
for (const r of results) {
	const status = r.ok ? "PASS" : `FAIL [${r.kind ?? "assertion"}]`;
	const kebab = r.kebabNonCompliant ? `  KEBAB_NON_COMPLIANT: "${r.kebabNonCompliant.title}"（模型遵从问题，人工按 spec 处置）` : "";
	console.log(`${r.name}: ${status} (${(r.durationMs / 1000).toFixed(1)}s)${kebab}`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
	console.log(`\n失败明细（${failed.length} 个）:`);
	for (const r of failed) console.log(`  ${r.name} [${r.kind ?? "assertion"}]: ${r.error?.message ?? ""}`);
}
const exit = failed.length > 0 ? 1 : 0;
console.log(`\nexit code: ${exit}`);
process.exitCode = exit;
