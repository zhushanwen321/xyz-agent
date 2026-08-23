/**
 * 路径工具 — 统一从 Pi 的 getAgentDir() 派生所有路径
 *
 * 设计要点：
 * - 不做老路径 fallback（~/.pi/...），全部用 getAgentDir() 提供的新位置
 * - resolveEnvRef 支持 ${ENV_VAR} 占位符，无环境变量时静默返回空串
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("quota-providers");

/** quota-providers 配置根目录（<agentDir>/config/） */
export function getConfigDir(): string {
	return join(getAgentDir(), "config");
}

/** providers.json 完整路径 */
export function getProvidersConfigPath(): string {
	return join(getConfigDir(), "providers.json");
}

/** secrets.json 完整路径 */
export function getSecretsPath(): string {
	return join(getConfigDir(), "secrets.json");
}

/** 用量缓存文件路径（<agentDir>/config/quota-cache.json）。 */
export function getCachePath(): string {
	return join(getConfigDir(), "quota-cache.json");
}

/** token-stats 目录 */
export function getSpeedDir(): string {
	return join(getAgentDir(), "token-stats");
}

/** 记录已 warn 过的 env var，避免每次 render 都打印 */
const warnedEnvVars = new Set<string>();

/** 解析 ${ENV_VAR} 引用；环境变量缺失时 warn 一次并返回空串 */
export function resolveEnvRef(value: string): string {
	const m = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
	if (!m) return value;
	const name = m[1]!;
	const envVal = process.env[name];
	if (envVal === undefined) {
		if (!warnedEnvVars.has(name)) {
			logger.warn("env var not set", { detail: { envVar: name } });
			warnedEnvVars.add(name);
		}
		return "";
	}
	return envVal;
}
