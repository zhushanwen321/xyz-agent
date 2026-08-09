// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/structured-output.test.ts
//
// 测试 structured-output extension 的核心逻辑：
// 1. Schema 解析与 Ajv 编译
// 2. Tool execute 校验（通过/失败）
// 3. 环境变量检测逻辑
// 4. 权威模式（workflow）错误消息格式锁定（M5-C1）
//
// 权威模式四类错误消息格式（M5 决策：锁定现状，不统一）：
//   ① validateWithAuthoritative keyword-less → 'no recognized keyword' + 'Received schema='
//      （'Received schema=' 回显的是 authSchema——validateWithAuthoritative 签名 (data, authSchema)
//      无 LLM schema 参数）
//   ② validateWithAuthoritative 编译失败/校验失败 → 'The authoritative schema (PI_WORKFLOW_SCHEMA) is:'
//      + 'Received data='（无 'Received schema='）
//   ③ execute 入口 boolean true → 'boolean true' + 'Received schema='（回显 LLM schema）
//   ④ execute 入口 boolean false → 'Schema validation failed (authoritative)' + 'Received schema='
// 标签不统一是有意的：'Received schema=' 在 validateWithAuthoritative 内回显 authSchema、
// 在 execute 入口回显 LLM schema。未来统一走独立源码 wave，届时本契约随测试一并更新。

// 直接使用真实的 Ajv，因为这是核心依赖
import Ajv from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 被测主入口（src/index.ts 导出 executeStructuredOutput 供直接调用；
// createToolDefinition 供 env→execute 桥接测试调用）
import { createToolDefinition, executeStructuredOutput } from "../src/index.js";
// validateWithAuthoritative 未被 index.ts re-export，格式锁定用例直调 src/execute.js 子模块
//（M5-C1：不改对外 API）
import { validateWithAuthoritative } from "../src/execute.js";
// mock pi 公共 fixture（M5-T4：与 characterization-hook.test.ts 共享）
import {
  createMockPi,
  FAILED_TOOL_END,
  loadExtension,
  restoreSchemaEnv,
  SCHEMA,
  SCHEMA_ENV_NAME,
  SUCCESS_TOOL_END,
  turnEndPayload,
} from "./mock-pi-fixture.js";

// ── 纯逻辑测试：Schema 解析 + Ajv 校验 ──────────────────────

describe("Schema parsing and Ajv validation", () => {
  let ajv: Ajv;

  beforeEach(() => {
    ajv = new Ajv({ strict: false });
  });

  it("compiles a valid schema and validates matching input", () => {
    const schema = {
      type: "object",
      properties: {
        mustFix: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
      },
      required: ["mustFix"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ mustFix: true, issues: ["bug"] })).toBe(true);
    expect(validate({ mustFix: false })).toBe(true);
    expect(validate({ mustFix: true, extra: "ok" })).toBe(true); // additionalProperties allowed by default
  });

  it("rejects input that does not match schema", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ count: "not-a-number" })).toBe(false);
    expect(validate({})).toBe(false); // missing required
    expect(validate({ count: 42 })).toBe(true);
  });

  it("produces detailed error messages on validation failure", () => {
    const schema = {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 100 },
      },
      required: ["score"],
    };

    const validate = ajv.compile(schema);
    validate({ score: -1 });

    expect(validate.errors).toBeDefined();
    expect(validate.errors!.length).toBeGreaterThan(0);
    const errorMsg = validate.errors!.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    expect(errorMsg).toContain("must be");
  });

  it("validates nested object schemas", () => {
    const schema = {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            items: { type: "array" },
          },
          required: ["items"],
        },
      },
      required: ["result"],
    };

    const validate = ajv.compile(schema);

    expect(validate({ result: { items: [1, 2, 3] } })).toBe(true);
    expect(validate({ result: {} })).toBe(false); // missing items
    expect(validate({})).toBe(false); // missing result
  });
});

