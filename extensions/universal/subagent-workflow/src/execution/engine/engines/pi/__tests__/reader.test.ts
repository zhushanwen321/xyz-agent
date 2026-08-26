// reader.test.ts —— PiEngine reader（P5）：readPiSessionView 对 session-reconstructor
// 的投影包装。断言三件事：①合法 JSONL → SessionView（turns/toolCalls strip 内部态/
// usage 聚合/source='native'）；②reconstructor 降级条件（文件缺失/缺 identity/无
// assistant）→ undefined 不 throw；③不泄漏 InternalToolCall 内部态（_status/startedTs）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { readPiSessionView } from "../reader.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(join(os.tmpdir(), "pi-reader-"));
});

// node:path 的 join 在 ESM 测试里直接用（避免顶部 import 与 beforeAll 顺序问题）
function join(...segs: string[]): string {
  return path.join(...segs);
}

/** 最小合法 subagent JSONL：header + identity + 一轮 assistant（text/thinking/toolCall）+ toolResult。 */
function writeValidSession(file: string): void {
  const lines = [
    JSON.stringify({ type: "session", id: "pi-sess-1", cwd: "/proj", timestamp: "2026-08-25T10:00:00Z" }),
    JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: { id: "bg-1-abc", agent: "reviewer", mode: "background", task: "review code", slug: "rev", startedAt: 1756000000000 },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-25T10:00:01Z",
      message: {
        role: "assistant",
        timestamp: 1756000001000,
        content: [
          { type: "thinking", thinking: "let me look" },
          { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
        ],
        usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.1 } },
        stopReason: "toolUse",
      },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-25T10:00:02Z",
      message: { role: "toolResult", toolCallId: "tc-1", toolName: "bash", content: [{ type: "text", text: "file-a" }], timestamp: 1756000002000 },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-25T10:00:03Z",
      message: {
        role: "assistant",
        timestamp: 1756000003000,
        content: [{ type: "text", text: "all good" }],
        usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
        stopReason: "stop",
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

describe("readPiSessionView", () => {
  it("projects a valid subagent JSONL to a native SessionView", async () => {
    const file = join(tmpDir, "valid.jsonl");
    writeValidSession(file);

    const view = await readPiSessionView(file);

    expect(view).toBeDefined();
    expect(view?.engineId).toBe("pi");
    expect(view?.source).toBe("native");
    // 两轮 assistant message → 两个 turn（toolResult 不产 turn）
    expect(view?.turns).toHaveLength(2);

    const [turn1, turn2] = view?.turns ?? [];
    expect(turn1?.text).toBe("");
    expect(turn1?.thinking).toBe("let me look");
    expect(turn1?.toolCalls).toHaveLength(1);
    const tc = turn1?.toolCalls[0];
    expect(tc?.toolName).toBe("bash");
    expect(tc?.args).toEqual({ command: "ls" });
    expect(tc?.result).toEqual({ content: [{ type: "text", text: "file-a" }] });
    // InternalToolCall 内部态不泄漏（导出纯净形状）
    expect(tc).not.toHaveProperty("_status");
    expect(tc).not.toHaveProperty("startedTs");
    expect(turn1?.closed).toBe(true);

    expect(turn2?.text).toBe("all good");
    expect(turn2?.closed).toBe(true);

    // usage 聚合：两轮 usageDelta 之和（cost 浮点累加有精度噪声，用 toBeCloseTo）
    expect(view?.usage?.input).toBe(30)
    expect(view?.usage?.output).toBe(13)
    expect(view?.usage?.cacheRead).toBe(1)
    expect(view?.usage?.cacheWrite).toBe(2)
    expect(view?.usage?.cost).toBeCloseTo(0.15, 10)
    expect(view?.usage?.total).toBe(46);
  });

  it("returns undefined (no throw) when file is missing", async () => {
    await expect(readPiSessionView(join(tmpDir, "nope.jsonl"))).resolves.toBeUndefined();
  });

  it("returns undefined when identity entry is missing", async () => {
    const file = join(tmpDir, "no-identity.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      })}\n`,
      "utf8",
    );
    await expect(readPiSessionView(file)).resolves.toBeUndefined();
  });

  it("returns undefined when no assistant message exists", async () => {
    const file = join(tmpDir, "no-assistant.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({
        type: "custom",
        customType: "subagent-identity",
        data: { id: "bg-2", agent: "w", mode: "background", task: "t", startedAt: 1 },
      })}\n`,
      "utf8",
    );
    await expect(readPiSessionView(file)).resolves.toBeUndefined();
  });

  it("omits usage when no message carries it", async () => {
    const file = join(tmpDir, "no-usage.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "session", id: "s" })}\n${JSON.stringify({
        type: "custom",
        customType: "subagent-identity",
        data: { id: "bg-3", agent: "w", mode: "background", task: "t", startedAt: 1 },
      })}\n${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 1 },
      })}\n`,
      "utf8",
    );
    const view = await readPiSessionView(file);
    expect(view?.turns).toHaveLength(1);
    expect(view?.usage).toBeUndefined();
  });
});
