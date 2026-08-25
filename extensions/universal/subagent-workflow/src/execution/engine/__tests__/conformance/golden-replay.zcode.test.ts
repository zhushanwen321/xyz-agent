// golden-replay.zcode.test.ts —— zcode 引擎 golden 回放层（conformance 免 LLM 默认 CI
// 层）。数据源 = P3 验收前置门的真机实录（engines/zcode/__tests__/__fixtures__/
// zcode-golden-spawn.json 的 stdoutRaw）——parser 对实录样本回归 + coarse 事件合成
// 不变量断言 + 双副本 diff 校验（fixture 与 golden-sample.ts 内嵌副本一致，防漂移：
// 更新样本必须同步两处，探针的干跑校验消费内嵌副本，两处不一致 = 探针在测旧契约）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ZCODE_GOLDEN_STDOUT } from "../../engines/zcode/golden-sample.ts";
import {
  mapZcodeOutcomeUsage,
  parseZcodeTerminal,
  synthesizeCoarseEvents,
} from "../../engines/zcode/parser.ts";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

// conformance 目录（engine/__tests__/conformance）→ engine 根的相对定位
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", // conformance → __tests__ → engine
  "engines", "zcode", "__tests__", "__fixtures__", "zcode-golden-spawn.json",
);

interface ZcodeGoldenFile {
  _meta: { engineVersion: string; exitCode: number };
  stdoutRaw: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ZcodeGoldenFile;

describe("zcode golden 回放（conformance C3，免 LLM/免二进制）", () => {
  it("双副本 diff：golden-sample.ts 内嵌副本 === fixture stdoutRaw（防漂移，A12）", () => {
    expect(ZCODE_GOLDEN_STDOUT).toBe(fixture.stdoutRaw);
  });

  it("parser 对实录样本回归：sessionId/response/usage 形状完整（探针干跑同源断言）", () => {
    const terminal = parseZcodeTerminal(fixture.stdoutRaw);
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) return;
    expect(terminal.payload.sessionId).toMatch(/^sess_/);
    expect(terminal.payload.response).toBe("ok");
    expect(terminal.payload.usage).toEqual({ input: 12599, output: 17, cacheRead: 512, cacheWrite: 0 });
    // 终态层 usage（orchestration 版）：cost 显式 0（无来源不给残缺）、contextTokens 取 projection
    expect(terminal.payload.outcomeUsage).toEqual({
      input: 12599,
      output: 17,
      cacheRead: 512,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 12616,
      turns: 1,
    });
  });

  it("coarse 事件合成满足产出不变量（turn_end 最后、其前必有 message_end、usage 完整）", () => {
    const terminal = parseZcodeTerminal(fixture.stdoutRaw);
    if (!terminal.ok) throw new Error("golden 样本解析失败（上一用例应已转红）");
    const events = synthesizeCoarseEvents(terminal.payload.response, terminal.payload.usage);
    assertAgentEventInvariants(events, { granularity: "coarse" });
    expect(events.map((e) => e.type)).toEqual(["message_end", "turn_end"]);
  });

  it("usage 无来源样本：mapZcodeOutcomeUsage 显式缺省（不给残缺对象，不变量 2 的输入面）", () => {
    expect(mapZcodeOutcomeUsage(undefined, undefined)).toBeUndefined();
    expect(mapZcodeOutcomeUsage({ inputTokens: 1 }, undefined)).toEqual({
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    });
  });
});
