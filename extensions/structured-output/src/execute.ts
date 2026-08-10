/**
 * executeStructuredOutput 编排 + 校验双函数（IF-6 拆分）。
 *
 * 两种模式：
 *   - 权威模式（workflow）：`authoritativeSchema` 存在时，只用它校验 data，LLM 传入的
 *     `schema` 不参与校验（仅用于错误回显）。这从根上杜绝 LLM 自报 schema 自洽绕过
 *     （[HISTORICAL] 2026-08-01 事故：ds-flash 重写 add_channels.items 的 schema 后
 *     自洽通过，4 条 channel 修复静默丢失）。
 *   - 日常模式（交互式）：无 `authoritativeSchema`，走 validateAgainstSelfReported 防御链。
 *
 * 权威模式设防（SO-1 修复）：权威分支不再跳过防御链——keyword-less 权威 schema
 * （{} / {a:1}）被显式拒绝（ERR-3），boolean true（accept-all，无形状约束）被拦截
 * （ERR-7），否则 workflow 声明的约束会在 ajv strict:false 下静默失效。
 *
 * 日常模式防御顺序（编译前拦截，治静默腐败的根）：
 *   1. 互换检测 — schema 像数据（无 keyword）且 data 像 schema（有 keyword）→ 抛纠错
 *   2. keyword-less schema 拒绝 — schema 是对象但无任何识别 keyword（{} / {a:1}）
 *      → 抛 "no recognized keyword"，否则 ajv strict:false 会编译成"接受一切"
 *   3. ajv 编译失败 → 抛 "Invalid JSON Schema"（含回显）
 *   4. 校验失败 → 抛 "Schema validation failed"（含回显）
 */

import type { ValidateFunction } from "ajv";

import { getOrCompileValidator } from "./ajv-validator.js";
import {
	assertJsonSchemaRoot,
	CORRECT_USAGE_HINT,
	echo,
	hasSchemaKeyword,
	isPlainObject,
	tryParseJson,
} from "./schema-guards.js";

/**
 * 权威模式校验（IF-6）。authSchema 由 workflow 脚本（PI_WORKFLOW_SCHEMA env）注入，
 * 是唯一校验权威——LLM 传入的 schema 不参与校验，仅用于编排层错误回显。
 *
 * 权威模式不再跳过日常防御链（SO-1 修复）：keyword-less 权威 schema 必须先过
 * schema-guards 检查，否则 ajv strict:false 会静默编译成 accept-all，workflow 的
 * 形状约束失效且零报错（与 08-01 事故同类的静默腐败路径）。
 *
 * @returns 校验通过恒为 true；任何失败形态抛错（带恢复指引 + 回显）。
 */
export function validateWithAuthoritative(data: unknown, authSchema: object): boolean {
	// 类型收窄：签名声明 object（C2 契约），hasSchemaKeyword 需要索引签名。
	// 编排层已 assertJsonSchemaRoot 保证 plain object；直接调用方传 plain object。
	if (!isPlainObject(authSchema)) {
		throw new Error(
			"Authoritative schema (PI_WORKFLOW_SCHEMA) must be a plain object, got "
			+ typeof authSchema,
		);
	}

	// 1. keyword-less 拒绝（ERR-3）：权威 schema 必须用 JSON Schema 关键字描述形状。
	// 无 keyword 的对象会被 ajv 编译成"接受一切"，必须显式拦截并给恢复指引。
	if (!hasSchemaKeyword(authSchema)) {
		throw new Error(
			"Authoritative schema (PI_WORKFLOW_SCHEMA) has no recognized keyword. "
			+ "A workflow schema must describe shape via type/properties/items/... "
			+ "👉 检查 workflow 脚本的 outputSchema 定义，补全 JSON Schema 关键字。 "
			+ `Received schema=${echo(authSchema)}, data=${echo(data)}`,
		);
	}

	// 2. 编译 + 校验。编译失败抛清晰错误（含权威 schema 回显供 workflow 作者修正）。
	let validate: ValidateFunction;
	try {
		validate = getOrCompileValidator(authSchema);
	} catch (e) {
		throw new Error(
			`Invalid authoritative JSON Schema (from PI_WORKFLOW_SCHEMA): ${(e as Error).message}. `
			+ `The authoritative schema (PI_WORKFLOW_SCHEMA) is: ${echo(authSchema)}. `
			+ `Received data=${echo(data)}`,
		);
	}

	const valid = validate(data);
	if (!valid) {
		const errors = validate.errors
			?.map((err) => `${err.instancePath} ${err.message}`)
			.join("; ");
		throw new Error(
			`Schema validation failed (authoritative): ${errors}. `
			+ `The authoritative schema (PI_WORKFLOW_SCHEMA) is: ${echo(authSchema)}. `
			+ `Received data=${echo(data)}`,
		);
	}
	return true;
}

