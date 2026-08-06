// src/execution/__tests__/session-pending.test.ts
//
// readActivePendingFromSessionFile：读 session 文件算活跃后代（pending 差集）。
// 覆盖：差集、快速路径过滤、文件不存在/坏行/未回填 sessionFile。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readActivePendingFromSessionFile } from "../session-pending.ts";

function makeTmpSessionFile(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-pending-test-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const mkRegister = (id: string, type: "subagent" | "workflow" = "subagent") =>
  JSON.stringify({ type: "custom", customType: "pending:register", data: { id, type, name: id } });

const mkUnregister = (id: string, reason = "completed") =>
  JSON.stringify({ type: "custom", customType: "pending:unregister", data: { id, reason } });

const mkMessage = (role: string, text: string) =>
  JSON.stringify({ type: "message", id: `m-${Date.now()}-${Math.random()}`, message: { role, content: [{ type: "text", text }] } });

describe("readActivePendingFromSessionFile", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        // 清理失败不影响断言
      }
    }
  });

  it("无 pending entries → count 0", () => {
    const file = makeTmpSessionFile([mkMessage("user", "hi"), mkMessage("assistant", "hello")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0 });
  });

  it("纯 register → count = 活跃后代数", () => {
    const file = makeTmpSessionFile([mkRegister("bg-1"), mkRegister("bg-2", "workflow")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 2 });
  });

  it("register + unregister 同 id → 差集抵消", () => {
    const file = makeTmpSessionFile([mkRegister("bg-1"), mkUnregister("bg-1")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0 });
  });

  it("混合：部分注销 → 只统计仍活跃的（真实 e2e 场景：P 的 agent_end 时 explorer 未注销）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-1"),
      mkUnregister("bg-1", "completed"),
      mkRegister("explorer-1"),
      mkMessage("assistant", "waiting for explorer..."),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1 });
  });

  it("fork 继承的主 session register 已被 expired unregister 抵消 → 不干扰", () => {
    // 模拟 P fork 主 session：继承 register（sessionId 不匹配），session_start 重建补 unregister(expired)
    const file = makeTmpSessionFile([
      mkRegister("parent-bg"),
      mkUnregister("parent-bg", "expired"),
      mkRegister("my-bg"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1 });
  });

  it("坏行（截断 JSON）跳过，不影响其余判定", () => {
    const file = makeTmpSessionFile([
      '{"type":"custom","customType":"pending:register","data":{"id":"bg-1"',
      mkRegister("bg-2"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1 });
  });

  it("sessionFile 未回填（undefined）→ error（调用方保守不 kill）", () => {
    const res = readActivePendingFromSessionFile(undefined);
    expect(res.count).toBe(0);
    expect(res.error).toBeDefined();
  });

  it("文件不存在 → error（调用方保守不 kill）", () => {
    const res = readActivePendingFromSessionFile("/nonexistent/path/session.jsonl");
    expect(res.count).toBe(0);
    expect(res.error).toBeDefined();
  });
});
