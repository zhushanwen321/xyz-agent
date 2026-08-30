/**
 * Workflow 脚本创作管线（generate）——pi-sw tool-workflow-script.ts actionGenerate
 * 的校验管线下沉（convergence D-6 / W4）。
 *
 * 五道闸 + round-trip + tmp 写盘，闸序与 pi 现版一致：
 * 1. ESM import 拒绝（Worker 跑 CJS）；'export const meta' 例外
 * 2. 非 meta 的 export 拒绝
 * 3. meta 声明必需（@pi-meta YAML 块注释或 legacy const meta，过渡期 m0）
 * 4. agent() 调用必需
 * 5. 语法检查（包 async IIFE，与 runtime 包裹形态一致）
 * 6. round-trip：@pi-meta 存在时 parseResourceMetaDetailed 校验 YAML（报行列）
 * 7. 通过全部校验 → tmp 目录写盘
 *
 * 与 pi 版的差异（均为宿主职责，不属纯函数边界）：
 * - 不含 signal aborted 检查（AbortSignal 是 pi tool 契约层关注，宿主改接时自留）；
 * - 返回结构化结果而非 throw——pi 只对 execute throw 置 isError:true 的契约
 *   转换由宿主（C5 改接）负责，core 保持纯函数。
 *
 * 报错文案逐字平移自 pi 现版（含 round-trip 的 line/col 信息）——pi 侧行为
 * 不变是 CA2 验收前提，任何文案改动必须同步两处。
 *
 * tmp 目录经 options.tmpDir 宿主注入（缺省 pi 布局，与 workflow-files.ts
 * 同源常量——save/delete/generate 三入口共享同一目录参数化口径）。
 *
 * 层归属：orchestration（创作闭环，与 lintScript / workflow-files 同域）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseResourceMetaDetailed } from "../shared/meta-parser.ts";
import { DEFAULT_WORKFLOW_TMP_DIR } from "./workflow-files.ts";

/** generate 目录注入参数：tmp 落盘目录宿主注入（缺省 DEFAULT_WORKFLOW_TMP_DIR）。 */
export interface GenerateWorkflowScriptOptions {
  tmpDir?: string;
}

/**
 * 管线结果：成功 = 落盘绝对路径；失败 = 报错文案（逐字对齐 pi 现版，
 * 含 round-trip 的行列信息——供宿主转 throw 后 LLM 自纠正）。
 */
export type GenerateWorkflowScriptResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * 校验并落盘一个 AI 生成的 workflow 临时脚本。
 *
 * @param name 脚本名（落盘 <tmpDir>/{name}.js）
 * @param script 完整脚本源码
 * @param options 目录注入（tmpDir 缺省 pi 布局，相对 cwd resolve）
 */
export function generateWorkflowScript(
  name: string,
  script: string,
  options?: GenerateWorkflowScriptOptions,
): GenerateWorkflowScriptResult {
  if (!name || !script) {
    return { ok: false, error: "generate requires 'name' and 'script' parameters" };
  }

 // 1. Reject ESM syntax (Worker runs CJS); 'export const meta' 例外
  const stripped = script.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\bimport\s+(?:type\s+)?[\w{*]/.test(stripped)) {
    return {
      ok: false,
      error:
        "Script uses ESM 'import' syntax. Workflow scripts run in a CJS Worker — use require() instead.",
    };
  }
  const hasExportMeta = /\bexport\s+const\s+meta\s*=/.test(stripped);
  const otherExports = stripped.match(/\bexport\s+(?:const|let|var|function|default|\{)/g);
  if (otherExports && !hasExportMeta) {
    return {
      ok: false,
      error:
        "Script uses ESM 'export' (non-meta). Use 'const meta = {...}' at top level instead.",
    };
  }

 // 2. Validate meta declaration (/* @pi-meta */ new format preferred; legacy const meta accepted during transition — m0)
  const hasPiMeta = /\/\*\s*@pi-meta\s*\n/.test(script);
  const hasLegacyMeta = script.includes("const meta") || script.includes("export const meta");
  if (!hasPiMeta && !hasLegacyMeta) {
    return {
      ok: false,
      error:
        "Script must contain a meta declaration: a /* @pi-meta */ YAML block comment (preferred) or legacy const meta = { ... }. The block has the form: a block comment starting with /* @pi-meta followed by YAML (name/description/phases/parameters?/usage?), closed by */ on its own line.",
    };
  }

 // 3. Check agent usage
  if (!/\bagent\s*\(/.test(stripped)) {
    return {
      ok: false,
      error: "Script does not contain any agent() calls. A workflow must call agent() at least once.",
    };
  }

 // 4. Syntax check (wrap in async IIFE like runtime)
  const cjsScript = script.replace(/\bexport\s+const\s+meta\b/, "const meta");
  try {
    new Function(`(async () => { ${cjsScript} })();`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Syntax error in script: ${msg}` };
  }

 // 4b. Round-trip: validate /* @pi-meta */ YAML before writing (v5 §4.7 / ERR4 — report linePos, don't write bad files)
  if (hasPiMeta) {
    const detailed = parseResourceMetaDetailed(script, "workflow");
    if (!detailed.ok) {
      const loc = "linePos" in detailed && detailed.linePos
        ? ` (line ${detailed.linePos.line}, col ${detailed.linePos.col})`
        : "";
      return {
        ok: false,
        error: `Generated /* @pi-meta */ YAML cannot be parsed${loc}: ${detailed.error}. Common causes: YAML indent errors, patternProperties regex must use double backslash (\\d not \d), or a stray star-slash inside the YAML body. Fix the meta block and retry.`,
      };
    }
  }

 // 5. Write to tmp directory
  const tmpDir = resolve(options?.tmpDir ?? DEFAULT_WORKFLOW_TMP_DIR);
  mkdirSync(tmpDir, { recursive: true });
  const filePath = resolve(tmpDir, `${name}.js`);
  writeFileSync(filePath, script, "utf-8");

  return { ok: true, path: filePath };
}
