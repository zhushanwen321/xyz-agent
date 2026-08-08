/**
 * Meta Parser — 资源元数据统一解析器（v5 §4.2 / IF1 + IF2）
 *
 * 两个变体，职责分离（R8-F1：discovery 的 fail-safe null 与 generate 的 linePos 需求互斥，
 * 单一函数无法兼顾）：
 * - parseResourceMeta（IF1，discovery 用）：fail-safe，任何失败返 null，不抛。
 *   供 config-loader / registry / 两 injector / agent-registry 调用（4 parser 收敛为 1）。
 * - parseResourceMetaDetailed（IF2，generate 闭环用）：失败返 {ok:false, error, linePos}，
 *   linePos 取自 eemeli/yaml YAMLParseError.linePos[0]（[P-yaml] 探针实测：
 *   e.linePos 是 [start,end] 数组，取 [0] 作起止点），供 actionGenerate 报行列给 LLM 自纠正。
 *
 * 格式（v5 §7 / DM4）：
 * - workflow (.js)：块注释 `/* @pi-meta <YAML> * /`（单星，非 JSDoc），WORKFLOW_META_RE 提取。
 * - agent (.md)：frontmatter `--- <YAML> ---`，FRONTMATTER_RE 提取。
 * - 无 legacy fallback（D1）：const meta 旧格式 → extractBlock 取不到块 → null。
 *
 * [P-yaml] 探针已验证：eemeli/yaml 2.9.0 的 YAMLParseError.linePos = [{line,col},{line,col}]。
 *
 * 层归属：shared（L2 统一解析器）。
 */

import { parse as parseYaml } from "yaml";

import type {
  AgentMeta,
  ResourceKind,
  ResourceMeta,
  RoutingExample,
  WorkflowMeta,
} from "./resource-meta.ts";

// ── 格式提取正则 ──────────────────────────────────────────────

/** workflow @pi-meta 块注释：单星块注释（非 JSDoc `/**`），内容为 YAML。 */
const WORKFLOW_META_RE = /\/\*\s*@pi-meta\s*\n([\s\S]*?)\*\//;

/** agent frontmatter：标准 YAML frontmatter。 */
const FRONTMATTER_RE = /---\n([\s\S]*?)\n---/;

/** 按资源种类取 meta 块文本（YAML 体）。取不到返 undefined。 */
function extractBlock(content: string, kind: ResourceKind): string | undefined {
  const re = kind === "workflow" ? WORKFLOW_META_RE : FRONTMATTER_RE;
  return re.exec(content)?.[1];
}

