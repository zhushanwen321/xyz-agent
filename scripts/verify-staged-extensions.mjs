#!/usr/bin/env node
/**
 * verify-staged-extensions.mjs — staged builtin extension 完整性校验门（fail-fast）。
 *
 * 对每个 staged 包做两层校验：
 *  1. 文件结构：index.js 存在、无 .ts 残留（R3：extension-resolver fallback 顺序
 *     index.ts 优先于 index.js，残留 .ts 会旁路 bundle）、pi-permission 含 2 wasm。
 *  2. dry-run import：dynamic import() 加载 index.js，捕获加载期错误
 *     （Cannot find module / SyntaxError / import 解析失败）。
 *
 * import 错误分类：
 *  - external 模块缺失（@earendil-works/*、typebox 等 pi virtualModules）→ 降级 warning。
 *    这些模块由 pi 进程运行时注入，dev 环境（staged 在仓库根，node_modules 可达）能完整
 *    import；prod 环境（Resources/extensions 无 node_modules）必然缺失，属预期，不算 bundle 缺陷。
 *  - 其它错误（inline 模块缺失、语法错误、非 external 模块缺失）→ fail。
 *    bundle 成功后 inline 模块必都在 bundle 内，此类失败表示真缺陷。
 *
 * extension 的 export default 是工厂函数，import 模块不调用工厂，不触发 pi API 调用 ——
 * 这是安全的 dry-run（验证依赖完整性，不验证功能）。
 *
 * Usage:
 *   node scripts/verify-staged-extensions.mjs                      # 默认 dev staged
 *   node scripts/verify-staged-extensions.mjs --staged-dir <path>  # 自定义（如 postbuild Resources/extensions/@zhushanwen）
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 解析 --staged-dir 参数（默认 dev staged 目录）
let STAGED_DIR = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--staged-dir" && args[i + 1]) {
		STAGED_DIR = resolve(args[i + 1]);
		i++;
	} else if (args[i] === "--help" || args[i] === "-h") {
		console.log("Usage: verify-staged-extensions.mjs [--staged-dir <path>]");
		process.exit(0);
	}
}
const STAGED = STAGED_DIR || join(REPO_ROOT, "apps/electron/resources/extensions/@zhushanwen");

/** pi 运行时 virtualModules（external）—— 缺失时降级，不视为 bundle 缺陷 */
const EXTERNAL_PREFIXES = ["@earendil-works/", "@mariozechner/", "typebox", "@sinclair/typebox"];

/**
 * 分类 import 错误：判断是否为 pi runtime 差异导致的 dev 环境假阳性。
 *
 * bundle 的正确性由 esbuild 保证（inline 完整、无语法错，否则不产出 index.js）。
 * pi 0.80.3 实测能加载全部 9 包（get_state success）。verify-staged 用 node import，
 * 与 pi jiti runtime 有两类差异，需降级（不视为 bundle 缺陷）：
 *  - external：涉及 pi virtualModules（@earendil-works/* 等），dev 环境 node_modules
 *    版本可能与 pi binary 不一致（缺失或 named export 不匹配）。
 *  - interop：esbuild inline 的 CJS 依赖产生 __require("process") 等，node ESM 不
 *    支持裸 require（报 Dynamic require of X），但 pi jiti runtime 能正常处理。
 */
function classifyImportError(err) {
	const msg = String((err && err.message) || err);
	// external 模块相关：缺失或 named export 不匹配（pi runtime 提供，dev 版本差异）
	if (EXTERNAL_PREFIXES.some((p) => msg.includes(p))) {
		return { kind: "external", msg };
	}
	// esbuild CJS→ESM interop 的 node 限制（bundle 在 pi jiti 下正常）
	if (/Dynamic require of/.test(msg)) {
		return { kind: "interop", msg };
	}
	// inline 模块缺失（bundle 应已 inline，缺失表示真缺陷）
	const m = msg.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/);
	if (m) return { kind: "inline", mod: m[1], msg };
	return { kind: "unknown", msg };
}

