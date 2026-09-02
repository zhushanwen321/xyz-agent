// golden-replay.zcode.test.ts —— zcode 引擎 golden 回放层（conformance 免 LLM 默认 CI
// 层）。数据源 = P3 验收前置门的真机实录（engines/zcode/__tests__/__fixtures__/
// zcode-golden-spawn.json 的 stdoutRaw）——parser 对实录样本回归 + coarse 事件合成
// 不变量断言 + 双副本 diff 校验（fixture 与 golden-sample.ts 内嵌副本一致，防漂移：
// 更新样本必须同步两处，探针的干跑校验消费内嵌副本，两处不一致 = 探针在测旧契约）。
//
// [R6] 双语料并存：① spawn stdout（上方，spawn 降级路径 + probe 干跑的回归语料——
// 生产消费方存在故保留，去留决策见 impl-plan R6 偏差登记）② app-server 帧序列
// （下方新增，常驻通道主力语料——双副本 diff 自 session-channel 测试接管到 conformance
// 回放层，帧形态不变量在此断言；A8「golden 帧序列语料 diff 通过」的本仓段）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ZCODE_APPSERVER_GOLDEN, ZCODE_GOLDEN_STDOUT } from "../../engines/zcode/golden-sample.ts";
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

// [R6] app-server 帧序列语料 fixture（采集 SSOT——双副本 diff 的另一副本）
const appserverFixturePath = join(dirname(fixturePath), "zcode-golden-appserver.json");
interface AppServerGoldenFile {
  _meta: Record<string, unknown>;
  frames: { createResponse: string; pushStream: string[]; terminal: string[]; readResponse: string };
}
const appserverFixture = JSON.parse(readFileSync(appserverFixturePath, "utf8")) as AppServerGoldenFile;

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

// ============================================================
// [R6] app-server 帧序列语料回放（常驻通道主力语料，conformance 层接管双副本 diff）
// ============================================================

describe("zcode app-server golden 回放（conformance C3 帧形态，免 LLM/免二进制）", () => {
  it("双副本 diff：golden-sample.ts 内嵌副本 === fixture frames（防漂移，A8 本仓段）", () => {
    expect(ZCODE_APPSERVER_GOLDEN.createResponse).toBe(appserverFixture.frames.createResponse);
    expect(ZCODE_APPSERVER_GOLDEN.pushStream).toEqual(appserverFixture.frames.pushStream);
    expect(ZCODE_APPSERVER_GOLDEN.terminal).toEqual(appserverFixture.frames.terminal);
    expect(ZCODE_APPSERVER_GOLDEN.readResponse).toBe(appserverFixture.frames.readResponse);
  });

  it("create 应答形状：权威 sessionId 在 session.sessionId（projection.sessionId 恒 unknown 勿用）", () => {
    const create = JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse) as {
      session: { sessionId: string };
      projection: { sessionId: string };
    };
    expect(create.session.sessionId).toMatch(/^sess_/);
    expect(create.projection.sessionId).toBe("unknown");
  });

  it("推送流帧形态：stream.chunk 无文本（文本在 session/event delta）——文本三源恒等（A8 不变量 1）", () => {
    const pushes = ZCODE_APPSERVER_GOLDEN.pushStream.map((l) => JSON.parse(l) as {
      method: string;
      params?: { kind?: string; payload?: { delta?: string } };
    });
    const chunks = pushes.filter((f) => f.params?.kind === "stream.chunk");
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.params?.payload?.delta).toBeUndefined();

    const deltaJoined = pushes
      .filter((f) => f.method === "session/event" && typeof f.params?.payload?.delta === "string")
      .map((f) => f.params?.payload?.delta)
      .join("");
    const terminal = ZCODE_APPSERVER_GOLDEN.terminal.map((l) => JSON.parse(l) as {
      params?: { kind?: string; payload?: { response?: string; usage?: { inputTokens: number; outputTokens: number } } };
    });
    const closing = terminal.find((f) => f.params?.payload?.response !== undefined);
    expect(closing?.params?.payload?.response).toBe(deltaJoined);

    const read = JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse) as {
      messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>;
    };
    const readText = (read.messages.at(-1)?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    expect(readText).toBe(deltaJoined); // text_delta 拼接 == 收尾帧 == read 全文
  });

  it("终态权威帧：turn.terminal 存在且先于收尾帧；usage 与 spawn golden 同值（漂移对照锚点）", () => {
    const terminal = ZCODE_APPSERVER_GOLDEN.terminal.map((l) => JSON.parse(l) as {
      params?: { kind?: string; status?: string; payload?: { usage?: { inputTokens: number; outputTokens: number } } };
    });
    const terminalFrameIdx = terminal.findIndex((f) => f.params?.kind === "turn.terminal");
    const closingFrameIdx = terminal.findIndex((f) => f.params?.payload?.usage !== undefined);
    expect(terminalFrameIdx).toBeGreaterThanOrEqual(0);
    expect(terminal[terminalFrameIdx]?.params?.status).toBe("success");
    expect(terminalFrameIdx).toBeLessThan(closingFrameIdx);

    const spawnUsage = parseZcodeTerminal(ZCODE_GOLDEN_STDOUT);
    if (!spawnUsage.ok) throw new Error("spawn golden 样本解析失败");
    expect(terminal[closingFrameIdx]?.params?.payload?.usage).toEqual({
      inputTokens: spawnUsage.payload.usage.input,
      outputTokens: spawnUsage.payload.usage.output,
    });
  });
});
