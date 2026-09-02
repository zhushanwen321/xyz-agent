// src/execution/__tests__/session-pending.test.ts
//
// [LC-6/T6②] session-pending 增量游标有界化：register−unregister 差集计数 + 剪枝。
//
// 覆盖：
//   - 差集等值（语义不变）：register/unregister 差集、同 id 重 register 覆盖、
//     unregister 后同 id 再 register 恢复活跃、count 端口收到的 = 活跃差集、
//     latestUnregister 60s 唤醒窗口判据不受差集化影响。
//   - 剪枝：文件删除后 cursor 自动剪枝（重建同名文件从头全量读，不残留旧 offset）；
//     prunePendingCursor 原语（进程 close 侧回收）；prune 不存在条目 no-op。
//
// 真实 fs（临时目录）——增量游标的 offset/差集语义被真实文件形态执行
//（对齐 descendant-sweep.test.ts 模式；该文件的差集清单/交错用例继续回归）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureNotifyDomain, resetNotifyDomainForTests } from "../../core/notify-ports.ts";
import {
  clearPendingCursors,
  listActivePendingFromSessionFile,
  prunePendingCursor,
  readActivePendingFromSessionFile,
} from "../session-pending.ts";

let sessionDir = "";

beforeEach(() => {
  clearPendingCursors();
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-pending-"));
});