// ── 环境变量解析逻辑 ──────────────────────────────────────

describe("PI_WORKFLOW_SCHEMA schema JSON parsing", () => {
  // 注：旧版测的是 STRUCTURED_OUTPUT_SCHEMA env 名（错误）+ 已删除的 block 语义。
  // 实际 env 名是 PI_WORKFLOW_SCHEMA（见 src/index.ts ENV_SCHEMA），工具现已
  // 无条件全局注册，env 只控制是否注册 workflow hook。env 驱动的行为由下面的
  // 'Workflow hook' 测试组用 mock pi 覆盖；这里仅保留 schema JSON 解析的纯逻辑。
  it("parses valid JSON schema", () => {
    const raw = JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
    });
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe("object");
    expect(parsed.properties.answer.type).toBe("string");
  });

  it("JSON.parse throws on invalid JSON", () => {
    expect(() => JSON.parse("{invalid json")).toThrow();
  });

  it("Ajv rejects invalid schema type value", () => {
    const ajv = new Ajv({ strict: false });
    // Schema with invalid type value — compile throws in non-strict mode too
    const badSchema = { type: "not-a-real-type" };
    expect(() => ajv.compile(badSchema)).toThrow();
  });
});

// ── Tool execute 模拟测试 ──────────────────────────────────

describe("Tool execute behavior simulation", () => {
  it("returns terminate:true on valid input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const validate = ajv.compile(schema);

    const params = { ok: true };
    const valid = validate(params);

    expect(valid).toBe(true);
    // Simulated tool result
    const result = {
      content: [{ type: "text" as const, text: "Structured output recorded successfully." }],
      details: params,
      terminate: true,
    };
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ ok: true });
  });

  it("throws with Ajv error details on invalid input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const validate = ajv.compile(schema);

    const params = { count: "not-a-number" };
    const valid = validate(params);

    expect(valid).toBe(false);
    expect(validate.errors).toBeDefined();

    // Simulated tool error
    const errors = validate.errors!.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    const errorMsg = `Schema validation failed: ${errors}`;
    expect(errorMsg).toContain("must be");
  });

  it("accepts passthrough params (any JSON object)", () => {
    const ajv = new Ajv({ strict: false });
    // Complex schema matching real workflow usage
    const schema = {
      type: "object",
      properties: {
        mustFix: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
        metadata: {
          type: "object",
          properties: {
            score: { type: "number" },
            confidence: { type: "number" },
          },
        },
      },
      required: ["mustFix"],
    };
    const validate = ajv.compile(schema);

    // Valid complex input
    expect(validate({
      mustFix: true,
      issues: ["unused variable", "missing return type"],
      metadata: { score: 0.85, confidence: 0.92 },
    })).toBe(true);

    // Minimal valid input
    expect(validate({ mustFix: false })).toBe(true);
  });
});

// ── Workflow hook: "called but failed" retry (Fix A) ──────
//
// 验证 setupWorkflowHook 的核心行为：当模型调用了 structured-output 但校验失败
// （isError=true）时，turn_end 应主动 steer 提示修正（而非旧实现的撒手交给 Pi 自然修正）。
// 通过 mock pi API（捕获 on() 回调 + spy sendUserMessage）驱动真实扩展入口点。