// ── 类型校验（手写，非 ajv；meta 结构简单）──────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** 把 parseYaml 结果（unknown）校验为类型化 ResourceMeta，失败返 null（语义非法，非语法错）。 */
function typecheckMeta(raw: unknown, kind: ResourceKind): ResourceMeta | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  // 公共必填：name 非空字符串
  if (!isNonEmptyString(o.name)) return null;
  // description 字符串（缺省允许空串，路由降级）
  const description = isString(o.description) ? o.description : "";
  // 可选公共字段
  const when = isString(o.when) ? o.when : undefined;
  const notFor = isString(o.notFor) ? o.notFor : undefined;

  if (kind === "workflow") {
    // phases 必填数组，元素为 string | {title:string}
    if (!Array.isArray(o.phases)) return null;
    const phases: WorkflowMeta["phases"] = [];
    for (const p of o.phases) {
      if (isString(p)) {
        phases.push(p);
      } else if (
        typeof p === "object" && p !== null && isNonEmptyString((p as Record<string, unknown>).title)
      ) {
        const detail = (p as Record<string, unknown>).detail;
        phases.push({
          title: (p as Record<string, unknown>).title as string,
          ...(isString(detail) ? { detail } : {}),
        });
      } else {
        return null;
      }
    }
    // parameters 可选对象（JSON Schema）；usage 可选字符串
    const parameters =
      typeof o.parameters === "object" && o.parameters !== null && !Array.isArray(o.parameters)
        ? (o.parameters as Record<string, unknown>)
        : undefined;
    const usage = isString(o.usage) ? o.usage : undefined;

    const meta: WorkflowMeta = {
      kind: "workflow",
      name: o.name,
      description,
      phases,
      ...(parameters !== undefined ? { parameters } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(when !== undefined ? { when } : {}),
      ...(notFor !== undefined ? { notFor } : {}),
    };
    return meta;
  }

  // kind === "agent"
  let examples: RoutingExample[] | undefined;
  if (o.examples !== undefined) {
    if (!Array.isArray(o.examples)) return null;
    const exs: RoutingExample[] = [];
    for (const e of o.examples) {
      if (
        typeof e === "object" && e !== null &&
        isString((e as Record<string, unknown>).match) &&
        isString((e as Record<string, unknown>).action) &&
        typeof (e as Record<string, unknown>).positive === "boolean"
      ) {
        exs.push({
          match: (e as Record<string, unknown>).match as string,
          action: (e as Record<string, unknown>).action as string,
          positive: (e as Record<string, unknown>).positive as boolean,
        });
      } else {
        return null;
      }
    }
    examples = exs;
  }
  // tools 可选字符串数组；model 可选字符串
  let tools: string[] | undefined;
  if (o.tools !== undefined) {
    if (!Array.isArray(o.tools) || !o.tools.every(isString)) return null;
    tools = o.tools as string[];
  }
  const model = isString(o.model) ? o.model : undefined;

  const meta: AgentMeta = {
    kind: "agent",
    name: o.name,
    description,
    ...(examples !== undefined ? { examples } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(when !== undefined ? { when } : {}),
    ...(notFor !== undefined ? { notFor } : {}),
  };
  return meta;
}

// ── IF1: parseResourceMeta（discovery，fail-safe null）─────────────────

/**
 * 统一 meta 解析入口（discovery 用）。仅认新格式，无 legacy fallback。
 * 任何失败（缺块 / YAML 语法错 / 类型校验失败）→ return null（不抛）。
 * discovery fail-safe：单文件解析失败仅让该资源 available=false，不阻塞其他资源。
 */
export function parseResourceMeta(
  content: string,
  kind: ResourceKind,
): ResourceMeta | null {
  const block = extractBlock(content, kind);
  if (!block) return null;
  try {
    const raw = parseYaml(block);
    return typecheckMeta(raw, kind);
  } catch {
    return null;
  }
}

// ── IF2: parseResourceMetaDetailed（generate 闭环，返 linePos）─────────

export type DetailedResult =
  | { ok: true; meta: ResourceMeta }
  | { ok: false; error: string; linePos?: { line: number; col: number } };

/**
 * generate 闭环专用。失败时返回 error + linePos（取自 eemeli/yaml YAMLParseError.linePos[0]），
 * 供 actionGenerate 报「生成 YAML 错在 line X col Y」给 LLM 自纠正（ERR4）。
 * discovery 不用此（保持 fail-safe null）。
 *
 * [P-yaml] 探针实测：e.linePos 是 [{line,col},{line,col}]（start+end），取 [0] 作起点。
 */
export function parseResourceMetaDetailed(
  content: string,
  kind: ResourceKind,
): DetailedResult {
  const block = extractBlock(content, kind);
  if (!block) return { ok: false, error: "未找到 meta 块（缺少 /* @pi-meta */ 或 frontmatter）" };
  let raw: unknown;
  try {
    raw = parseYaml(block);
  } catch (e) {
    // eemeli/yaml YAMLParseError：e.linePos = [{line,col},{line,col}]（[P-yaml] 实测）
    const err = e as { linePos?: Array<{ line: number; col: number }> };
    const linePos = Array.isArray(err.linePos) && err.linePos.length > 0
      ? { line: err.linePos[0]!.line, col: err.linePos[0]!.col }
      : undefined;
    return {
      ok: false,
      error: e instanceof Error ? e.message.split("\n")[0] : String(e),
      ...(linePos !== undefined ? { linePos } : {}),
    };
  }
  const meta = typecheckMeta(raw, kind);
  if (!meta) return { ok: false, error: "meta 类型校验失败（缺 name、phases 非法或 kind 字段不匹配）" };
  return { ok: true, meta };
}
