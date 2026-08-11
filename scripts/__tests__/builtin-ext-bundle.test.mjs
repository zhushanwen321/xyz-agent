/**
 * builtin-ext-bundle wave 的机器验证测试（TC3/TC4/TC7，verification=unit）。
 *
 * 这三个 testCase 覆盖 esbuild bundle 方案的核心保证：
 *  - TC3：新增静态 value 依赖自动 inline（G3）—— 验 staged 产物含 inline 的 protocol value
 *  - TC4：跨 ext workspace value import 自动 inline —— 验 goal 产物含 countActiveFromEntries
 *  - TC7：fail-fast 拦截残缺产物 —— 验 verify-staged 对缺 wasm 的产物 exit 1
 *
 * 依赖前置：testCommand 先跑 prepare-builtin-extensions.sh 产出 staged 产物，本测试只读校验。
 * TC1/TC2/TC5/TC6（dev/packaged 发会话、permission 解析 bash、source map）是 integration/e2e/manual，留 T7/T8。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const REPO = process.cwd();
const STAGED = join(REPO, "apps/electron/resources/extensions/@zhushanwen");

describe("builtin-ext-bundle (wave:builtin-ext-bundle)", () => {
	it("TC3: bundle 自动 inline 静态 value 依赖（pi-ask-user 含 @xyz-agent/extension-protocol 的 runtime export）", () => {
		const idx = join(STAGED, "pi-ask-user/index.js");
		expect(existsSync(idx), "staged pi-ask-user/index.js 存在").toBe(true);
		const src = readFileSync(idx, "utf8");
		// @xyz-agent/extension-protocol 有 runtime value export（PROTOCOL_VERSION/ASK_USER_MARKER），
		// esbuild 应将其 inline 进 bundle（非 external）。若 inline 失败，bundle 里不会有这些标识符。
		expect(src, "protocol runtime value 被 inline").toMatch(/ASK_USER_MARKER|PROTOCOL_VERSION/);
		// 反证：protocol 不应作为 external import 残留（@xyz-agent 不是 virtualModule）
		expect(src, "无 @xyz-agent external 残留 import").not.toMatch(/from\s+["']@xyz-agent\//);
	});

	it("TC4: bundle 自动 inline 跨 ext workspace value import（pi-goal 含 pi-pending-notifications 的 countActiveFromEntries）", () => {
		const idx = join(STAGED, "pi-goal/index.js");
		expect(existsSync(idx)).toBe(true);
		const src = readFileSync(idx, "utf8");
		// countActiveFromEntries 是 goal 从 @zhushanwen/pi-pending-notifications 的 value import
		// （extensions/goal/src/adapters/event-handlers/agent-end.ts），esbuild 应 inline。
		// 这正是本 bug 的根因形态（workspace value import 旧机制拷不到），bundle 从结构上消除。
		expect(src, "countActiveFromEntries 被 inline").toMatch(/countActiveFromEntries/);
		// 反证：pi-pending-notifications 不应作为 external import 残留
		expect(src, "无 pi-pending-notifications external 残留 import").not.toMatch(
			/from\s+["']@zhushanwen\/pi-pending-notifications["']/,
		);
	});

	it("TC7: verify-staged 对残缺产物 fail-fast（pi-permission 缺 wasm → exit 1）", () => {
		// 构造残缺 staged：复制 permission（index.js + package.json）但故意不拷 2 个 wasm
		const tmpScoped = join(REPO, ".cw/builtin-ext-bundle/tmp-staged/@zhushanwen");
		const tmpPerm = join(tmpScoped, "pi-permission");
		rmSync(tmpScoped, { recursive: true, force: true });
		mkdirSync(tmpPerm, { recursive: true });
		copyFileSync(join(STAGED, "pi-permission/index.js"), join(tmpPerm, "index.js"));
		copyFileSync(join(STAGED, "pi-permission/package.json"), join(tmpPerm, "package.json"));

		const verify = join(REPO, "scripts/verify-staged-extensions.mjs");
		let exitCode = 0;
		try {
			execSync(`node "${verify}" --staged-dir "${tmpScoped}"`, { stdio: "pipe", cwd: REPO });
		} catch (err) {
			exitCode = err.status ?? 1;
		}
		rmSync(tmpScoped, { recursive: true, force: true });
		// fail-fast：缺 wasm 必须被拦截（exit 非 0），否则残缺产物会到 pi 加载时报错
		expect(exitCode, "缺 wasm 时 verify-staged exit 非 0").not.toBe(0);
	});
});
