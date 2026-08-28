// 跨包契约测试（MF-6）：structured-output ↔ subagent-workflow
//
// 两包是独立 npm 包不能直接 import（发布产物里跨包相对 import 悬空）——env 名 /
// schema 大小上限等契约常量各自保留副本，本文件在测试期动态 import SW 侧源码叶子
// 模块，锁「字节相等」防止任一端静默改名/改值（漂移守卫）。
//
// 降级策略：SW 侧叶子模块未就位 / 模块结构不符（import 失败、导出缺失）时，
// 用例 skip + TODO 标注，不阻塞本包测试；SW 侧抽出/导出后自动生效。
//
// ② 组的背景（mock 失真图谱）：SO 测试环境把 "typebox" alias 到本地 mock
//（mocks/typebox.ts），SW 侧工具 schema 常量若经 mock 校验会失真——故 SW schema
// 一律用 createRequire 绕过 alias 拿真实 typebox 编译校验（required/description
// 保留 = schema 语义未在转换链路中丢失的回归保护）。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { ENV_SCHEMA, SO_SCHEMA_SIZE_WARN_BYTES } from "../src/index.js";

/**
 * 动态 import 相对路径（本文件目录为基准）。注：不能用裸相对 specifier——Vite
 * 运行时对变量的相对 specifier 会相对项目根折叠（"../../x" → "/x"，实测）
 * 而非相对本文件；file URL 绝对路径是稳定通路。
 */
async function dynamicImportRelative(spec: string): Promise<unknown> {
	const here = dirname(fileURLToPath(import.meta.url));
	return import(pathToFileURL(join(here, spec)).href);
}

// ── ① schema env 契约（PI_WORKFLOW_SCHEMA / 256KiB 上限）─────────────────

/** SW 侧叶子模块候选路径（相对本文件）。SW 侧调整叶子布局时在此追加候选。 */
const SW_SCHEMA_ENV_CANDIDATES = ["../../subagent-workflow/src/shared/schema-env.ts"];

async function tryImportSwSchemaEnv(): Promise<Record<string, unknown> | undefined> {
	for (const spec of SW_SCHEMA_ENV_CANDIDATES) {
		try {
			const mod = (await dynamicImportRelative(spec)) as Record<string, unknown>;
			if (mod && typeof mod.SCHEMA_ENV_VAR === "string") return mod;
		} catch {
			// 模块不存在 / 依赖链断裂 → 下一候选（SW 侧叶子未就位时用例 skip）
		}
	}
	return undefined;
}

describe("cross-package contract: schema env（structured-output ↔ subagent-workflow）", () => {
	it("SW SCHEMA_ENV_VAR 与 SO ENV_SCHEMA 字节相等（env 名漂移守卫）", async (ctx) => {
		const mod = await tryImportSwSchemaEnv();
		if (!mod) {
			// TODO(subagent-workflow): SW 侧叶子模块未就位（schema-env.ts 未抽出或路径变更）。
			// 抽出后本用例自动生效；期间两侧常量靠各自 [跨包契约 SSOT] 注释人工对齐。
			ctx.skip();
			return;
		}
		expect(mod.SCHEMA_ENV_VAR).toBe(ENV_SCHEMA);
	});

	it("SW SCHEMA_ENV_MAX_BYTES 与 SO SO_SCHEMA_SIZE_WARN_BYTES 字节相等（SO 提示线 = SW 硬拒线，SO-DATA-4）", async (ctx) => {
		const mod = await tryImportSwSchemaEnv();
		if (!mod || typeof mod.SCHEMA_ENV_MAX_BYTES !== "number") {
			ctx.skip(); // TODO 同上：SW 侧叶子未就位时跳过，不阻塞
			return;
		}
		expect(mod.SCHEMA_ENV_MAX_BYTES).toBe(SO_SCHEMA_SIZE_WARN_BYTES);
	});
});

// ── ② SW tool schema 常量校验（真实 typebox，mock 失真对照基准）────────────

/**
 * 尝试从 SW 侧模块定位「schema 形态」的叶子导出（含 properties 的对象）。
 * SW 侧 Params schema（SubagentParams 等）目前为模块内私有未导出 → 返回空对象
 * → 用例 skip + TODO。SW 侧补叶子导出后无需改本文件（自动发现）。
 */
async function tryLocateSwToolSchemas(): Promise<Record<string, unknown>> {
	const candidates = ["../../subagent-workflow/src/interface/subagent-tool.ts"];
	const found: Record<string, unknown> = {};
	for (const spec of candidates) {
		try {
			const mod = (await dynamicImportRelative(spec)) as Record<string, unknown>;
			for (const [name, value] of Object.entries(mod)) {
				if (
					value !== null && typeof value === "object" && !Array.isArray(value)
					&& "properties" in (value as object)
				) {
					found[`${spec}#${name}`] = value;
				}
			}
		} catch {
			// SW 模块依赖链在 SO 测试环境不可解析 → 视为未定位
		}
	}
	return found;
}

describe("cross-package contract: SW tool schema（真实 typebox 校验）", () => {
	it("SW 工具 schema 真实 typebox 编译成功，required/description 保留", async (ctx) => {
		const schemas = await tryLocateSwToolSchemas();
		if (Object.keys(schemas).length === 0) {
			// TODO(subagent-workflow): SW 侧 tool schema 常量（SubagentParams 等）尚未叶子导出。
			// 导出后本用例自动生效；期间 schema 回归由 SW 包自身测试覆盖。
			ctx.skip();
			return;
		}
		// 真实 typebox：vitest alias 把 "typebox" 指向 SO 本地 mock，createRequire 走
		// node 解析绕过 alias（Compile 在 typebox v1 的 ./compile 子路径）。
		const nodeRequire = createRequire(import.meta.url);
		const realTypebox = nodeRequire("typebox/compile") as {
			Compile: (schema: unknown) => { Check: (value: unknown) => boolean };
		};
		for (const [name, schema] of Object.entries(schemas)) {
			const compiled = (() => {
				try {
					return realTypebox.Compile(schema);
				} catch (err) {
					throw new Error(`SW schema ${name} failed to compile with real typebox: ${err instanceof Error ? err.message : String(err)}`);
				}
			})();
			expect(typeof compiled.Check).toBe("function");
			// description 保留：声明了 description 的属性必须是非空字符串（转换链路丢
			// description 会直接削弱模型对参数的理解——mock 失真图谱的高发形态）
			const props = (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
			for (const [propName, propSchema] of Object.entries(props)) {
				if ("description" in propSchema) {
					expect(typeof propSchema.description === "string" && propSchema.description.length > 0,
						`${name}.${propName} description preserved`).toBe(true);
				}
			}
			// required 保留：若声明则必须是字符串数组（丢 required = 必填约束静默失效）
			const required = (schema as { required?: unknown }).required;
			if (required !== undefined) {
				expect(Array.isArray(required) && required.every((r) => typeof r === "string"),
					`${name}.required preserved as string[]`).toBe(true);
			}
		}
	});
});
