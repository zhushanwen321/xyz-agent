/**
 * structured-output tool 定义（两种模式共享）。
 *
 * env 桥接：execute 内读 process.env[PI_WORKFLOW_SCHEMA]，存在时注入
 * authoritativeSchema（workflow 模式权威校验），否则走日常防御链。
 * description/promptSnippet/promptGuidelines 文本被 prompt-quality.test.ts
 * 文本断言锁定，逐字保留。
 */

import { Type } from "typebox";

import { executeStructuredOutput } from "./execute.js";

export const TOOL_NAME = "structured-output";
export const ENV_SCHEMA = "PI_WORKFLOW_SCHEMA";

// ── Tool definition (shared between modes) ─────────────────────

export function createToolDefinition() {
	return {
		name: TOOL_NAME,
		label: "Structured Output",
		description:
			"Return structured output validated against a JSON Schema. "
			+ "Call this tool to produce validated JSON data. "
			+ "Pass `schema` (a JSON Schema draft-07 object) and `data` (the value to validate). "
			+ "When the schema is system-enforced (workflow mode), pass ONLY `data` — "
			+ "the `schema` parameter is ignored (the system validates `data` against the authoritative schema).\n\n"
			+ "schema describes the shape; data fills the values; they must match.\n\n"
			+ "✅ Correct (full call): structured_output({schema:{type:'object',properties:{name:{type:'string'},age:{type:'number'}},required:['name']}, data:{name:'Alice',age:30}})\n"
			+ "✅ Correct: schema={type:'array',items:{type:'string'}}, data=['a','b','c']\n"
			+ "✅ Correct: schema={type:'string',enum:['low','medium','high']}, data='medium'\n"
			+ "✅ Correct: schema={type:'number',minimum:0,maximum:100}, data=42\n"
			+ "✅ Correct: schema={type:'boolean'}, data=true\n\n"
			+ "❌ Wrong: putting the answer in text instead of calling this tool\n"
			+ "❌ Wrong: data not matching schema (e.g. schema requires number but data is string)\n"
			+ "❌ Wrong: schema={type:'object'} with data='hello' (string ≠ object)\n"
			+ "❌ Wrong: structured_output({name:'Alice'}) — missing the schema/data envelope. Wrap as {schema:{...}, data:{name:'Alice'}}.\n"
			+ "❌ Wrong: swapping schema and data (passing the answer as schema). The tool detects this as 'likely swapped' and rejects it.\n"
			+ "❌ Wrong: merging schema and data into one object.\n"
			+ "❌ Wrong: schema with no recognized JSON Schema keyword (e.g. {} or {answer:42}). The schema must describe shape via draft-07 keywords (type/properties/items/if-then-else/enum/...); a keyword-less object is rejected to prevent silent accept-all compilation.",
		promptSnippet:
			"Use structured-output to return validated JSON data. "
			+ "Pass schema (JSON Schema draft-07) and data (your output). "
			+ "Example: {schema:{type:'object',properties:{score:{type:'number'}},required:['score']}, data:{score:8}}",
		promptGuidelines: [
			"schema must be a valid JSON Schema (draft-07). data must conform to it.",
			"Both primitive types (string, number, boolean) and complex types (object, array) are valid schema roots.",
			"Do not output JSON in text — call this tool instead.",
		],
		parameters: Type.Object({
			schema: Type.Unknown({
				description: "JSON Schema draft-07 object. Example: {type:'object',properties:{name:{type:'string'}},required:['name']}",
			}),
			data: Type.Unknown({
				description: "The value to validate against schema. Example: {name:'Alice'}",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { schema: unknown; data: unknown },
		) {
			// workflow 模式（PI_WORKFLOW_SCHEMA 存在）：权威 schema 成为唯一校验权威，
			// LLM 传入的 params.schema 被降级为错误回显，无法影响校验结果。
			//
			// 运行假设：workflow 子进程是单 session 进程（由 applySchemaEnvToChildEnv 在
			// session-runner 注入 PI_WORKFLOW_SCHEMA）。Pi extension 状态在 session_start 重建，
			// 但 process.env 在进程级共享——这里依赖「workflow 子进程不会复用未注入 env 的 session」
			// 的单 session 约定，故直接读 process.env 而非维护 per-session 缓存。
			//
			// 判空用 `|| undefined` 归一空串为 undefined（truthy 语义），与 entry 的 `if (schemaEnv)`
			// 和 applySchemaEnvToChildEnv 的 `if (schemaEnv)` 统一：空串 env 视为未设置。
			const authoritativeSchema = process.env[ENV_SCHEMA] || undefined;
			return executeStructuredOutput(
				authoritativeSchema !== undefined
					? { ...params, authoritativeSchema }
					: params,
			);
		},
	};
}
