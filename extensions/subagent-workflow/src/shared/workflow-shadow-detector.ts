// src/shared/workflow-shadow-detector.ts
//
// Workflow shadow 检测——发现同名 workflow 跨源冲突（一个源覆盖另一个）。
//
// 背景：discoverResources 按优先级去重时，被覆盖的同名 workflow 被静默丢弃。
// 典型场景：project .pi/workflows/review-fix-loop.js（旧副本）覆盖 npm 包内的
// 最新内置版，导致用户永远跑不到新功能；~/.pi/agent/workflows/review-fix-loop.js
// （user 级旧副本）同理。本模块在发现全量资源后检测这种冲突，让 injector 注入
// 警告段、AI 可转告用户清理。
//
// 判定规则（detectWorkflowShadows）：
// - 忽略 project-pi-tmp（临时脚本，workflow-script generate 的产物，正常覆盖）
// - 忽略「同名仅出现在 npm + npm-dev」（dev link 覆盖 npm 是预期开发工作流）
// - 其余跨源同名（含任意「用户可编辑源」user-*/project-*）→ shadow，告警

import type { DiscoveredResource, ResourceSource } from "./resource-discovery.ts";
import { stem } from "./resource-discovery.ts";

/**
 * 源优先级（数值大 = 优先级高，覆盖数值小的同名资源）。
 * 与 resource-discovery buildScanTargets 的数组顺序一致（数组在前 = 优先级低）。
 *
 * 供 effective/shadowed 判定与外部诊断引用。
 */
export const SOURCE_PRIORITY: Record<ResourceSource, number> = {
  "user-pi": 1,
  "user-agents": 2,
  "npm": 3,
  "npm-dev": 4,
  "project-pi": 5,
  "project-pi-tmp": 6,
  "project-agents": 7,
};

/** 用户可编辑的源（非 npm 内置、非临时）。这些源 shadow npm 内置 = 典型问题场景。 */
const EDITABLE_SOURCES = new Set<ResourceSource>([
  "user-pi",
  "user-agents",
  "project-pi",
  "project-agents",
]);

/** 触发 shadow 判定的最少源数量（同名至少跨 2 源才可能冲突） */
const MIN_SHADOW_SOURCES = 2;

/** 单个 shadow 冲突：同名 workflow 跨多个源。 */
export interface WorkflowShadow {
  /** workflow 名（stem，去目录去扩展名） */
  name: string;
  /** 所有同名资源（含生效与被屏蔽），按优先级排序（高→低） */
  resources: DiscoveredResource[];
  /** 实际生效的（优先级最高的资源；进入检测的资源均已 available=true） */
  effective: DiscoveredResource;
  /** 被屏蔽的（非生效的其余资源） */
  shadowed: DiscoveredResource[];
}

/**
 * 从未去重的全量资源（discoverAllResources 返回值）检测跨源同名 shadow。
 *
 * 纯函数——不扫文件系统，只对内存数据分组判定。永不抛错。
 *
 * @returns shadow 列表（无冲突返回空数组），按 name 字典序稳定排序
 */
export function detectWorkflowShadows(
  resources: DiscoveredResource[],
): WorkflowShadow[] {
  // 过滤临时源 + unavailable 占位（不参与 shadow 告警）+ 按 stem 分组。
  // available=false 的 manifest 失败/文件缺失占位不是实际文件，不构成覆盖源。
  const groups = new Map<string, DiscoveredResource[]>();
  for (const r of resources) {
    if (r.source === "project-pi-tmp") continue;
    if (!r.available) continue;
    const key = stem(r.path);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const shadows: WorkflowShadow[] = [];
  for (const [name, group] of groups) {
    // 同名仅出现在单一源 → 无冲突
    const sources = new Set(group.map((r) => r.source));
    if (sources.size < MIN_SHADOW_SOURCES) continue;

    // 仅 npm + npm-dev（dev link 正常覆盖 npm）→ 不告警
    const onlyNpmLike = [...sources].every(
      (s) => s === "npm" || s === "npm-dev",
    );
    if (onlyNpmLike) continue;

    // 至少一个用户可编辑源才告警——纯 npm-dev 等非可编辑源组合（理论上 project-pi-tmp
    // 已过滤，此处判定保留作语义自文档与防御未来新增 source 类型）
    const hasEditable = [...sources].some((s) => EDITABLE_SOURCES.has(s));
    if (!hasEditable) continue;

    // 按优先级排序（高→低）。effective = 最高优先级（首个），shadowed = 其余。
    // 进入此处的资源均已 available=true（上方已过滤）。
    const sorted = [...group].sort(
      (a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source],
    );
    shadows.push({
      name,
      resources: sorted,
      effective: sorted[0],
      shadowed: sorted.slice(1),
    });
  }

  shadows.sort((a, b) => a.name.localeCompare(b.name));
  return shadows;
}

/** 转义 XML 特殊字符（与 workflow-list-injector 一致） */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 将 shadow 列表格式化为注入主 agent systemPrompt 的警告段（XML）。
 *
 * 空列表返回空串（不注入）。非空时输出 <workflow_shadow_warning> 段，
 * 列出每个冲突的生效源与被屏蔽源绝对路径，引导用户删除被屏蔽的旧副本。
 *
 * 该段进入 LLM systemPrompt（每 turn 注入，仅在有 shadow 时）——AI 可感知
 * 并主动转告用户，弥补 logger.warn 仅进 appendEntry（TUI 不可见）的缺口。
 */
export function formatShadowWarning(shadows: WorkflowShadow[]): string {
  if (shadows.length === 0) return "";

  const lines = [
    "\n\n<workflow_shadow_warning>",
    "WARNING: These workflows have name collisions across sources. A higher-priority source is shadowing (overriding) others — the shadowed copies will NOT take effect. This is typically caused by stale copies left by old tooling. Tell the user and recommend deleting the shadowed files.",
    "",
  ];
  for (const s of shadows) {
    lines.push(`  <shadow name="${escapeXml(s.name)}">`);
    lines.push(
      `    <effective source="${s.effective.source}">${escapeXml(s.effective.path)}</effective>`,
    );
    for (const sh of s.shadowed) {
      lines.push(
        `    <shadowed source="${sh.source}">${escapeXml(sh.path)}</shadowed>`,
      );
    }
    lines.push("  </shadow>");
  }
  lines.push("</workflow_shadow_warning>");
  return lines.join("\n");
}
