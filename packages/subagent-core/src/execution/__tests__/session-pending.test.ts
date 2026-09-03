// src/execution/__tests__/session-pending.test.ts
//
// readActivePendingFromSessionFile：读 session 文件算活跃后代（pending 差集）。
// 覆盖：差集、快速路径过滤、文件不存在/坏行/未回填 sessionFile。
// u-5c 迁自壳套件 src/__tests__/session-pending.test.ts（被测 module 是 core 件，
// 唯一测试覆盖原落壳——设计 §2.2 C6 / §1 目标 6）。
//
// 迁移改写：原壳版注入真实 @zhushanwen/pi-pending-notifications 计数器锚定差集
// 语义；core 依赖闭包禁 pi 系包（u-5c 验收「零跨包 specifier」），改为下方
// countActiveFromEntries 等价转写（逐字对照 extensions/universal/
// pending-notifications/src/state.ts 同名实现的两遍差集算法：先收 unregister id
// 集，再计 register 差集按 id 去重）——pi 侧算法自身由该包自有测试守卫。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureNotifyDomain, resetNotifyDomainForTests } from "../../core/notify-ports.ts";

import { readActivePendingFromSessionFile, clearPendingCursors } from "../session-pending.ts";

/** pi pending entries 的最小可识别形状（与 pi state.ts EntryLike 同构，运行时守卫）。 */
interface PendingEntryLike {
  customType?: unknown;
  data?: { id?: unknown } | null;
}

/**
 * countActiveFromEntries 等价转写（u-5c：core 闭包禁 pi 包 import）。
 * 算法逐字对照 @zhushanwen/pi-pending-notifications src/state.ts：
 * 两遍扫描——第一遍收 pending:unregister 的 id 集，第二遍计 pending:register
 * 中未被注销且未见过的 id（按 id 去重）。返回 { count }（端口契约拆 .count
 * 的上游形态）。
 */
function countActiveFromEntries(entries: unknown[]): { count: number } {
  const unregistered = new Set<string>();
  for (const raw of entries) {
    // S-10：entries 元素可能是 null/undefined（坏数据），断言前先守卫
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as PendingEntryLike;
    if (entry.customType !== "pending:unregister") continue;
    const data = (entry.data ?? {}) as { id?: unknown };
    if (typeof data.id === "string") unregistered.add(data.id);
  }

  const seen = new Set<string>();
  let count = 0;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as PendingEntryLike;
    if (entry.customType !== "pending:register") continue;
    const data = (entry.data ?? {}) as { id?: unknown };
    if (typeof data.id !== "string" || unregistered.has(data.id) || seen.has(data.id)) continue;
    seen.add(data.id);
    count += 1;
  }
  return { count };
}

// 计数器经通知域窄端口注入（session-pending 不再直接 import pi-pending-notifications）
// ——注入差集计数等价实现保住差集语义回归面（真函数返回 CountActiveResult，端口
// 契约是 number（拆 .count，与 pi 壳 createPiNotifyDomainPorts 适配同构）；
// afterEach 重置防注入态泄漏。
beforeEach(() => {
  configureNotifyDomain({
    countActiveFromEntries: (entries) => countActiveFromEntries(entries).count,
  });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

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

// [perf] 增量游标行为：同文件重复判定（层主被多个后代唤醒 N 次 → N 次 agent_end）
// 只读上次 offset 之后的新增行，累计差集语义与全量读一致。
describe("readActivePendingFromSessionFile — 增量游标 [perf]", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-pending-incr-"));
    file = path.join(dir, "session.jsonl");
    clearPendingCursors();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("首次全量 + append 后增量：unregister 只抵消对应 id（与全量读一致）", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n" + mkRegister("d2") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);

    fs.appendFileSync(file, mkUnregister("d1", "completed") + "\n");
    const r = readActivePendingFromSessionFile(file);
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1);
  });

  it("EOF 半行（append 竞态）不入账，补全换行后入账", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(1);

    // 半行：无尾换行 → offset 不推进该行
    const full = mkUnregister("d1", "completed", new Date().toISOString());
    fs.appendFileSync(file, full.slice(0, full.length - 4));
    expect(readActivePendingFromSessionFile(file).count).toBe(1);

    // 补全（剩余字符 + 换行）→ 消费
    fs.appendFileSync(file, full.slice(-4) + "\n");
    const r = readActivePendingFromSessionFile(file);
    expect(r.count).toBe(0);
    expect(r.recentUnregister).toBe(true);
  });

  it("文件 truncate/重建（size 回退）→ 重置游标从头全读", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n" + mkRegister("d2") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);

    fs.writeFileSync(file, mkRegister("d3") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(1);
  });

  it("clearPendingCursors 后重新全量（累计 entries 不残留旧账）", () => {
    fs.writeFileSync(file, mkRegister("d1") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(1);
    clearPendingCursors();
    fs.appendFileSync(file, mkRegister("d2") + "\n");
    expect(readActivePendingFromSessionFile(file).count).toBe(2);
  });
});
