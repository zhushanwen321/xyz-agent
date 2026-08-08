// src/orchestration/args-validator.ts
//
// m3：参数校验单一 chokepoint（IF3 validateRunArgs + IF4 ArgsValidationError）。
// lifecycle.runWorkflow 首行调用——§5.3 fail-fast：参数错误在 worker 启动前返回，
// 带「workflow info 重看」指引。
//
// 设计决策（m3 design-review 探针实证）：
// - ajv 选项钉死 { coerceTypes:true, strictSchema:false, allErrors:true, useDefaults:false }：
//   coerceTypes 原地规范化弱 LLM 的字符串参数（'false'→false、'10'→10，m2 MAJOR-1 闭环）；
//   strictSchema:false 容忍用户 workflow 的自定义关键字/format（默认 strict:true 会误判畸形）；
//   useDefaults:false 不注入 schema default（脚本 fallback 语义不变）。
// - 无缓存：ajv.compile 实测 0.006ms/次（[P-compile]），v5 §6.5 的 Map 缓存被探针证据推翻。
// - null-scan + required 空串复查：coerceTypes 下 {target:null} 会被 coerce 成 "" 放行
//   required（required 只查属性存在性）——null 视为缺失、必填字符串空串视为失败，
//   与 review-fix-loop 脚本的 !target 语义对齐，保住「启动前 fail-fast」承诺。

import Ajv from "ajv";

import type { RunSpec } from "./models/run-spec.ts";

/** 参数校验失败（§5.3）。三调用方各自 catch 并映射到返回类型。 */
export class ArgsValidationError extends Error {
  readonly workflowName: string;
  /** ajv 校验错误数组（畸形 schema 时为 undefined）。 */
  readonly errors?: readonly unknown[];

  constructor(workflowName: string, message: string, errors?: readonly unknown[]) {
    super(message);
    this.name = "ArgsValidationError";
    this.workflowName = workflowName;
    this.errors = errors;
  }
}

const ajv = new Ajv({
  coerceTypes: true,
  strictSchema: false,
  allErrors: true,
  useDefaults: false,
});

/** §5.3 错误文案：workflow 名 + errors 摘要 + info 指引。 */
function formatMessage(name: string, errors: readonly unknown[]): string {
  const lines = errors.map((e) => {
    let path = "/";
    let msg = "invalid";
    if (e !== null && typeof e === "object") {
      const err = e as Record<string, unknown>;
      if (typeof err.instancePath === "string" && err.instancePath) path = err.instancePath;
      if (typeof err.message === "string") msg = err.message;
    }
    return `- ${path}: ${msg}`;
  });
  return (
    `Invalid args for workflow '${name}': ${errors.length} error(s)\n` +
    `${lines.join("\n")}\n` +
    `Run \`workflow info ${name}\` to see the parameter schema and usage.`
  );
}

/**
 * 校验 spec.parameters（JSON Schema draft-07）对 spec.args 的约束。
 *
 * - spec.parameters === undefined → 跳过（安全退化：漏拷 parameters 退化是「不校验」非「校验错」）
 * - coerceTypes 原地规范化 spec.args（worker 启动 + pause/resume 重建共用同一对象，
 *   run.spec === spec，保证恢复路径参数一致）
 * - 失败 throw ArgsValidationError（非原始 ajv 错误）
 *
 * @throws ArgsValidationError 参数不合法或 schema 无效
 */
export function validateRunArgs(spec: RunSpec): void {
  const { parameters, args, scriptName } = spec;
  if (parameters === undefined) return;

  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema (expected object). ` +
        `Run \`workflow info ${scriptName}\` to inspect it.`,
    );
  }

  // null-scan：null 值视为缺失（coerceTypes 会把 null→"" 放行 required，绕过 fail-fast）
  for (const key of Object.keys(args)) {
    if (args[key] === null) delete args[key];
  }

  let validate: ReturnType<Ajv["compile"]>;
  try {
    validate = ajv.compile(parameters);
  } catch (err) {
    // 真畸形 schema（如 type:'not-a-type'）→ 结构化 ArgsValidationError，不泄漏原始 throw
    const detail = err instanceof Error ? err.message : String(err);
    throw new ArgsValidationError(
      scriptName,
      `Workflow '${scriptName}' has an invalid parameter schema: ${detail}. ` +
        `Run \`workflow info ${scriptName}\` to inspect it.`,
    );
  }

  if (!validate(args)) {
    throw new ArgsValidationError(
      scriptName,
      formatMessage(scriptName, validate.errors ?? []),
      validate.errors ?? undefined,
    );
  }

  // required 空串复查：type:string 必填属性值为 '' 时 ajv 放行（'' 是合法 string），
  // 但脚本语义（如 review-fix-loop 的 !target）视为缺失——chokepoint 层统一拦截。
  const schema = parameters as Record<string, unknown>;
  const required = schema.required;
  const properties = schema.properties;
  if (Array.isArray(required) && properties !== null && typeof properties === "object") {
    for (const key of required) {
      if (typeof key !== "string") continue;
      const prop = (properties as Record<string, unknown>)[key];
      const value = args[key];
      if (
        prop !== null &&
        typeof prop === "object" &&
        (prop as Record<string, unknown>).type === "string" &&
        typeof value === "string" &&
        value.trim() === ""
      ) {
        throw new ArgsValidationError(
          scriptName,
          formatMessage(scriptName, [
            { instancePath: `/${key}`, message: "must be a non-empty string (trimmed)" },
          ]),
        );
      }
    }
  }
}