afterEach(() => {
  clearPendingCursors();
  resetNotifyDomainForTests();
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function entryLine(customType: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: "custom",
    customType,
    data,
    timestamp: "2026-09-01T00:00:00.000Z",
    id: `e-${Math.random().toString(36).slice(2)}`,
  })}\n`;
}

function registerData(id: string, sessionId: string): Record<string, unknown> {
  return { id, type: "session", name: `desc-${id}`, status: "active", registeredAt: 1, expiresAt: undefined, sessionId };
}

/** 注入直数端口：返回收到的 entry 数（观察 count 口径的消费面）。 */
function stubCountingPort(): (entries: unknown[]) => number {
  const counter = vi.fn((entries: unknown[]) => entries.length);
  configureNotifyDomain({ countActiveFromEntries: counter });
  return counter;
}

describe("[LC-6] 差集计数语义等值", () => {
  it("register−unregister 差集：unregister 后 count/list 归零", () => {
    const counter = stubCountingPort();
    const f = path.join(sessionDir, "a.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:register", registerData("bg-2", "sess-2")) +
        entryLine("pending:unregister", { id: "bg-1" }),
    );

    const r = readActivePendingFromSessionFile(f);
    expect(r.error).toBeUndefined();
    expect(r.count).toBe(1); // 2 register − 1 unregister
    expect(counter.mock.calls[0]?.[0]).toHaveLength(1); // 端口收到差集（非全量 3 行）
    expect((counter.mock.calls[0]?.[0] as unknown[])[0]).toMatchObject({ customType: "pending:register" });

    const list = listActivePendingFromSessionFile(f);
    expect(list.items.map((i) => i.id)).toEqual(["bg-2"]);
  });

  it("同 id 重 register（未 unregister）覆盖 → 仍 1 个活跃", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "b.jsonl");
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    fs.appendFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1-moved")));

    const list = listActivePendingFromSessionFile(f);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.sessionId).toBe("sess-1-moved");
  });

  it("unregister 后同 id 再 register → 恢复活跃", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "c.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:unregister", { id: "bg-1" }) +
        entryLine("pending:register", registerData("bg-1", "sess-2")),
    );

    const list = listActivePendingFromSessionFile(f);
    expect(list.items.map((i) => i.id)).toEqual(["bg-1"]);
    expect(list.items[0]?.sessionId).toBe("sess-2");
    expect(readActivePendingFromSessionFile(f).count).toBe(1);
  });

  it("latestUnregister 60s 唤醒窗口判据不受差集化影响", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "d.jsonl");
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        JSON.stringify({
          type: "custom",
          customType: "pending:unregister",
          data: { id: "bg-1" },
          timestamp: nowIso,
          id: "e-unreg",
        }) +
        "\n",
    );

    const r = readActivePendingFromSessionFile(f);
    expect(r.count).toBe(0); // 差集归零
    expect(r.recentUnregister).toBe(true); // unregister 时刻仍被游标记录（唤醒窗口语义保持）
  });

  it("缺 data.id 的畸形 pending 行丢弃，不影响其余差集", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "e.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", {}) + // 畸形：无 id
        entryLine("pending:register", registerData("bg-2", "sess-2")),
    );

    const list = listActivePendingFromSessionFile(f);
    expect(list.items.map((i) => i.id)).toEqual(["bg-2"]);
  });
});

describe("[LC-6] 游标剪枝", () => {
  it("文件删除后 cursor 自动剪枝：重建同名文件从头全量读（不残留旧 offset）", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "reborn.jsonl");
    // 第一代：15 字节/行 × 10 行 filler → cursor offset = 150
    const gen1 = Array.from({ length: 10 }, (_, i) => `filler-line-${String(i).padStart(2, "0")}\n`).join("");
    fs.writeFileSync(f, gen1);
    expect(readActivePendingFromSessionFile(f).count).toBe(0);

    // 删除后的一次判定触发剪枝（stat ENOENT → cursors.delete，惰性剪枝语义）。
    fs.unlinkSync(f);
    const duringAbsent = readActivePendingFromSessionFile(f);
    expect(duringAbsent.error).toBeDefined();

    // 重建同名文件：新内容 size > 旧 offset（150），bg-x 的 register 行落在旧 offset
    // 之内——cursor 未剪枝时会从 byte 150 续读漏掉它。
    const gen2 =
      entryLine("pending:register", registerData("bg-x", "sess-x")) +
      "filler".padEnd(200, ".") +
      "\n";
    expect(Buffer.byteLength(gen2, "utf-8")).toBeGreaterThan(150);
    fs.writeFileSync(f, gen2);

    const list = listActivePendingFromSessionFile(f);
    expect(list.items.map((i) => i.id)).toEqual(["bg-x"]); // 剪枝生效：从头全量读
  });

  it("prunePendingCursor：回收后重新判定等值（全量重读差集不变）", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "pruned.jsonl");
    fs.writeFileSync(
      f,
      entryLine("pending:register", registerData("bg-1", "sess-1")) +
        entryLine("pending:register", registerData("bg-2", "sess-2")),
    );
    expect(readActivePendingFromSessionFile(f).count).toBe(2);

    prunePendingCursor(f); // 进程 close 侧回收

    fs.appendFileSync(f, entryLine("pending:unregister", { id: "bg-1" }));
    const r = readActivePendingFromSessionFile(f);
    expect(r.count).toBe(1); // 重建后差集正确（无重复无丢失）
    expect(listActivePendingFromSessionFile(f).items.map((i) => i.id)).toEqual(["bg-2"]);
  });

  it("prunePendingCursor：prune 后覆写文件（size ≥ 旧 offset）→ 新内容完整可见", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "overwritten.jsonl");
    const gen1 = Array.from({ length: 10 }, (_, i) => `filler-line-${String(i).padStart(2, "0")}\n`).join("");
    fs.writeFileSync(f, gen1);
    readActivePendingFromSessionFile(f); // offset = 160

    const gen2 =
      entryLine("pending:register", registerData("bg-y", "sess-y")) +
      "filler".padEnd(200, ".") +
      "\n";
    fs.writeFileSync(f, gen2); // 覆写（模拟文件替换），size > 旧 offset
    prunePendingCursor(f);

    expect(listActivePendingFromSessionFile(f).items.map((i) => i.id)).toEqual(["bg-y"]);
  });

  it("prunePendingCursor 不存在的条目为 no-op（不抛错）", () => {
    expect(() => prunePendingCursor(path.join(sessionDir, "never-seen.jsonl"))).not.toThrow();
  });

  it("读失败（文件不存在）→ error 面返回且 cursor 已剪（后续可全量重建）", () => {
    stubCountingPort();
    const f = path.join(sessionDir, "vanish.jsonl");
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    expect(readActivePendingFromSessionFile(f).count).toBe(1);

    fs.unlinkSync(f);
    const r = readActivePendingFromSessionFile(f); // 剪枝触发点（stat ENOENT）
    expect(r.error).toBeDefined();
    expect(r.count).toBe(0);

    // 重建后从文件头判定（无 offset 残留），条目完整恢复
    fs.writeFileSync(f, entryLine("pending:register", registerData("bg-1", "sess-1")));
    expect(readActivePendingFromSessionFile(f).count).toBe(1);
  });
});
