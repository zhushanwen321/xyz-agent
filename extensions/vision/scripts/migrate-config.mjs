/**
 * [HISTORICAL] vision 配置迁移脚本（幂等，可长期保留）
 *
 * 迁移：<agentDir>/vision-models.json → <agentDir>/config/vision.json
 *
 * 触发时机（迁移在 npm 安装时自动完成，运行时不双读旧路径）：
 * - 原生 pi：`pi install npm:@zhushanwen/pi-vision` 走真实 npm CLI → postinstall
 * - xyz-agent：extension-service 装后 hook 执行（package.json `pi.migrate` 声明）
 *
 * agentDir 解析优先级：argv[2]（hook 显式传入）> env.PI_CODING_AGENT_DIR > 默认 ~/.pi/agent。
 * 幂等：旧路径不存在 → noop；新路径已存在 → 不覆盖（仅删旧）；失败 → warn + 不抛错（不阻断安装）。
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** 解析 agentDir：argv[2] > PI_CODING_AGENT_DIR > 默认 ~/.pi/agent。 */
export function resolveAgentDir(argv2, env) {
	return argv2 || env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * 迁移单个文件：旧路径存在 → 原子搬移到新路径（renameSync，同盘跨目录）。
 * 新路径已存在 → 不覆盖也不删旧（新文件可能是已迁移副本或用户放置，旧文件保留
 *   作为回退证据，仅 warn——宁可残留 stale 文件，不可丢用户数据）；旧不存在 → noop。
 * 失败 → warn + 返回 { migrated:false }，不抛错（best-effort，下次安装重试）。
 */
export function migrateFile(agentDir, oldRel, newRel) {
	const oldPath = join(agentDir, oldRel);
	if (!existsSync(oldPath)) return { migrated: false };
	const newPath = join(agentDir, newRel);
	try {
		mkdirSync(dirname(newPath), { recursive: true });
		if (existsSync(newPath)) {
			console.warn(`[migrate-config] new config already exists, keeping legacy file: ${oldPath}`);
			return { migrated: false, keptLegacy: true };
		}
		renameSync(oldPath, newPath);
		console.warn(`[migrate-config] migrated: ${oldPath} -> ${newPath}`);
		return { migrated: true };
	} catch (e) {
		console.warn(`[migrate-config] migration failed for ${oldPath} -> ${newPath}:`, e);
		return { migrated: false, error: e };
	}
}

/** vision 配置迁移入口：vision-models.json → config/vision.json。 */
export function migrateConfig(agentDir) {
	migrateFile(agentDir, "vision-models.json", join("config", "vision.json"));
}

// 直接执行入口（postinstall / extension-service hook）；被 import（测试）时不执行
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
	migrateConfig(resolveAgentDir(process.argv[2], process.env));
}
