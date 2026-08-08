/**
 * Workflow Config Loader — 统一资源发现版（ADR-031）
 *
 * 扫描逻辑委托给 shared/resource-discovery（与 agent 发现共享同一套扫描源）。
 * 本文件只保留 workflow 专属的 meta 提取（经 shared/meta-parser.ts IF1 统一 parser）+ 60s TTL 缓存。
 *
 * m2 收敛：删 extractMetaViaRegex + safeEvalObject(new Function)，改调 parseResourceMeta
 * （真实 YAML 解析 @pi-meta 块注释，发现期不执行作者代码，v5 原则 6 no-eval）。
 * toCachedMeta 整对象透传（...meta），不再 {name,description,phases} 解构——消灭第 1 处重映射。
 *
 * Failed imports are marked available=false — the loader never throws.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// WorkflowMeta 规范来源是 shared/resource-meta.ts（m1 DM1）；WorkflowSource 来自 workflow-script
import type { WorkflowSource } from "./models/workflow-script.ts";
import type { WorkflowMeta } from "../shared/resource-meta.ts";
import { parseResourceMeta } from "../shared/meta-parser.ts";
export type { WorkflowMeta, WorkflowSource };

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("config-loader");

import {
  discoverResources,
  findWorkspaceRoot,
  type ResourceSource,
  type ScanConfig,
} from "../shared/resource-discovery.ts";

// ── Public types ──────────────────────────────────────────────

export interface CachedWorkflowMeta extends WorkflowMeta {
  /** Absolute path to the script file */
  path: string;
  /** false when the script failed to load or has no valid meta export */
  available: boolean;
  /** Whether this is a saved (fixed) or temporary (ad-hoc) workflow */
  source: WorkflowSource;
}

// ── Internal types ────────────────────────────────────────────

interface CacheEntry {
  meta: CachedWorkflowMeta;
  cachedAt: number;
}

// ── Constants ─────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

// ── Cache ─────────────────────────────────────────────────────

// Keyed by workspace root so that switching projects does not serve stale entries.
const cache = new Map<string, Map<string, CacheEntry>>();