describe("Workflow hook: structured-output failure retry", () => {
  const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

  afterEach(() => {
    // fixture 的 restoreSchemaEnv 只处理 env；vi.restoreAllMocks 必须在消费方保留
    restoreSchemaEnv(originalSchemaEnv);
    vi.restoreAllMocks();
  });

  it("steers on 'called but failed' with the specific validation error + correct schema", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendUserMessage.mock.calls[0]!;
    expect(msg).toContain("FAILED validation");
    expect(msg).toContain("Schema validation failed: /count must be number");
    // 新文案：告知 schema 由系统注入，引导只传 data
    expect(msg).toContain(`The required schema for your \`data\` is: ${SCHEMA}`);
    expect(msg).toContain("ONLY the `data` parameter");
    expect(opts).toEqual({ deliverAs: "steer" });
  });

  it("steers on 'never called' with the 'must call' reminder (no validation error)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 没有 tool_execution_end（完全没调），直接 turn_end
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(msg).toContain("MUST call the structured-output tool");
    expect(msg).not.toContain("FAILED validation");
    // 与 failed 分支对齐：断言新增的 steer 关键文案（schema 由系统注入，只传 data）
    expect(msg).toContain("ONLY `data`");
    expect(msg).toContain("Do NOT pass a `schema`");
  });

  it("does NOT steer when structured-output succeeded", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", SUCCESS_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("stops steering after MAX_HOOK_RETRIES (=2) exhausted", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 两次"调了但失败" → 两次 steer；第三次不再 steer
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
      await pi.emit("turn_end", turnEndPayload());
    }
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("does not steer when stopReason is toolUse (still in tool chain)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload("toolUse"));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ── Tool execute 真实调用测试（executeStructuredOutput）──────────────────
//
// 直接调 src/index.ts 导出的 executeStructuredOutput，覆盖三类路径：
//   - 合法 schema + data → 成功
//   - 坏 schema（ajv 编译失败）/互换/keyword-less → 抛带纠错文案的错误
//   - data 不匹配 → 抛 Schema validation failed
// 这是防静默腐败的核心保障：互换检测 + keyword-less schema 拒绝。

describe("Tool execute (real call via executeStructuredOutput)", () => {
  it("succeeds on valid object schema + matching data", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      data: { name: "Alice" },
    });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ name: "Alice" });
  });

  it("succeeds on primitive number root schema", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "number", minimum: 0, maximum: 100 },
      data: 42,
    });
    expect(result.details).toEqual(42);
  });

  it("succeeds on primitive boolean root schema", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "boolean" },
      data: true,
    });
    expect(result.details).toEqual(true);
  });

  it("succeeds on array root schema", async () => {
    const result = await executeStructuredOutput({
      schema: { type: "array", items: { type: "string" } },
      data: ["a", "b", "c"],
    });
    expect(result.details).toEqual(["a", "b", "c"]);
  });

  it("accepts JSON-string schema/data (normalize path)", async () => {
    const result = await executeStructuredOutput({
      schema: JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }),
      data: JSON.stringify({ ok: true }),
    });
    expect(result.details).toEqual({ ok: true });
  });

  it("throws 'Invalid JSON Schema' when ajv cannot compile", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "not-a-real-type" },
        data: {},
      }),
    ).rejects.toThrow(/Invalid JSON Schema/);
  });

  it("throws swap detection when data looks like a schema and schema looks like data", async () => {
    // 弱模型把答案塞 schema、把形状塞 data 的典型互换形态
    await expect(
      executeStructuredOutput({
        schema: { name: "Alice", age: 30 }, // 对象但无任何 schema keyword → 像数据
        data: { type: "object", properties: { name: { type: "string" } } }, // 含 keyword → 像 schema
      }),
    ).rejects.toThrow(/swapped/i);
  });

  it("throws 'no recognized keyword' for keyword-less schema (silent-corruption guard)", async () => {
    // {} / {a:1} 会被 ajv strict:false 编译成"接受一切"，必须显式拒绝
    await expect(
      executeStructuredOutput({
        schema: { a: 1 },
        data: { name: "Alice" },
      }),
    ).rejects.toThrow(/recognized keyword/i);
  });

  it("rejects empty schema object {} (keyword-less, silent-corruption guard)", async () => {
    await expect(
      executeStructuredOutput({
        schema: {},
        data: { anything: true },
      }),
    ).rejects.toThrow(/recognized keyword/i);
  });

  it("does NOT flag swap when both schema and data are valid (regression guard)", async () => {
    // schema 有 keyword 且 data 是普通答案 → 不应误判为互换
    await expect(
      executeStructuredOutput({
        schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] },
        data: { score: 8 },
      }),
    ).resolves.toBeDefined();
  });

  it("throws 'Schema validation failed' when data does not match schema", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        data: { count: "not-a-number" },
      }),
    ).rejects.toThrow(/Schema validation failed/);
  });

  it("echoes received schema/data in validation-failure error", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        data: { count: "x" },
      }),
    ).rejects.toThrow(/Received schema=/);
  });

  it("echoes received schema/data in swap error", async () => {
    await expect(
      executeStructuredOutput({
        schema: { answer: "hello" },
        data: { type: "string" },
      }),
    ).rejects.toThrow(/Received schema=.*data=/s);
  });

  it("rejects malformed-JSON-string schema (tryParseJson keeps raw → reject)", async () => {
    await expect(
      executeStructuredOutput({ schema: "{invalid", data: {} }),
    ).rejects.toThrow(/Invalid JSON Schema/);
  });

  it("rejects null / undefined / array / number schema", async () => {
    const badSchemas: unknown[] = [null, undefined, [], 42];
    for (const bad of badSchemas) {
      await expect(
        executeStructuredOutput({ schema: bad, data: {} }),
      ).rejects.toThrow(/Invalid JSON Schema/);
    }
  });

  it("accepts boolean root schema (draft-07: true = accept all)", async () => {
    const result = await executeStructuredOutput({ schema: true, data: { ok: 1 } });
    expect(result.details).toEqual({ ok: 1 });
  });
});

