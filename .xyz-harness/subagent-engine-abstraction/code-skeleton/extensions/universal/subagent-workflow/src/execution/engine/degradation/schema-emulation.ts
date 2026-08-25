// execution/engine/degradation/schema-emulation.ts
//
// 公共降级层 ①：schema 仿真（prompt 注入 + 三级容错 JSON 提取 + 宿主侧 ajv 校验）。
// D4 硬分流：本模块仅服务 capabilities.schemaEnforcement === "emulated" 的引擎
// （zcode/opencode/kimi-code 类）；native 路径（pi env 注入链路）零介入——宿主侧
// ajv 只在 emulated 路径出现，对 native 引擎结果无二次校验（AC-3 / 护 structured-output 方案 A）。
//
// 仿真路径自身失败（三级容错 + 重试一次仍不过）才升级为 schema_emulation_failed
// （错误含原始输出尾部——与现有 structured-output 重试语义对齐）。

import Ajv, { type ValidateFunction } from "ajv";

import type { AgentTaskSpec, EngineErrorShape } from "../types.ts";

/** 仿真段拼装的 prompt 约定（并入 persona 注入段；prompt 拼接是 emulated 引擎唯一的 schema 通道）。 */
export function buildSchemaEmulationPrompt(schema: Record<string, unknown>): string {
  // 数据流：schema JSON pretty 化 → 约定段（要求最终回复输出单个 JSON 代码块）
  // 实现期对齐 shared/schema-jsonify.ts 的 stringifySchemaCached 缓存通道。
  const compiled = compileSchema(schema);
  throw new Error(`skeleton: schema emulation prompt segment (compiled=${String(compiled !== undefined)})`);
}

/** 三级容错 JSON 提取：①整体 JSON.parse ②```json 代码块提取 ③首个平衡花括号子串。 */
export function extractJsonLenient(text: string): { ok: true; json: unknown } | { ok: false; reason: string } {
  // 失败路径：三级全失败 → { ok:false, reason }（调用方据此决定重试或升级 schema_emulation_failed）。
  const first = tryParse(text);
  if (first !== undefined) return { ok: true, json: first };
  return tryBalancedBrace(text);
}

/**
 * 仿真主入口：三级容错 + （失败时）强化 prompt 重试一次 + 宿主侧 ajv 校验。
 * 产出与 native 同形（parsedOutput）；失败返回 schema_emulation_failed（含原始输出尾部）。
 */
export async function emulateStructuredOutput(
  rawOutput: string,
  schema: Record<string, unknown>,
): Promise<{ ok: true; parsedOutput: unknown } | { ok: false; error: EngineErrorShape }> {
  const validate = compileSchema(schema);
  const extracted = extractJsonLenient(rawOutput);
  if (extracted.ok) {
    // native/emulated 硬分流的 emulated 侧：ajv 校验发生在宿主（此处），非引擎。
    if (validate(extracted.json)) {
      return { ok: true, parsedOutput: extracted.json };
    }
  }
  // 重试一次（强化 prompt）由编排层驱动；此处对原始输出尾部截断后组装错误。
  return { ok: false, error: tailToEmulationFailure(rawOutput, validate.errors) };
}

/** 仿真段由公共层拼装后放入 persona.appendSystemPrompt（调用点：run 前 person 拼装）。 */
export function augmentPersonaWithSchemaEmulation(task: AgentTaskSpec): AgentTaskSpec {
  // 数据流：task.schema 存在且引擎为 emulated 时 → 仿真段追加进 persona.appendSystemPrompt。
  // 接线边界：字段透传 + 拼装委托 buildSchemaEmulationPrompt；分支判据由编排层注入。
  if (!task.schema) return task;
  const segment = buildSchemaEmulationPrompt(task.schema);
  return {
    ...task,
    persona: {
      ...task.persona,
      appendSystemPrompt: [...(task.persona?.appendSystemPrompt ?? []), segment],
    },
  };
}

// ── 内部（叶子级纯函数，骨架即签名）─────────────────────────

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  // 真引 ajv（adapter 真引 SDK 规则）：依赖声明验签——ajv 缺失/签名变化在 tsc 期暴露。
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema);
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tryBalancedBrace(text: string): { ok: true; json: unknown } | { ok: false; reason: string } {
  // 三级容错的第③级（首尾平衡花括号子串）细节属实现域；骨架声明出口形状。
  void text;
  return { ok: false, reason: "skeleton: no balanced JSON substring" };
}

function tailToEmulationFailure(raw: string, errors: unknown): EngineErrorShape {
  void errors;
  return {
    code: "schema_emulation_failed",
    message: `schema emulation failed (tail): ${raw.slice(-500)}`,
    recovery: "重试一次已耗尽：建议缩短 schema 或改用 engine: pi（native schema 通道）",
    stdoutTail: raw.slice(-2000),
  };
}
