// src/execution/agent-registry.ts
//
// agent .md 文件发现与解析。
//
// 发现逻辑统一走 shared/resource-discovery（ADR-031），与 workflow 共享同一套
// 扫描源前缀 + manifest 校验。hot-reload：每次调用重扫（mtime 缓存跳过未变文件）。
//
// builtin agent（包内 agents/*.md）走 pi.agents manifest（与 npm 包内发现规则一致）。


import * as path from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

import {
  getCachedFile,
} from "../shared/resource-discovery.ts";
import { normalizeRef, AGENT_REF_EXT } from "../shared/agent-ref.ts";
import { parseResourceMeta } from "../shared/meta-parser.ts";
import { lintAgentMeta } from "../orchestration/script-lint.ts";
import type { AgentMeta } from "../shared/resource-meta.ts";
import type { AgentConfig } from "./model-resolver.ts";

const logger = getLogger("subagents");

/** mtime 缓存条目（跨 loadByPath 保留，靠 mtime 判失效）。 */
interface FileCacheEntry {
  mtimeMs: number;
  config: AgentConfig;
  /** AgentMeta（W4 lint 用——cache-miss 时 lint 一次，warn 随 mtime 变化刷）。 */
  meta: AgentMeta | null;
}

// ============================================================
// frontmatter 解析
// ============================================================

/** frontmatter 分隔符。 */
const FM_DELIM = "---";

/**
 * 解析 .md frontmatter（name/tools/model/thinkingLevel/defaultBackground）+ body（systemPrompt）。
 * 兼容简单 YAML（key: value 单行格式）。body 作为 systemPrompt。
 */
export function parseAgentFrontmatter(filePath: string, content: string): AgentConfig {
  return parseAgentWithMeta(filePath, content).config;
}

/**
 * 解析 agent .md → { config, meta } 二元组（m5 T2：W4 lint 需要 AgentMeta——
 * AgentConfig 投影时 examples 被丢弃，meta 供 lintAgentMeta 使用）。
 */
export function parseAgentWithMeta(
  filePath: string,
  content: string,
): { config: AgentConfig; meta: AgentMeta | null } {
  const name = path.basename(filePath, ".md");

  // 无 frontmatter → 整个内容作为 systemPrompt
  if (!content.startsWith(FM_DELIM)) {
    return { config: { name, systemPrompt: content.trim() }, meta: null };
  }

  const closeIdx = content.indexOf(FM_DELIM, FM_DELIM.length);
  if (closeIdx === -1) {
    // 未闭合 frontmatter：提取 name，其余作为 systemPrompt
    const yamlBlock = content.slice(FM_DELIM.length);
    return {
      config: {
        name: extractYamlField(yamlBlock, "name") ?? name,
        systemPrompt: content.trim(),
      },
      meta: null,
    };
  }

  const yamlBlock = content.slice(FM_DELIM.length, closeIdx);
  const body = content.slice(closeIdx + FM_DELIM.length).trim();

  // m2：结构化路由字段（name/model/tools）经 IF1 parseResourceMeta（统一 parser），
  // 消灭本地 frontmatter parser 与 subagent-list-injector 的重复。thinkingLevel/defaultBackground
  // 是执行配置（非 AgentMeta 路由字段），仍用 extractYamlField 取。
  const meta = parseResourceMeta(content, "agent");
  const agentMeta = meta?.kind === "agent" ? meta : null;
  if (!agentMeta && /^model:|^tools:/m.test(yamlBlock)) {
    // m2 exec-review MINOR-2：IF1 要求 name/description 必填；缺 description 时 agent
    // 被整体拒绝 → model/tools 路由字段静默失效。显式 warn 替代静默丢配置。
    logger.warn(
      `[agent-registry] ${filePath}: agent frontmatter 缺 name/description（IF1 必填），` +
        "model/tools 路由字段不生效——请补充 description",
    );
  }
  const defaultBackgroundRaw = extractYamlField(yamlBlock, "defaultBackground");

  return {
    config: {
      name: agentMeta?.name ?? name,
      systemPrompt: body,
      model: agentMeta?.model ?? undefined,
      thinkingLevel: extractYamlField(yamlBlock, "thinkingLevel") ?? undefined,
      tools: agentMeta?.tools && agentMeta.tools.length > 0 ? agentMeta.tools : undefined,
      defaultBackground: defaultBackgroundRaw === "true" ? true : undefined,
    },
    meta: agentMeta,
  };
}

/** 提取简单 `key: value` 字段，剥离引号。 */
function extractYamlField(yaml: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  if (!match) return undefined;
  let value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || undefined;
}

// ============================================================
// AgentRegistry
// ============================================================

export class AgentRegistry {
  /** 文件级 mtime 缓存（key=绝对路径，跨 loadByPath 保留）。 */
  private readonly fileCache = new Map<string, FileCacheEntry>();

  /**
   * 按绝对路径加载 agent（agentRef 统一解析入口——S2 路径统一）。
   *
   * - ~/ 前缀展开；相对路径/非 .md 引用返回 undefined（引用唯一形态 = 绝对路径）
   * - 文件不可读/不存在 → 驱逐缓存 + 返回 undefined（调用方给错误指引）
   * - mtime 未变复用 config 缓存；cache-miss 时 W4 lint 一次
   */
  loadByPath(ref: string, require?: boolean): AgentConfig | undefined {
    const filePath = normalizeRef(ref, AGENT_REF_EXT);
    if (filePath === null) {
      if (require) {
        throw new Error(
          `Invalid agent ref: ${ref}. Agent refs must be absolute paths to .md files (use <location> from <available_subagents>).`,
        );
      }
      return undefined;
    }

    const file = getCachedFile(filePath);
    if (file === null) {
      // ENOENT/不可读 → 驱逐（mtime 缓存下文件删除不自愈的修复）
      this.fileCache.delete(filePath);
      if (require) {
        throw new Error(
          `Agent file not found or unreadable: ${filePath}. Use an absolute path from <available_subagents> <location>.`,
        );
      }
      return undefined;
    }

    const cached = this.fileCache.get(filePath);
    if (cached && cached.mtimeMs === file.mtimeMs) {
      return cached.config;
    }

    const { config, meta } = parseAgentWithMeta(filePath, file.content);
    // W4 lint：cache-miss（parse 时一次）——warn 只随 mtime 变化刷
    const lintFindings = meta ? lintAgentMeta(meta) : [];
    for (const finding of lintFindings) {
      logger.warn(`[agent-registry] ${filePath}: ${finding.message}`);
    }
    this.fileCache.set(filePath, { mtimeMs: file.mtimeMs, config, meta });
    return config;
  }
}
