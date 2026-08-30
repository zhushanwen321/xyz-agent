// errors.test.ts —— 引擎层错误 SSOT 的结构锁定。
//
// 三视角：①构建者——11 条 code 与设计 §3.3.3 全表一致；②使用者——错误消息
// code 前缀格式可被字符串匹配分流；③观察者——每条错误必有非空恢复指引（可操作）。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECOVERY_HINTS,
  ENGINE_ERROR_CODES,
  EngineError,
  engineRunFailedDetail,
  engineTimeoutDetail,
  isEngineErrorCode,
  nestedSpawnRejectedError,
  promptTooLargeError,
  schemaEmulationFailedDetail,
  STDOUT_TAIL_ECHO_CHARS,
} from "../../common/errors.ts";

describe("ENGINE_ERROR_CODES（§3.3.3 全表）", () => {
  it("11 条错误码与设计文档错误规格表逐条一致", () => {
    expect([...ENGINE_ERROR_CODES]).toEqual([
      "engine_not_found",
      "engine_probe_failed",
      "engine_credential_missing",
      "nested_spawn_rejected",
      "schema_emulation_failed",
      "engine_timeout",
      "engine_capability_unsupported",
      "engine_session_not_resumable",
      "model_not_available",
      "prompt_too_large",
      "engine_run_failed",
    ]);
  });

  it("isEngineErrorCode 收窄：表内 code 为 true，表外/非字符串为 false", () => {
    expect(isEngineErrorCode("engine_timeout")).toBe(true);
    expect(isEngineErrorCode("engine_not_found")).toBe(true);
    expect(isEngineErrorCode("engine_oops")).toBe(false);
    expect(isEngineErrorCode(42)).toBe(false);
    expect(isEngineErrorCode(undefined)).toBe(false);
  });
});

describe("DEFAULT_RECOVERY_HINTS（恢复指引全集）", () => {
  it("11 条 code 每条都有非空恢复指引（可操作，非安慰性文案）", () => {
    for (const code of ENGINE_ERROR_CODES) {
      const hint = DEFAULT_RECOVERY_HINTS[code];
      expect(hint, `recovery hint for ${code}`).toMatch(/\S/);
      expect(hint.length).toBeGreaterThan(20);
    }
  });

  it("关键恢复动作在指引中（抽查三条错误规格的载体系数）", () => {
    expect(DEFAULT_RECOVERY_HINTS.engine_timeout).toMatch(/stdout tail/i);
    expect(DEFAULT_RECOVERY_HINTS.prompt_too_large).toMatch(/stdin/);
    expect(DEFAULT_RECOVERY_HINTS.nested_spawn_rejected).toMatch(/inside the current task/);
  });
});

describe("EngineError", () => {
  it("message 为 <code>: <detail> 前缀格式（outcome.error 分流依据）", () => {
    const err = new EngineError("engine_timeout", "chain exhausted", "retry with pi");
    expect(err.message).toBe("engine_timeout: chain exhausted");
    expect(err.code).toBe("engine_timeout");
    expect(err.recovery).toBe("retry with pi");
    expect(err.name).toBe("EngineError");
  });

  it("toStructured 投影 code/message/recovery 三字段", () => {
    const structured = new EngineError("model_not_available", "no such model", "pick another").toStructured();
    expect(structured).toEqual({
      code: "model_not_available",
      message: "model_not_available: no such model",
      recovery: "pick another",
    });
  });
});

describe("具名构造器", () => {
  it("promptTooLargeError：detail 含实际/上限字节数，recovery 含三条恢复建议", () => {
    const err = promptTooLargeError(200_000, 131_072);
    expect(err.code).toBe("prompt_too_large");
    expect(err.message).toContain("200000");
    expect(err.message).toContain("131072");
    expect(err.recovery).toMatch(/shorten the task/i);
    expect(err.recovery).toMatch(/file channel/);
    expect(err.recovery).toMatch(/stdin/);
  });

  it("nestedSpawnRejectedError：说明防护规则 + 指向 task 内自行完成", () => {
    const err = nestedSpawnRejectedError();
    expect(err.code).toBe("nested_spawn_rejected");
    expect(err.message).toContain("XYZ_AGENT_SUBAGENT");
    expect(err.recovery).toMatch(/inside the current task/);
  });

  it("engineTimeoutDetail：含 stdout 尾部 + engine: pi 重跑建议", () => {
    const detail = engineTimeoutDetail("partial stdout output");
    expect(detail).toContain("partial stdout output");
    expect(detail).toMatch(/SIGTERM/);
    expect(detail).toMatch(/SIGKILL/);
    expect(detail).toMatch(/`engine: pi`/);
  });

  it(`engineTimeoutDetail：stdout 尾部截断到 ${STDOUT_TAIL_ECHO_CHARS} 字符`, () => {
    const longTail = "x".repeat(STDOUT_TAIL_ECHO_CHARS + 500);
    const detail = engineTimeoutDetail(longTail);
    // 截断后含省略号标记，总长有界（不含前后固定文案不超过 2000 + 常量开销）
    expect(detail).toContain("...");
    expect(detail.length).toBeLessThan(STDOUT_TAIL_ECHO_CHARS + 600);
  });

  it("engineRunFailedDetail：含 reason / exit code / 尾部 / 恢复指引", () => {
    const detail = engineRunFailedDetail("stdout parse failed", 3, "some output");
    expect(detail).toContain("stdout parse failed");
    expect(detail).toContain("exit code 3");
    expect(detail).toContain("some output");
    expect(detail).toMatch(/probe/);
    // exitCode=null（被信号杀死）的形态
    expect(engineRunFailedDetail("crash", null, "t")).toContain("killed by signal");
  });

  it("schemaEmulationFailedDetail：含错误明细 + 原始输出尾部 + 重试一次语义", () => {
    const detail = schemaEmulationFailedDetail("Schema validation failed: /a must be number", '{"a":"x"}');
    expect(detail).toContain("Schema validation failed");
    expect(detail).toContain('{"a":"x"}');
    expect(detail).toMatch(/retry once/i);
  });
});
