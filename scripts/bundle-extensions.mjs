#!/usr/bin/env node
/**
 * bundle-extensions.mjs — 用 esbuild 把 9 个 builtin pi extension 各自 bundle 成
 * 自包含 .js，解决 prepare-builtin-extensions.sh 旧机制的根本缺陷。
 *
 * 旧机制（"拷源码 + 人工声明 PKG_DEPS + 从根 node_modules 拷依赖"）的两个根因：
 *  1. workspace 包（@xyz-agent/*、@zhushanwen/*）不在根 node_modules（pnpm hoisted），
 *     copy_dep 从根 node_modules 拷不到 → staged 缺依赖 → pi 加载报 Cannot find module。
 *  2. PKG_DEPS 人工维护，与 package.json 无机械同步，新增 value import 漏声明即断链。
 *
 * 新机制：esbuild 在构建期静态分析 import，把所有可 inline 的 value 依赖打进单个
 * index.js。只有 pi 运行时 virtualModules 标 external（pi 进程注入，无需 staged 自带）。
 * 从结构上消除上述两个根因，并兑现 G3（新增静态 value 依赖不改脚本）。
 *
 * 产物（apps/electron/resources/extensions/@zhushanwen/<pkg>/）：
 *  - index.js + index.js.map（所有 JS value dep inline）
 *  - package.json（pi.extensions 改指 ./index.js；源码 package.json 不动）
 *  - permission 额外含 tree-sitter-bash.wasm + web-tree-sitter.wasm（手动拷贝，与 index.js 同目录）
 *
 * external 边界权威源：0.80.3 pi binary virtualModules 实测（见
 * .xyz-harness/2026-08-11-builtin-extension-bundling/design.md §1.1）。
 *  - @earendil-works/*（pi-coding-agent / pi-ai / pi-tui / pi-agent-core 等）
 *  - @mariozechner/*（旧名别名）
 *  - typebox / @sinclair/typebox（pi binary 内提供）
 * 其余（@xyz-agent/extension-protocol、@zhushanwen/pi-* workspace value dep、
 * web-tree-sitter、ajv、croner 等）全部 inline。
 *
 * Usage: node scripts/bundle-extensions.mjs
 */
import { build } from "esbuild";
import { readFile, writeFile, copyFile, cp, mkdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** builtin 包清单 SSOT：packages/shared/src/mandatory-extensions.json */
const BUILTIN_PACKAGES = JSON.parse(
	await readFile(join(REPO_ROOT, "packages/shared/src/mandatory-extensions.json"), "utf8"),
);

const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");
const STAGED_ROOT = join(REPO_ROOT, "apps/electron/resources/extensions/@zhushanwen");

/**
 * pi 运行时 virtualModules — external（pi 进程注入，staged 不自带）。
 * typebox / @sinclair/typebox 加 /* 后缀确保子路径（typebox/value 等）也 external。
 */
const EXTERNAL = [
	"@earendil-works/*",
	"@mariozechner/*",
	"typebox",
	"typebox/*",
	"@sinclair/typebox",
	"@sinclair/typebox/*",
];

/** 包名 @zhushanwen/pi-<x> → 源码目录 extensions/<x>/ */
function srcDirFor(pkgName) {
	const short = pkgName.replace(/^@zhushanwen\/pi-/, "");
	return join(EXTENSIONS_DIR, short);
}

function fmtSize(bytes) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
	return `${(bytes / (1024 * 1024)).toFixed(2)}mb`;
}

/**
 * pi manifest 资源字段（agents/skills/workflows）：声明引用非 JS bundle 内容
 * （agent .md / skill / workflow .js），必须随 bundle 整体拷贝。
 * 缺失后果（M6a-04）：staged 目录不是 resource-discovery 扫描源，migrate 移除 npm 记录后
 * 新装用户不再有 npm 副本——不拷则 subagent-workflow 的内置 agents/skills 对新装用户整体消失。
 */
const MANIFEST_RESOURCE_FIELDS = ["agents", "skills", "workflows"];

/**
 * permission 的 2 个 wasm：从 node_modules 拷到 staged 与 index.js 同目录。
 * loader.ts 的 resolveWasmPaths() 双模式 bundle 分支用 fileURLToPath(import.meta.url)
 * 定位 index.js 目录后，在同目录查这 2 个 wasm 文件名。
 */
