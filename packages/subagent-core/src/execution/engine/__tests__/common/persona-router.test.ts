// persona-router.test.ts —— persona 三策略路由 + argv 预算前置拦截。
//
// 三视角：①构建者——三通道产出物各归其位；②使用者——argv 超限时报
// prompt_too_large 且文案含三条恢复建议；③观察者——估算口径含多字节字符与分隔符。

import { describe, expect, it } from "vitest";

import {
  applyPersona,
  assertArgvBudget,
  DEFAULT_ARGV_BUDGET_BYTES,
  estimateArgvBytes,
} from "../../common/persona-router.ts";
import { EngineError } from "../../common/errors.ts";
import type { EngineCapabilities } from "../../types.ts";

const CAPS_FILE: EngineCapabilities = {
  schemaEnforcement: "emulated", steer: "unsupported", conversation: "unsupported",
  personaInjection: "file", eventGranularity: "coarse", sandbox: "none",
  sessionRead: "partial", resume: "cold", interrupt: "kill-only", permissionMode: "native",
};
const CAPS_FLAG: EngineCapabilities = { ...CAPS_FILE, personaInjection: "flag" };
const CAPS_PROMPT: EngineCapabilities = { ...CAPS_FILE, personaInjection: "prompt" };

const persona = {
  agentRef: "reviewer",
  skillPath: "/skills/review.md",
  appendSystemPrompt: ["You are a careful code reviewer.", "Be terse."],
};

describe("applyPersona 三策略路由", () => {
  it("file 策略：人设全文进 fileCandidate（路径相对池目录），promptSegment 为空", () => {
    const routing = applyPersona(persona, CAPS_FILE);
    expect(routing.promptSegment).toBe("");
    expect(routing.fileCandidate).toBeDefined();
    expect(routing.fileCandidate?.suggestedPath).toBe("persona.md");
    expect(routing.fileCandidate?.content).toContain("# Agent: reviewer");
    expect(routing.fileCandidate?.content).toContain("/skills/review.md");
    expect(routing.fileCandidate?.content).toContain("You are a careful code reviewer.");
  });

  it("flag 策略：promptSegment 为纯人设正文（launcher 组 flag 直传），无 fileCandidate", () => {
    const routing = applyPersona(persona, CAPS_FLAG);
    expect(routing.fileCandidate).toBeUndefined();
    expect(routing.promptSegment).toContain("You are a careful code reviewer.");
    expect(routing.promptSegment).toContain("Be terse.");
    // 纯正文：不带 prompt 通道的结构头
    expect(routing.promptSegment).not.toContain("## Persona");
  });

  it("prompt 策略：promptSegment 为带结构头的人设段（拼进最终 prompt）", () => {
    const routing = applyPersona(persona, CAPS_PROMPT);
    expect(routing.promptSegment.startsWith("## Persona")).toBe(true);
    expect(routing.promptSegment).toContain("# Agent: reviewer");
    expect(routing.promptSegment).toContain("You are a careful code reviewer.");
  });

  it("空 persona（全字段缺省）：三通道都产出空载体（白占 argv/prompt 无意义）", () => {
    expect(applyPersona({}, CAPS_FILE)).toEqual({ promptSegment: "" });
    expect(applyPersona({}, CAPS_FLAG)).toEqual({ promptSegment: "" });
    expect(applyPersona({}, CAPS_PROMPT)).toEqual({ promptSegment: "" });
  });

  it("仅 appendSystemPrompt：file 通道照常落文件（agentRef/skillPath 头部行缺省）", () => {
    const routing = applyPersona({ appendSystemPrompt: ["only body"] }, CAPS_FILE);
    expect(routing.fileCandidate?.content).toBe("only body");
  });
});

describe("estimateArgvBytes", () => {
  it("ASCII：字节数之和 + 每参数 1 个 NUL 分隔符", () => {
    // "ab"(2) + "cde"(3) + 2 个 NUL = 7
    expect(estimateArgvBytes(["ab", "cde"])).toBe(7);
    expect(estimateArgvBytes([])).toBe(0);
  });

  it("多字节字符按 UTF-8 计（中文 3 字节/字）——字符数口径会低估", () => {
    // "中"=3 字节 + 1 NUL = 4
    expect(estimateArgvBytes(["中"])).toBe(4);
    // "a中b" = 1+3+1 = 5 字节 + 1 = 6
    expect(estimateArgvBytes(["a中b"])).toBe(6);
  });
});

describe("assertArgvBudget", () => {
  it(`默认上限 ${DEFAULT_ARGV_BUDGET_BYTES} 字节（128KB）且预算内通过`, () => {
    expect(DEFAULT_ARGV_BUDGET_BYTES).toBe(128 * 1024);
    expect(() => assertArgvBudget(["--prompt", "short"])).not.toThrow();
  });

  it("超限抛 prompt_too_large：detail 含实际/上限字节数", () => {
    const bigArg = "x".repeat(1024);
    const argv = [bigArg, bigArg]; // 2KB，limit 1KB
    let caught: EngineError | undefined;
    try {
      assertArgvBudget(argv, 1024);
      expect.unreachable("should throw");
    } catch (err) {
      caught = err as EngineError;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught?.code).toBe("prompt_too_large");
    expect(caught?.message).toContain("2050"); // 1024*2 + 2 NUL
    expect(caught?.message).toContain("1024");
  });

  it("错误恢复指引含三条建议：缩短 task / persona 移 file 通道 / 换 stdin 引擎", () => {
    try {
      assertArgvBudget(["y".repeat(3000)], 1024);
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as EngineError;
      expect(e.recovery).toMatch(/shorten the task/i);
      expect(e.recovery).toMatch(/file channel/);
      expect(e.recovery).toMatch(/stdin/);
    }
  });

  it("limit 可配（调用方收紧到引擎实测限额）", () => {
    expect(() => assertArgvBudget(["a".repeat(100)], 50)).toThrowError(/prompt_too_large/);
    expect(() => assertArgvBudget(["a".repeat(100)], 101)).not.toThrow();
  });
});
