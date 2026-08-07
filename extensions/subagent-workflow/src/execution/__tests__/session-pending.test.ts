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

const mkUnregister = (id: string, reason = "completed", ts = "2026-08-06T08:00:00.000Z") =>
  JSON.stringify({ type: "custom", customType: "pending:unregister", data: { id, reason }, timestamp: ts });

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
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: false });
  });

  it("纯 register → count = 活跃后代数", () => {
    const file = makeTmpSessionFile([mkRegister("bg-1"), mkRegister("bg-2", "workflow")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 2, recentUnregister: false });
  });

  it("register + unregister 同 id → 差集抵消", () => {
    const file = makeTmpSessionFile([mkRegister("bg-1"), mkUnregister("bg-1")]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: false });
  });

  it("混合：部分注销 → 只统计仍活跃的（真实 e2e 场景：P 的 agent_end 时 explorer 未注销）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-1"),
      mkUnregister("bg-1", "completed"),
      mkRegister("explorer-1"),
      mkMessage("assistant", "waiting for explorer..."),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });

  it("fork 继承的主 session register 已被 expired unregister 抵消 → 不干扰", () => {
    // 模拟 P fork 主 session：继承 register（sessionId 不匹配），session_start 重建补 unregister(expired)
    const file = makeTmpSessionFile([
      mkRegister("parent-bg"),
      mkUnregister("parent-bg", "expired"),
      mkRegister("my-bg"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });

  it("坏行（截断 JSON）跳过，不影响其余判定", () => {
    const file = makeTmpSessionFile([
      '{"type":"custom","customType":"pending:register","data":{"id":"bg-1"',
      mkRegister("bg-2"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
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

  it("最近 60s 内有 unregister → recentUnregister=true（后代刚完成，唤醒在路上——竞态窗口不 kill）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-live"),
      mkUnregister("bg-live", "completed", new Date().toISOString()),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: true });
  });

  it("unregister 在 60s 窗口外 → recentUnregister=false（正常 kill 路径）", () => {
    const file = makeTmpSessionFile([
      mkRegister("bg-live"),
      mkUnregister("bg-live", "completed", "2020-01-01T00:00:00.000Z"),
    ]);
    tmpFiles.push(file);
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 0, recentUnregister: false });
  });

  // [S-4] fast-path 按值匹配而非序列化格式。旧行 `line.includes('"customType":"pending:')`
  // 耦合 pi 的 JSON 序列化空格习惯（冒号后无空格）。若 pi 改序列化（单行内冒号后加空格），
  // 旧实现全过滤 → count=0 → keep-alive 静默失效 → recursive tree 被杀、steer 丢失。
  // 本用例构造冒号后带空格的单行 JSON，验证值匹配仍命中 + 解析正确。
  it("S-4: 序列化冒号后带空格 → 仍正确解析（防 fast-path 格式耦合导致 keep-alive 静默失效）", () => {
    const file = makeTmpSessionFile([
      `{ "type": "message", "message": { "role": "user", "content": [] } }`,
      `{ "type": "custom", "customType": "pending:register", "data": { "id": "bg-1", "type": "subagent", "name": "bg-1" } }`,
      `{ "type": "custom", "customType": "pending:unregister", "data": { "id": "bg-1", "reason": "completed" }, "timestamp": "2020-01-01T00:00:00.000Z" }`,
      `{ "type": "custom", "customType": "pending:register", "data": { "id": "bg-2", "type": "subagent", "name": "bg-2" } }`,
    ]);
    tmpFiles.push(file);
    // bg-1 register+unregister 抵消，bg-2 仍活跃 → count=1。
    // 旧 fast-path（`"customType":"pending:` 冒号无空格）会跳过所有行 → count=0（静默失效）。
    expect(readActivePendingFromSessionFile(file)).toEqual({ count: 1, recentUnregister: false });
  });
});
