/**
 * structured-output tool 定义（D1 双变体分岔）。
 *
 * - createWorkflowToolDefinition(envSchema)：PI_WORKFLOW_SCHEMA 存在时注册。
 *   parameters 即权威 schema 本身（object 根直接用 + 根级 additionalProperties
 *   未声明时注入 false（D4）；非 object 根包装 {value}（P6：tool call arguments
 *   必须是 object，execute 侧对称解包））。「模型不携带 schema」从文案约束升级为
 *   结构约束——pi-ai 参数层直接按权威 schema 校验，不存在可以传错的地方（G1/G3）。
 *   注册期 fail-fast 防御：keyword-less 拒绝（原 ERR-3）与 boolean true 拦截
 *   （原 ERR-7）从 execute 权威分支上移，非法 schema 在子进程加载期终止。
 * - createDailyToolDefinition()：无 env 时注册。双参数自报形态逐字节保留（G4），
 *   仅移除描述文本中的 workflow 语句（D5：workflow 语义只属于 workflow 变体）。
 *
 * 两变体的描述文本均被 prompt-quality.test.ts 文本断言锁定。
 */

import { Type } from "typebox";

import { executeStructuredOutput, isObjectRootSchema } from "./execute.js";
import {
	assertJsonSchemaRoot,
	echo,
	hasSchemaKeyword,
	isPlainObject,
	tryParseJson,
} from "./schema-guards.js";

export const TOOL_NAME = "structured-output";
export const ENV_SCHEMA = "PI_WORKFLOW_SCHEMA";

// ── Workflow variant (parameters = authoritative schema) ─────────────

/**
 * 合成 workflow 单参数工具（D1）。
 *
 * @param envSchema PI_WORKFLOW_SCHEMA env 原值（JSON 字符串；tryParseJson 兼容已解析对象）。
 * @throws 权威 schema 非法（非 object/boolean 根、boolean true、keyword-less object）
 *   时在注册期 fail-fast——错误指回 workflow 脚本的 schema 定义（§5.2 形态 d）。
 */
export function createWorkflowToolDefinition(envSchema: string) {
	// ── 注册期 fail-fast 防御（上移自 execute 权威分支）──
	const schema = tryParseJson(envSchema);
	assertJsonSchemaRoot(schema);

	if (schema === true) {
		// ERR-7 上移：boolean true（accept-all）不提供任何形状约束，workflow 用它等于没校验。
		throw new Error(
			"Authoritative schema (PI_WORKFLOW_SCHEMA) is boolean true (accept-all), "
				+ "provides no shape constraint. 👉 改为带 type/properties/items 的 object schema。",
		);
	}

	if (isPlainObject(schema) && !hasSchemaKeyword(schema)) {
		// ERR-3 上移：keyword-less 对象会被编译成 accept-all，workflow 声明的约束静默失效。
		throw new Error(
			"Authoritative schema (PI_WORKFLOW_SCHEMA) has no recognized keyword. "
				+ "A workflow schema must describe shape via type/properties/items/... "
				+ "👉 检查 workflow 脚本的 outputSchema 定义，补全 JSON Schema 关键字。 "
				+ `Received schema=${echo(schema)}`,
		);
	}

	const isObjectRoot = isObjectRootSchema(schema);

	// D4：根级 additionalProperties 未声明时注入 false；作者显式声明（true / 子 schema）
	// 尊重不动。堵输出污染：旧双参数 envelope 把模型习惯携带的 schema 隔离在专用参数里，
	// 单参数后该习惯会直接混进 arguments（事故证明 deepseek 类模型有强烈携带倾向），
	// 参数层显式拒绝并让模型自修正，优于静默剥离。嵌套层级宽严完全由作者 schema 自治。
	// P6：非 object 根（array / string / boolean / 组合根等）包一层 {value}——tool call
	// arguments 协议上必须是 object。包装/解包判定与 execute 同源（isObjectRootSchema）。
	const parameters = isObjectRoot
		? Type.Unsafe<Record<string, unknown>>({
				...schema,
				additionalProperties: schema.additionalProperties ?? false,
			})
		: Type.Unsafe<{ value: unknown }>({
				type: "object",
				properties: { value: schema },
				required: ["value"],
				additionalProperties: false,
			});

	return {
		name: TOOL_NAME,
		label: "Structured Output",
		description:
			"Return the structured result for this task. Your arguments ARE the data; "
				+ "they are validated against this schema — this tool's parameter schema IS the required shape of your result.\n\n"
				+ "Do not output the result as text — call this tool instead.\n"
				+ "If validation fails, the error names the fields that failed: "
				+ "fix those fields to match this tool's parameter schema and call the tool again.",
		parameters,
		async execute(_toolCallId: string, params: unknown) {
			// D2 透传：pi-ai 参数层已按上面的 parameters（= 权威 schema）校验 + 类型矫正过
			// arguments，execute 不做第二校验（第二校验权威是方案 A 明令禁止的形态）。
			// 非 object 根的 {value} 解包由 executeStructuredOutput 的 workflow 分支按
			// 「根是否 object」对称完成（与注册期包装判定同一函数 isObjectRootSchema）。
			return executeStructuredOutput({ data: params, authoritativeSchema: schema });
		},
	};
}

// ── Daily variant (self-reported {schema, data}, unchanged behavior) ──

export function createDailyToolDefinition() {
	return {
		name: TOOL_NAME,
		label: "Structured Output",
		description:
			"Return structured output validated against a JSON Schema. "
			+ "Call this tool to produce validated JSON data. "
			+ "Pass `schema` (a JSON Schema draft-07 object) and `data` (the value to validate). "
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
			// 运行假设：workflow 子进程是单 session 进程（由 applySchemaEnvToChildEnv 在
			// session-runner 注入 PI_WORKFLOW_SCHEMA）。装配分岔下日常变体注册时 env 为空，
			// 但桥接判定保留（ENV_SCHEMA 存在 = workflow 模式）：env 有值时注入
			// authoritativeSchema 走 execute 的 workflow 透传分支。
			// 判空用 `|| undefined` 归一空串为 undefined（truthy 语义），与 entry 的
			// `if (schemaEnv)` 统一：空串 env 视为未设置。
			const authoritativeSchema = process.env[ENV_SCHEMA] || undefined;
			return executeStructuredOutput(
				authoritativeSchema !== undefined
					? { ...params, authoritativeSchema }
					: params,
			);
		},
	};
}