/**
 * 日常模式防御链（原 4 步原样迁移）：LLM 自报 schema 的校验路径。
 * 编译前拦截两类静默腐败形态：互换（schema 像数据 + data 像 schema）和
 * keyword-less schema（{} / {a:1} 会被 ajv strict:false 编译成"接受一切"）。
 *
 * @returns 校验通过恒为 true；任何失败形态抛错（带 CORRECT_USAGE_HINT + 回显）。
 */
export function validateAgainstSelfReported(schema: unknown, data: unknown): boolean {
	// 1. 互换检测：schema 像数据（对象无 keyword）且 data 像 schema（对象有 keyword）。
	// 这是最严重的静默腐败路径——若放行，ajv 会把"数据形态的 schema"编译成接受一切，
	// 真正的 schema（此时在 data 里）被丢弃，校验通过并存入垃圾。
	if (isPlainObject(schema) && !hasSchemaKeyword(schema) && isPlainObject(data) && hasSchemaKeyword(data)) {
		throw new Error(
			"Likely swapped: schema looks like data and data looks like a schema. "
			+ CORRECT_USAGE_HINT
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	// 2. keyword-less schema 拒绝：治静默腐败的根。{} / {a:1} 这类对象会被
	// ajv strict:false 编译成"接受一切"的 validator，模型把答案塞进 schema 时会静默通过。
	if (isPlainObject(schema) && !hasSchemaKeyword(schema)) {
		throw new Error(
			"Invalid JSON Schema: schema has no recognized keyword "
			+ "(type/properties/items/enum/...). If you passed the answer value as schema, "
			+ "you likely swapped schema and data. "
			+ CORRECT_USAGE_HINT
			+ `Received schema=${echo(schema)}`,
		);
	}

	// 3. ajv 编译。schema 此时可能是 object（过 keyword 检查）、boolean（合法 draft-07 根）、
	// 或 string/number/array/null（非法 → 显式抛错给清晰提示）。getOrCompileValidator 只接受
	// object|boolean，消除原先的 `as Record<string,unknown>` 不安全 cast。
	let validate: ValidateFunction;
	try {
		if (isPlainObject(schema) || typeof schema === "boolean") {
			validate = getOrCompileValidator(schema);
		} else {
			throw new Error(`schema must be a JSON Schema object or boolean, got ${typeof schema}`);
		}
	} catch (e) {
		throw new Error(
			`Invalid JSON Schema: ${(e as Error).message}. `
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}

	// 4. 校验
	const valid = validate(data);
	if (!valid) {
		const errors = validate.errors
			?.map((err) => `${err.instancePath} ${err.message}`)
			.join("; ");
		throw new Error(
			`Schema validation failed: ${errors}. `
			+ `Received schema=${echo(schema)}, data=${echo(data)}`,
		);
	}
	return true;
}

/**
 * 执行 schema 校验。从 createToolDefinition.execute 抽出以便单元测试直接调用。
 *
 * 编排：tryParseJson 归一 → 权威分支（assertJsonSchemaRoot 收窄 + boolean 拦截 +
 * validateWithAuthoritative）→ 日常分支 validateAgainstSelfReported。
 */
export async function executeStructuredOutput(params: {
	schema: unknown;
	data: unknown;
	/** 权威 schema（workflow 模式由 PI_WORKFLOW_SCHEMA env 注入）。存在时成为唯一校验权威。 */
	authoritativeSchema?: unknown;
}): Promise<{
	content: Array<{ type: "text"; text: string }>;
	// data 可能是 primitive/array/object（根 schema 决定），故 details 为 unknown。
	// 测试断言 toEqual(42)/toEqual(true)/toEqual(["a","b","c"])，不可窄化为 Record。
	details: unknown;
}> {
	// Normalize: some models pass schema/data as JSON strings instead of objects
	const schema = tryParseJson(params.schema);
	const data = tryParseJson(params.data);

	// ── 权威模式（workflow）：用 PI_WORKFLOW_SCHEMA 声明的期望 schema 校验 data。 ──
	// LLM 传入的 schema 仅用于错误回显（告知期望形态），不参与校验——否则 LLM
	// 可同时控制 schema 与 data 自洽绕过任何约束。日常模式无权威 schema 走下方防御链。
	const authoritative =
		params.authoritativeSchema !== undefined ? tryParseJson(params.authoritativeSchema) : undefined;
	if (authoritative !== undefined) {
		try {
			// 先用 assert 函数把 unknown 收窄为 Record<string,unknown> | boolean，
			// 使后续分支在类型层面成立（type-safety）。非 object/boolean 抛清晰错误，
			// 由外层 catch 包成含 echo 的错误。
			assertJsonSchemaRoot(authoritative);
		} catch (e) {
			throw new Error(
				`Invalid authoritative JSON Schema (from PI_WORKFLOW_SCHEMA): ${(e as Error).message}. `
				+ `Received schema=${echo(schema)}, data=${echo(data)}`,
			);
		}

		if (authoritative === true) {
			// ERR-7：boolean true（accept-all）不提供任何形状约束，workflow 用它等于没校验。
			// 必须改为 object schema 才构成真正的约束（keyword-less 拒绝见 validateWithAuthoritative）。
			throw new Error(
				"Authoritative schema (PI_WORKFLOW_SCHEMA) is boolean true (accept-all), "
				+ "provides no shape constraint. 👉 改为带 type/properties/items 的 object schema。"
				+ `Received schema=${echo(schema)}, data=${echo(data)}`,
			);
		}

		if (authoritative === false) {
			// boolean false = reject-all（draft-07 合法根，有形状约束语义：拒绝一切）。
			// 保留原行为：编译 + 校验失败抛 'Schema validation failed (authoritative)'。
			const validate = getOrCompileValidator(false);
			const valid = validate(data);
			if (!valid) {
				const errors = validate.errors
					?.map((err) => `${err.instancePath} ${err.message}`)
					.join("; ");
				throw new Error(
					`Schema validation failed (authoritative): ${errors}. `
					+ `The authoritative schema (PI_WORKFLOW_SCHEMA) is: ${echo(authoritative)}. `
					+ `Received schema=${echo(schema)}, data=${echo(data)}`,
				);
			}
		} else {
			// object 权威 schema：过 keyword-less 检查（ERR-3）+ 编译 + 校验。
			validateWithAuthoritative(data, authoritative);
		}

		return {
			content: [
				{ type: "text" as const, text: "Structured output recorded successfully." },
			],
			details: data,
		};
	}

	// ── 日常模式防御链（validateAgainstSelfReported：互换/keyword-less/编译/校验）──
	validateAgainstSelfReported(schema, data);

	return {
		content: [
			{ type: "text" as const, text: "Structured output recorded successfully." },
		],
		details: data,
	};
}