async function main() {
	if (!existsSync(STAGED)) {
		console.error(`[verify-staged] ✗ staged 目录不存在: ${STAGED}`);
		console.error(`[verify-staged] 恢复: bash scripts/prepare-builtin-extensions.sh`);
		process.exit(1);
	}

	const entries = await readdir(STAGED, { withFileTypes: true });
	const pkgDirs = entries
		.filter((e) => e.isDirectory() && e.name.startsWith("pi-"))
		.map((e) => e.name)
		.sort();

	if (pkgDirs.length === 0) {
		console.error(`[verify-staged] ✗ staged 无 pi-* 包目录: ${STAGED}`);
		console.error(`[verify-staged] 恢复: bash scripts/prepare-builtin-extensions.sh`);
		process.exit(1);
	}

	console.log(`=== verify-staged-extensions ===`);
	console.log(`staged: ${STAGED}`);
	console.log(`packages: ${pkgDirs.length}`);
	console.log("");

	const verified = [];
	const skipped = [];
	const failed = [];

	for (const pkg of pkgDirs) {
		const pkgDir = join(STAGED, pkg);
		const indexJs = join(pkgDir, "index.js");

		// 文件级校验 1：index.js 存在
		if (!existsSync(indexJs)) {
			failed.push({ pkg, reason: "缺 index.js（bundle 失败或未运行 prepare）" });
			continue;
		}

		// 文件级校验 2：无 .ts 残留（R3 关键防护）
		const files = await readdir(pkgDir);
		const tsResidue = files.filter((f) => f.endsWith(".ts"));
		if (tsResidue.length > 0) {
			failed.push({
				pkg,
				reason: `残留 .ts 文件 [${tsResidue.join(", ")}]，resolver fallback 会旁路 bundle（R3）`,
			});
			continue;
		}

		// dry-run import：加载 index.js，捕获依赖缺失 / 语法错误
		try {
			await import(pathToFileURL(indexJs).href);
			verified.push(pkg);
		} catch (err) {
			const { kind } = classifyImportError(err);
			const firstLine = String(err.message || err).split("\n")[0];
			if (kind === "external" || kind === "interop") {
				skipped.push({ pkg, kind, msg: firstLine });
			} else {
				failed.push({ pkg, reason: firstLine });
			}
		}
	}

	// pi-permission wasm 校验（运行时 bash 解析必需）
	const permDir = join(STAGED, "pi-permission");
	if (existsSync(permDir)) {
		for (const w of ["tree-sitter-bash.wasm", "web-tree-sitter.wasm"]) {
			if (!existsSync(join(permDir, w))) {
				failed.push({ pkg: "pi-permission", reason: `缺 ${w}（permission 将无法解析 bash）` });
			}
		}
	}

	// 输出结果
	if (verified.length > 0) {
		console.log(`✓ import 通过 (${verified.length}):`);
		for (const p of verified) console.log(`    - ${p}`);
	}
	if (skipped.length > 0) {
		console.log("");
		console.log(`ℹ import 降级 (${skipped.length}) — pi runtime 提供 / CJS interop，dev node 环境假阳性:`);
		for (const { pkg, kind, msg } of skipped) {
			console.log(`    - ${pkg} [${kind}]: ${msg}`);
		}
	}

	if (failed.length > 0) {
		console.error("");
		console.error(`✗ 失败 (${failed.length}):`);
		for (const { pkg, reason } of failed) {
			console.error(`    - ${pkg}: ${reason}`);
		}
		console.error("");
		console.error(`[verify-staged] 校验未通过，dev/build 中断。`);
		console.error(`[verify-staged] 恢复: 重新运行 bash scripts/prepare-builtin-extensions.sh`);
		process.exit(1);
	}

	console.log("");
	console.log(`[verify-staged] ✓ 全部通过（${verified.length} import + ${skipped.length} 降级 / ${pkgDirs.length} 包）`);
	process.exit(0);
}

main().catch((err) => {
	console.error(`[verify-staged] 未预期错误:`, err);
	process.exit(1);
});