function getCacheBucket(workspaceRoot: string): Map<string, CacheEntry> {
  let bucket = cache.get(workspaceRoot);
  if (!bucket) {
    bucket = new Map<string, CacheEntry>();
    cache.set(workspaceRoot, bucket);
  }
  return bucket;
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

// ── Helpers ───────────────────────────────────────────────────

/** Extract filename stem (no directory, no extension). */
function stem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── ResourceSource → WorkflowSource 映射 ─────────────────────

/** 统一模块的 ResourceSource 映射为 workflow 的 saved/tmp 语义 */
function toWorkflowSource(source: ResourceSource): WorkflowSource {
  return source === "project-pi-tmp" ? "tmp" : "saved";
}

// ── 单文件 → CachedWorkflowMeta（IF1 parseResourceMeta + 整对象透传）──

/**
 * 提取单个文件的 meta（经 IF1 parseResourceMeta），失败时标 available=false（fail-safe 不抛）。
 *
 * m2：整对象透传（...meta），不再 {name,description,phases} 解构——消灭第 1 处重映射，
 * parameters/usage/when/notFor 一路流到 script.meta。仅认 @pi-meta 新格式（D1 无 adapter）。
 */
async function toCachedMeta(
  filePath: string,
  source: ResourceSource,
): Promise<CachedWorkflowMeta> {
  const fallbackName = stem(filePath);
  const wfSource = toWorkflowSource(source);
  try {
    const content = await readFile(filePath, "utf-8");
    const meta = parseResourceMeta(content, "workflow");
    if (meta && meta.kind === "workflow") {
      return { ...meta, path: filePath, available: true, source: wfSource };
    }
  } catch (err) {
    // 读失败 → available=false（fail-safe 不抛，与原行为一致）
    logger.debug(`[config-loader] skip unreadable workflow file ${filePath}`, {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    kind: "workflow",
    name: fallbackName,
    description: "",
    phases: [],
    path: filePath,
    available: false,
    source: wfSource,
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * workflow 发现的扫描配置。每个字段显式声明一个扫描源目录。
 *
 * 生产环境用 defaultScanConfig() 构造默认值（全局 ~/.pi/agent/* 目录）。
 * 测试/隔离环境构造完整 config 指向 tmp 目录，完全不碰全局文件系统。
 */
export interface WorkflowScanConfig {
  /** 项目级脚本目录（workspaceRoot/.pi/workflows） */
  projectDir: string;
  /** user 级脚本目录（~/.pi/agent/workflows） */
  userDir: string;
  /** 临时脚本目录（workspaceRoot/.pi/workflows/.tmp） */
  tmpDir: string;
  /** npm 包扫描目录（~/.pi/agent/npm/node_modules 等） */
  npmDirs: string[];
}

/**
 * 把 WorkflowScanConfig 转为统一模块的 ScanConfig。
 *
 * 测试隔离场景下传入完整 config——此时按声明的 projectDir/tmpDir 反推
 * workspaceRoot（与原行为一致：resolve(config.projectDir, "../..")）。
 * 生产场景（省略或部分 config）走 findWorkspaceRoot(cwd)。
 */
function toScanConfig(
  configOrCwd: Partial<WorkflowScanConfig> & { cwd?: string } | undefined,
): ScanConfig {
  // 测试隔离：传入了 projectDir，直接反推 workspaceRoot
  if (configOrCwd?.projectDir) {
    const workspaceRoot = resolve(configOrCwd.projectDir, "../..");
    return {
      kind: "workflows",
      workspaceRoot,
      agentDir: "test-no-agent-dir",
      includeTmp: true,
    };
  }

  // 生产默认
  const cwd = configOrCwd?.cwd;
  const workspaceRoot = findWorkspaceRoot(cwd);
  return {
    kind: "workflows",
    workspaceRoot,
    agentDir: getAgentDir(),
    includeTmp: true,
  };
}

/**
 * 从指定 config 扫描所有 workflow 脚本，按 tmp>project>npm>user 优先级
 * 去重，60s TTL 缓存（按 workspaceRoot 分桶）。
 *
 * 扫描逻辑委托给 shared/resource-discovery（与 agent 发现共享同一套扫描源）。
 *
 * Never throws. 解析失败的脚本以 available=false 返回。
 *
 * @param configOrCwd 完整 WorkflowScanConfig（隔离用）、部分字段（覆盖默认）、
 *                   或省略（纯生产默认）。可选 cwd 用于推导 workspaceRoot。
 */
export async function discoverWorkflows(
  configOrCwd?: Partial<WorkflowScanConfig> & { cwd?: string },
): Promise<CachedWorkflowMeta[]> {
  const scanConfig = toScanConfig(configOrCwd);
  const workspaceRoot = scanConfig.workspaceRoot;

  // 统一发现：返回已去重的资源列表（按优先级合并）
  const resources = await discoverResources(scanConfig);

  // 提取 meta（逐文件）
  const mergedMap = new Map<string, CachedWorkflowMeta>();
  for (const resource of resources) {
    const cachedMeta = await toCachedMeta(resource.path, resource.source);
    // available=false 的不覆盖已有的 available=true（与统一模块逻辑一致）
    if (!cachedMeta.available && mergedMap.has(cachedMeta.name)) {
      continue;
    }
    mergedMap.set(cachedMeta.name, cachedMeta);
  }

  const merged = Array.from(mergedMap.values());

  // Update cache (scoped to current workspace root)
  const bucket = getCacheBucket(workspaceRoot);
  const now = Date.now();
  for (const wf of merged) {
    bucket.set(wf.name, { meta: wf, cachedAt: now });
  }

  return merged;
}

/**
 * Load and cache all available workflow scripts from project-level
 * (.pi/workflows/) and user-level (~/.pi/agent/workflows/) directories.
 *
 * discoverWorkflows() 的生产 preset——用全局默认目录。
 *
 * Never throws. Failed imports are returned with available=false.
 */
export async function loadWorkflows(): Promise<CachedWorkflowMeta[]> {
  return discoverWorkflows();
}

/**
 * Get a specific workflow by name.
 * Returns cached result if still valid, otherwise triggers a fresh load.
 */
export async function getWorkflow(name: string): Promise<CachedWorkflowMeta | undefined> {
  const workspaceRoot = findWorkspaceRoot();
  const bucket = getCacheBucket(workspaceRoot);
  const cached = bucket.get(name);
  if (cached && isCacheValid(cached)) {
    return cached.meta;
  }

  const workflows = await loadWorkflows();
  return workflows.find((wf) => wf.name === name);
}

/**
 * Invalidate the internal meta cache.
 * The next call to loadWorkflows or getWorkflow will re-scan directories.
 */
export function invalidateCache(): void {
  cache.clear();
}
