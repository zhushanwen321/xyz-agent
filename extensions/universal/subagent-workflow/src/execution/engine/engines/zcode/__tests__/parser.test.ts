// parser.test.ts —— golden 样本回归（验收 2）+ 损坏 stdout 错误路径 + 缓冲有界性。
// golden 原文来自 2026-08-25 真机实录（zcode 0.16.5），采集元数据见 fixture _meta。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildRunFailedMessage,
  createBoundedLineBuffer,
  mapZcodeUsage,
  parseZcodeStdoutJson,
  parseZcodeTerminal,
  synthesizeCoarseEvents,
} from "../parser.ts";

interface GoldenFixture {
  stdoutRaw: string;
  _meta: { engineVersion: string; exitCode: number; usageMapping: string };
}

const golden: GoldenFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/zcode-golden-spawn.json", import.meta.url)), "utf8"),
);

describe("parseZcodeTerminal：golden 回归", () => {
  it("实录样本解析出完整终态（sessionId/response/usage/turnCount）", () => {
    const r = parseZcodeTerminal(golden.stdoutRaw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.sessionId).toBe("sess_35852a0f-1302-4e20-9e48-87f47527abe3");
    expect(r.payload.response).toBe("ok");
    expect(r.payload.usage).toEqual({ input: 12599, output: 17, cacheRead: 512, cacheWrite: 0 });
    expect(r.payload.turnCount).toBe(1);
    // 终态层 usage（orchestration 版）：cost 显式 0（zcode 不回传）、contextTokens=
    // projection.contextUsed、turns=projection.turnCount
    expect(r.payload.outcomeUsage).toEqual({
      input: 12599,
      output: 17,
      cacheRead: 512,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 12616,
      turns: 1,
    });
  });

  it("usage 字段名映射：inputTokens→input 等四项（cost 无来源不出现）", () => {
    const u = mapZcodeUsage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    });
    expect(u).toEqual({ input: 10, output: 20, cacheRead: 5, cacheWrite: 0 });
    expect(u !== undefined && "cost" in u).toBe(false);
  });

  it("usage 形状不完整时显式 undefined（不给残缺对象）", () => {
    expect(mapZcodeUsage(undefined)).toBeUndefined();
    expect(mapZcodeUsage("nope")).toBeUndefined();
    expect(mapZcodeUsage({})).toBeUndefined();
  });
});