const PERMISSION_WASM = [
	["tree-sitter-bash/tree-sitter-bash.wasm", "tree-sitter-bash.wasm"],
	["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
];

async function bundleOne(pkgName) {
	const short = pkgName.replace(/^@zhushanwen\/pi-/, "");
	const srcDir = srcDirFor(pkgName);
	const entry = join(srcDir, "index.ts");
	// staged 目录名用 pkgName 的 name 部分（pi-ask-user），不含 scope 前缀
	// （STAGED_ROOT 已含 @zhushanwen scope 目录）
	const pkgDirName = pkgName.split("/")[1];
	const outDir = join(STAGED_ROOT, pkgDirName);

	if (!existsSync(entry)) {
		throw new Error(`entry not found: ${entry} (源码目录 ${srcDir} 缺 index.ts)`);
	}

	await mkdir(outDir, { recursive: true });

	const result = await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node18",
		sourcemap: true,
		keepNames: true,
		external: EXTERNAL,
		outfile: join(outDir, "index.js"),
		// import.meta.url 在 ESM format 下保留（已实测），loader.ts 用它定位 bundle 目录
		logLevel: "warning",
	});

	// permission 特殊处理（R1）：拷 2 个 wasm 到 staged 与 index.js 同目录
	let extraAssets = [];
	if (short === "permission") {
		for (const [depRel, outName] of PERMISSION_WASM) {
			const src = join(REPO_ROOT, "node_modules", depRel);
			const dest = join(outDir, outName);
			if (!existsSync(src)) {
				throw new Error(
					`permission wasm 源缺失: ${src}（先 pnpm install 确保依赖安装）`,
				);
			}
			await copyFile(src, dest);
			extraAssets.push(outName);
		}
	}

	// 改写 staged 副本 package.json：pi.extensions 指向 ./index.js（不改源码 package.json）
	const pkg = JSON.parse(await readFile(join(srcDir, "package.json"), "utf8"));
	if (pkg.pi && Array.isArray(pkg.pi.extensions)) {
		pkg.pi.extensions = ["./index.js"];
	}
	await writeFile(join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");

	// M6a-04：pi.{agents,skills,workflows} 引用的资源目录随 bundle 拷贝。
	// 引用值是相对路径（如 "./agents"），解析到源码目录后整目录拷贝（filter 排除
	// node_modules）。缺失即 fail-fast（manifest 声明了但源码缺 = 打包配置回归）。
	const copiedManifestDirs = [];
	for (const field of MANIFEST_RESOURCE_FIELDS) {
		const refs = pkg.pi?.[field];
		if (!Array.isArray(refs)) continue;
		for (const ref of refs) {
			if (typeof ref !== "string") continue;
			const rel = ref.replace(/^\.\//, "");
			const src = join(srcDir, rel);
			const dest = join(outDir, rel);
			if (!existsSync(src)) {
				throw new Error(
					`pi.${field} 引用缺失: ${src}（源码目录 ${srcDir} 缺 ${rel}）`,
				);
			}
			await cp(src, dest, {
				recursive: true,
				filter: (s) => !s.includes(`${sep}node_modules${sep}`),
			});
			copiedManifestDirs.push(`${field}:${rel}`);
		}
	}

	const jsStat = await stat(join(outDir, "index.js"));
	return {
		pkgName,
		short,
		size: jsStat.size,
		warnings: result.warnings || [],
		extraAssets,
		manifestDirs: copiedManifestDirs,
	};
}

async function main() {
	// 清空 staged 根后重建：防旧机制（拷源码）残留的 index.ts/src 旁路 bundle
	// （extension-resolver resolveExtensionEntries 的 pi.extensions 优先级最高，
	// 但若 staged package.json 退化或缺 pi.extensions，fallback 顺序 index.ts 优先于
	// index.js，残留 .ts 会让 pi 加载源码旁路 bundle，bug 原样存在）。
	await rm(STAGED_ROOT, { recursive: true, force: true });
	await mkdir(STAGED_ROOT, { recursive: true });

	console.log("=== bundle-extensions: esbuild self-contained bundles ===");
	console.log(`staged root: ${STAGED_ROOT}`);
	console.log(`packages: ${BUILTIN_PACKAGES.length}`);
	console.log("");

	const results = [];
	for (const { name } of BUILTIN_PACKAGES) {
		process.stdout.write(`  bundling ${name}...`);
		try {
			const r = await bundleOne(name);
			results.push(r);
			const warn = r.warnings.length ? ` (${r.warnings.length} warnings)` : "";
			const assets = r.extraAssets.length ? ` + ${r.extraAssets.join(", ")}` : "";
			const dirs = r.manifestDirs.length ? ` + manifest[${r.manifestDirs.join(", ")}]` : "";
			console.log(` ${fmtSize(r.size)}${assets}${dirs}${warn}`);
		} catch (err) {
			console.log(" FAILED");
			console.error(`\n[bundle-extensions] ${name} 打包失败:`);
			console.error(err.stack || err.message);
			process.exit(1);
		}
	}

	console.log("");
	console.log("=== bundle complete ===");
	for (const r of results) {
		const assets = r.extraAssets.length ? ` + ${r.extraAssets.join(", ")}` : "";
		const dirs = r.manifestDirs.length ? ` + manifest[${r.manifestDirs.join(", ")}]` : "";
		console.log(`  ${r.pkgName}: index.js ${fmtSize(r.size)}${assets}${dirs}`);
	}
	const total = results.reduce((s, r) => s + r.size, 0);
	console.log(`  ────────────`);
	console.log(`  total index.js: ${fmtSize(total)} (${results.length} packages)`);

	// 有 esbuild warning 时汇总提示（不阻断，warning 多为 tree-shaking 建议）
	const totalWarnings = results.reduce((s, r) => s + r.warnings.length, 0);
	if (totalWarnings > 0) {
		console.log("");
		console.log(`[hint] ${totalWarnings} esbuild warning(s) — 多为 tree-shaking 建议，详见上方输出`);
	}
}

main();
