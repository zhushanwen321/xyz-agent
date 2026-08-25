// src/runtime/config/config.ts
//
// 全局配置（~/.pi/agent/subagents/config.json）。
// 仅保留 maxConcurrent（pool 大小）。模型解析已退化为「主 agent model 优先」，
// 不再有 category/fallback/session 级覆盖——相关字段读取时忽略。

import * as fs from "node:fs";
import * as path from "node:path";

import type { SubagentsGlobalConfig } from "./types.ts";

// ============================================================
// 常量
// ============================================================

/**
 * 开箱默认配置（单一真相源，内联在代码里）。
 *
 * 历史教训 [HISTORICAL]：曾用包内 config.json（与 src/ 同级）作为默认值源，
 * 但 config.json 被 .gitignore 排除且不应随 npm 包分发用户私有配置——导致
 * npm pack 后读不到文件，catch 兜底用空字段，pi install 后首次执行抛错。
 * 修复：默认值内联在代码里，不依赖任何包内文件。
 */
const DEFAULT_CONFIG: SubagentsGlobalConfig = {
  version: 1,
  maxConcurrent: 6,
};

/** 默认 maxConcurrent（DEFAULT_CONFIG 的镜像，sanitize 用）。 */
const DEFAULT_MAX_CONCURRENT = 6;
// ============================================================
// 路径
// ============================================================

/**
 * 配置文件路径（<agentDir>/subagents/config.json）。
 * agentDir 由 Pi 核心 getAgentDir() 决定（读 PI_CODING_AGENT_DIR，默认 ~/.pi/agent），
 * 与 Pi 主进程的目录约定完全一致——支持宿主经环境变量整体重定向。
 */
export function getGlobalConfigPath(agentDir: string): string {
  return path.join(agentDir, "subagents", "config.json");
}

// ============================================================
// 全局配置加载
// ============================================================

/**
 * 加载全局配置。文件不存在 / JSON 解析失败 / 字段缺失时返回默认配置。
 * 旧 config.json 中的 categories/fallback/yoloByDefault 等字段读取时忽略
 * （模型解析已退化为「主 agent model 优先」）。
 */
export function loadGlobalConfig(agentDir: string): SubagentsGlobalConfig {
  const configPath = getGlobalConfigPath(agentDir);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    // P4 引擎路由（D9）：全局默认引擎 + strict 模式。非法值静默回缺省（'pi' /
    // false）——config.json 是用户手编文件，坏值不炸启动（与 maxConcurrent 同判）
    const defaultEngine = sanitizeDefaultEngine(parsed.defaultEngine);
    const engineRouting = sanitizeEngineRouting(parsed.engineRouting);
    return {
      version: parsed.version ?? DEFAULT_CONFIG.version,
      maxConcurrent: sanitizeMaxConcurrent(parsed.maxConcurrent),
      ...(defaultEngine !== undefined ? { defaultEngine } : {}),
      ...(engineRouting !== undefined ? { engineRouting } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** maxConcurrent 校验：正整数，否则默认。 */
function sanitizeMaxConcurrent(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_CONCURRENT;
}

/**
 * defaultEngine 校验：非空字符串透传，其余 undefined（缺省引擎由路由层落 'pi'）。
 * 为什么不在加载期对注册表校验 hasEngine：加载早于组合根注册（agentDir 解析在
 * session_start），注册表此刻可能为空——校验归路由层（getEngine 抛 EngineNotFoundError）。
 */
function sanitizeDefaultEngine(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** engineRouting 校验：仅认 strict 布尔，其余键忽略（向前兼容追加）。 */
function sanitizeEngineRouting(value: unknown): { strict: boolean } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const strict = (value as Record<string, unknown>).strict;
  return typeof strict === "boolean" ? { strict } : undefined;
}