describe("parseZcodeTerminal：损坏 stdout → ok:false（engine_run_failed 输入）", () => {
  it("非 JSON 文本", () => {
    const r = parseZcodeTerminal("Error: something broke\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("不是 JSON");
  });

  it("JSON 但缺 string 型 response（格式漂移形态）", () => {
    const r = parseZcodeTerminal('{"sessionId": "sess_x", "usage": {}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("response");
  });

  it("数组/标量 JSON 拒收", () => {
    expect(parseZcodeTerminal("[1,2,3]").ok).toBe(false);
    expect(parseZcodeTerminal("42").ok).toBe(false);
  });

  it("混入日志行时首尾大括号容错提取", () => {
    const mixed = '[info] boot\n{"sessionId":"sess_a","response":"done"}\n[info] exit';
    const r = parseZcodeTerminal(mixed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.sessionId).toBe("sess_a");
    expect(r.payload.response).toBe("done");
  });
});

describe("parseZcodeStdoutJson：空对象形态防御", () => {
  it("无大括号文本返回 null", () => {
    expect(parseZcodeStdoutJson("plain text")).toBeNull();
  });
});

describe("synthesizeCoarseEvents：coarse 不变量", () => {
  it("message_end（含 usage）在前、turn_end 最后", () => {
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    const evs = synthesizeCoarseEvents("ok", usage);
    expect(evs).toEqual([{ type: "message_end", usage }, { type: "turn_end" }]);
  });

  it("无 usage 时 message_end 不带残缺字段", () => {
    const evs = synthesizeCoarseEvents("ok");
    expect(evs[0]).toEqual({ type: "message_end" });
    expect("usage" in evs[0]!).toBe(false);
    expect(evs[evs.length - 1]).toEqual({ type: "turn_end" });
  });
});

describe("buildRunFailedMessage：错误规格（stdout 尾部 + exit code + 恢复指引）", () => {
  it("含 exit code、尾部内容与三段恢复动作", () => {
    const msg = buildRunFailedMessage({
      exitCode: 3,
      stdoutTail: "x".repeat(5000),
      stderrTail: "boom",
      parseReason: "stdout 不是 JSON 对象",
    });
    expect(msg).toContain("engine_run_failed");
    expect(msg).toContain("exit code: 3");
    expect(msg).toContain("解析失败");
    expect(msg).toContain("stderr 尾部: boom");
    // stdout 尾部截断到 2000 字
    expect(msg).toContain("x".repeat(2000));
    expect(msg).not.toContain("x".repeat(2001));
    expect(msg).toContain("--version");
    expect(msg).toContain("golden");
    expect(msg).toContain("engine: pi");
  });

  it("null exit code 标注被信号杀死", () => {
    const msg = buildRunFailedMessage({ exitCode: null, stdoutTail: "" });
    expect(msg).toContain("null（被信号杀死）");
  });

  it("空 stdout 不产生空 part（防「stdout 尾部: <指引段>」视觉嵌套误读）", () => {
    const msg = buildRunFailedMessage({ exitCode: 1, stdoutTail: "   " });
    expect(msg).not.toContain("stdout 尾部");
  });

  it("LLM API 失败（AI_APICallError）归因到端点/凭据指引，不再给 probe 指引", () => {
    const msg = buildRunFailedMessage({
      cliPath: "/fake/zcode.cjs",
      exitCode: 1,
      stdoutTail: "",
      stderrTail: "AI_APICallError: 500 Internal Server Error\nError: Turn execution failed",
      modelRef: "router/mimo-v2.5-pro",
      configPath: "/pool/.zcode/cli/config.json",
    });
    expect(msg).toContain("LLM API 调用失败");
    expect(msg).toContain("router/mimo-v2.5-pro");
    expect(msg).toContain("/pool/.zcode/cli/config.json");
    expect(msg).toContain("baseURL");
    expect(msg).toContain("engine: pi");
    // probe/golden 指引不出现（误导排查方向——2026-08-25 真机教训）
    expect(msg).not.toContain("--version");
    expect(msg).not.toContain("golden");
    expect(msg).not.toContain("stdout 尾部");
  });

  it("LLM 归因在缺省 modelRef/configPath 时兜底可读", () => {
    const msg = buildRunFailedMessage({
      cliPath: "/fake/zcode.cjs",
      exitCode: 1,
      stdoutTail: "ok",
      stderrTail: "Symbol(vercel.ai.error.AI_APICallError): true",
    });
    expect(msg).toContain("LLM API 调用失败");
    expect(msg).toContain("provider 的 baseURL 可达性");
    expect(msg).not.toContain("undefined");
  });

  it("stderr 的 [Object] 噪音行折叠为计数", () => {
    const noisy = [
      "AIError: fail",
      ...Array.from({ length: 12 }, () => "  [Object], [Object],"),
      "    statusCode: undefined,",
    ].join("\n");
    const msg = buildRunFailedMessage({ cliPath: "/c", exitCode: 1, stdoutTail: "", stderrTail: noisy });
    expect(msg).toContain("[Object]×12");
    expect(msg).not.toContain("[Object], [Object]");
  });
});

describe("createBoundedLineBuffer：有界双缓冲", () => {
  it("头 4K + 尾 64K 保留，中间丢弃并标记", () => {
    const buf = createBoundedLineBuffer();
    const line = "a".repeat(100) + "\n"; // 每行 101 字节
    for (let i = 0; i < 2000; i++) buf.push(line); // ~202KB，远超 4K+64K
    const text = buf.text();
    expect(text.startsWith("a".repeat(100))).toBe(true); // 头部保留
    expect(text).toContain("已丢弃"); // 中间丢弃标记
    expect(text.endsWith("\n")).toBe(true);
    // 尾部窗口 ≈ 64K：总长有界
    expect(text.length).toBeLessThan(4 * 1024 + 64 * 1024 + 200);
  });

  it("单行超整个尾部窗口时保留行尾（错误信息在末尾）", () => {
    const buf = createBoundedLineBuffer({ headLimit: 0, tailLimit: 1000 });
    buf.push("B".repeat(5000) + "\n");
    const text = buf.text();
    // 有效载荷 ≤ 1000（text 里另有「已丢弃 N 字节」标记行）
    expect(text.match(/B/g)?.length ?? 0).toBeLessThanOrEqual(1000);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("已丢弃");
  });

  it("未超限时原文完整（golden 646 字节场景）", () => {
    const buf = createBoundedLineBuffer();
    buf.push(golden.stdoutRaw);
    expect(buf.text()).toBe(golden.stdoutRaw);
    expect(buf.tail(10)).toBe(golden.stdoutRaw.slice(-10));
  });
});