// ── 权威 schema（workflow 模式）测试 ──────────────────────────
//
// [HISTORICAL] 2026-08-01 事故回归：workflow 模式下 PI_WORKFLOW_SCHEMA 注入权威 schema，
// executeStructuredOutput 用它校验 data，LLM 传入的 schema 参数不参与校验。
// 核心保障：LLM 无法通过自报 schema 自洽绕过格式约束。
// 直接调 executeStructuredOutput 显式传 authoritativeSchema 模拟 env 注入路径。

describe("Authoritative schema (workflow mode)", () => {
  // 08-01 事故的 schema 形态：add_channels.items 要求 object，LLM 篡改成 string
  const authoritativeSchema = {
    type: "object",
    properties: {
      channels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            action: { type: "string", enum: ["add", "remove", "fix"] },
          },
          required: ["name", "action"],
        },
      },
    },
    required: ["channels"],
  };

  it("authoritativeSchema 存在 + data 合规 → 通过，details = data", async () => {
    const result = await executeStructuredOutput({
      schema: authoritativeSchema, // LLM 传的 schema（碰巧和权威一致）
      data: { channels: [{ name: "ch1", action: "add" }] },
      authoritativeSchema,
    });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ channels: [{ name: "ch1", action: "add" }] });
  });

  // 核心回归用例：直接复现 08-01 事故——LLM 篡改 schema（items 改成 string）
  // + data 跟着篡改（传字符串数组），必须被权威 schema 拒绝。
  // 旧实现（校验 LLM schema）会让其通过 → 静默腐败；方案 A 必须拒绝。
  it("rejects LLM-rewritten schema even when data matches the rewritten schema", async () => {
    const rewrittenSchema = {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string" }, // LLM 篡改：object → string
        },
      },
      required: ["channels"],
    };
    // data 符合篡改后的 schema（字符串数组），但不符合权威 schema（要求对象数组）
    await expect(
      executeStructuredOutput({
        schema: rewrittenSchema,
        data: { channels: ["ch1", "ch2"] },
        authoritativeSchema,
      }),
    ).rejects.toThrow(/Schema validation failed \(authoritative\)/);
  });

  it("authoritativeSchema error includes authoritative schema echo for LLM guidance", async () => {
    await expect(
      executeStructuredOutput({
        schema: { type: "object" }, // LLM 宽松 schema
        data: { channels: "not-an-array" }, // 不符合权威 schema
        authoritativeSchema,
      }),
    ).rejects.toThrow(/authoritative schema \(PI_WORKFLOW_SCHEMA\) is:/);
  });

  it("authoritativeSchema absent → falls through to daily-mode defense (regression guard)", async () => {
    // 不传 authoritativeSchema → 走日常防御链（LLM schema 校验）。
    // 用一个 LLM schema + 合规 data 应通过（证明没误入权威分支抛错）。
    const result = await executeStructuredOutput({
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      data: { ok: true },
    });
    expect(result.details).toEqual({ ok: true });
  });

  it("authoritativeSchema present but LLM omits schema param → still validates data", async () => {
    // 方案 A 后 schema 参数非必需。LLM 只传 data（schema=undefined）也应正常校验。
    // 这对应提示词引导的新用法：「只需传 data」。
    const result = await executeStructuredOutput({
      schema: undefined,
      data: { channels: [{ name: "ch1", action: "fix" }] },
      authoritativeSchema,
    });
    expect(result.details).toEqual({ channels: [{ name: "ch1", action: "fix" }] });
  });

  // ── 权威分支类型边界（draft-07 允许 boolean 根；非 object/boolean 必须拒绝）──
  // 覆盖 src/index.ts assertJsonSchemaRoot 的三个分支：boolean true / boolean false / 非法类型。

  it("authoritativeSchema = boolean true → rejected (ERR-7: accept-all provides no shape constraint)", async () => {
    // M4 设防：boolean true（accept-all）不提供任何形状约束，workflow 用它等于没校验，
    // 与 keyword-less 对象同等拒绝（ERR-7），恢复指引要求改为 object schema。
    // （draft-07 合法根，但权威模式下必须拒绝——否则声明的约束静默失效。）
    // 格式锁定（M5-C1 ③）：execute 入口 boolean 分支回显 LLM schema（'Received schema='）。
    const err = await executeStructuredOutput({
      schema: undefined,
      data: { anything: "goes", n: 42 },
      authoritativeSchema: true,
    }).catch((e: unknown) => e as Error);
    expect(err.message).toContain("boolean true");
    expect(err.message).toContain("object schema");
    expect(err.message).toContain("Received schema=");
  });

  it("authoritativeSchema = boolean false → rejects all data (draft-07 reject-all root)", async () => {
    // 格式锁定（M5-C1 ④）：'Schema validation failed (authoritative)' + 'Received schema='。
    // 注意与 ②（validateWithAuthoritative 直调）不同：execute 入口的 boolean 分支
    // 同时含权威标签与 'Received schema='（LLM schema 回显，此处 schema=undefined 回显 undefined）。
    const err = await executeStructuredOutput({
      schema: undefined,
      data: { anything: "goes" },
      authoritativeSchema: false,
    }).catch((e: unknown) => e as Error);
    expect(err.message).toContain("Schema validation failed (authoritative)");
    expect(err.message).toContain("Received schema=");
  });

  it("authoritativeSchema = non object/boolean (string) → throws clear type error", async () => {
    // 非法形态（如 "invalid"）经 tryParseJson 保留原值 → assertJsonSchemaRoot 抛错，
    // 外层 catch 包成 "Invalid authoritative JSON Schema" 含 echo 的错误。
    await expect(
      executeStructuredOutput({
        schema: undefined,
        data: {},
        authoritativeSchema: "invalid",
      }),
    ).rejects.toThrow(/Invalid authoritative JSON Schema.*got string/s);
  });

  // ── 权威模式错误消息格式锁定（M5-C1）──
  // validateWithAuthoritative 直调子模块（index.ts 未 re-export），断言四种格式快照，
  // 防未来无意识漂移。格式细节见文件头注释。

  it("validateWithAuthoritative 直调：校验失败 → 权威标签 + data 回显（M5-C1 ②）", () => {
    const err = (() => {
      try {
        validateWithAuthoritative({ channels: "not-an-array" }, authoritativeSchema);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    // 签名 (data, authSchema) 无 LLM schema 参数 → 无 'Received schema='，只有权威 schema 标签 + data 回显
    expect(err!.message).toContain("Schema validation failed (authoritative)");
    expect(err!.message).toContain("The authoritative schema (PI_WORKFLOW_SCHEMA) is:");
    expect(err!.message).toContain("Received data=");
    expect(err!.message).not.toContain("Received schema=");
  });

  it("validateWithAuthoritative 直调：keyword-less 权威 schema → 'no recognized keyword' + 'Received schema='（M5-C1 ①）", () => {
    // 格式锁定：keyword-less 分支的 'Received schema=' 回显的是 authSchema（{a:1}），
    // 非 LLM schema——validateWithAuthoritative 签名无 LLM schema 参数。
    const err = (() => {
      try {
        validateWithAuthoritative({ name: "Alice" }, { a: 1 });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain("no recognized keyword");
    expect(err!.message).toContain("Received schema=");
  });
});

// ── env → execute 桥接测试（createToolDefinition.execute 读 PI_WORKFLOW_SCHEMA）──
//
// Must-fix #1：createToolDefinition().execute() 里读 process.env[PI_WORKFLOW_SCHEMA]
// 注入 authoritativeSchema 的桥接分支此前无测试覆盖——5 个权威用例都直接调
// executeStructuredOutput({...authoritativeSchema}) 绕过了这个 env→execute 注入点。
// 若该行被误删/改错，整个方案 A 会静默回退到旧实现（LLM 自报 schema 校验），
// 与本次修复要消除的静默腐败属同一类失败模式。本组用 createToolDefinition().execute()
// 驱动真实 env 注入路径，断言权威校验生效。

describe("createToolDefinition.execute env bridge (PI_WORKFLOW_SCHEMA → authoritative)", () => {
  const SCHEMA_ENV_NAME = "PI_WORKFLOW_SCHEMA";
  const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

  // 用真实的 execute（不 mock executeStructuredOutput），覆盖 env 读取 + 注入 + 校验全链路。
  // createToolDefinition().execute 签名是 (toolCallId, params)；toolCallId 在内部未使用。
  const toolDef = createToolDefinition();
  const exec = (params: { schema?: unknown; data: unknown }) =>
    toolDef.execute("call-id-1", params);

  afterEach(() => {
    if (originalSchemaEnv === undefined) delete process.env[SCHEMA_ENV_NAME];
    else process.env[SCHEMA_ENV_NAME] = originalSchemaEnv;
  });

  const AUTHORITY = JSON.stringify({
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  });

  it("env set + data non-conformant → throws 'Schema validation failed (authoritative)'", async () => {
    process.env[SCHEMA_ENV_NAME] = AUTHORITY;
    // data 缺 required count → 权威校验失败。
    // 注意：即便 LLM 传了一个自洽的宽松 schema，权威分支也只用 env 的 schema 校验。
    await expect(
      exec({ schema: { type: "object" }, data: {} }),
    ).rejects.toThrow(/Schema validation failed \(authoritative\)/);
  });

  it("env set + data conformant → passes, details = data", async () => {
    process.env[SCHEMA_ENV_NAME] = AUTHORITY;
    const result = await exec({ schema: undefined, data: { count: 7 } });
    expect(result.content[0]!.text).toContain("recorded successfully");
    expect(result.details).toEqual({ count: 7 });
  });

  it("env unset → falls through to daily mode (no authoritativeSchema injected)", async () => {
    delete process.env[SCHEMA_ENV_NAME];
    // env 未设 → execute 不注入 authoritativeSchema → 走日常防御链。
    // 用一个合规的 LLM schema + 合规 data 验证它通过（证明没误入权威分支）。
    const result = await exec({
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      data: { ok: true },
    });
    expect(result.details).toEqual({ ok: true });
  });
});
