// [perf] RecordStore per-file 缓存 + light 列表扫描的行为测试。
//
// 覆盖（方案 A + B）：
//   A1. stat 命中 → 零文件读取（去掉读权限仍返回记录，证明只 stat 不 read）
//   A2. jsonl 内容变化 → 单文件重建（状态翻转，其余文件不受影响）
//   A3. sidecar 变化（.finalized → .cancelled）→ 状态翻转
//   A4. 删除文件 → 从结果与缓存中移除
//   B1. collectRecords 返回 light（无 eventLog/result/turns）
//   B2. getFullRecord 懒加载全量（result/turns/tokens/eventLog）且缓存
//   B3. identity-only 文件（无 assistant）→ 分支 4 running 呈现（v4 B-1 可续聊语义）
//   B4. getFullRecord 内存源优先（register 后直接投影全量）
//
// 「去读权限」验证法：chmod 000 后 statSync 仍可用、readFileSync/openSync 失败——
// 若实现退化回读文件，记录会消失（readIdentityHeader 捕获异常返回 undefined）。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecordStore } from "../execution/record-store";
import type { ExecutionRecord } from "../execution/types";

describe("RecordStore per-file cache + light scan [perf]", () => {
  let sessionsDir: string;
  let store: RecordStore;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-cache-"));
    store = new RecordStore(sessionsDir);
  });

  afterEach(() => {
    // 恢复权限以防 tmp 清理失败（chmod 000 用例会留下不可读文件）
    for (const f of fs.readdirSync(sessionsDir)) {
      try { fs.chmodSync(path.join(sessionsDir, f), 0o644); } catch { /* best-effort */ }
    }
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  /** 构造一个 session.jsonl（header + identity + N 条 assistant message）+ 可选 sidecar。 */
  function writeSession(opts: {
    name: string;
    id: string;
    agent?: string;
    startedAt?: number;
    rootSessionId?: string;
    assistantTexts?: string[];
    finalized?: boolean;
    cancelled?: boolean;
  }): string {
    const file = path.join(sessionsDir, opts.name);
    const lines: unknown[] = [
      { type: "session", id: "sess" },
      {
        type: "custom",
        customType: "subagent-identity",
        data: {
          id: opts.id,
          agent: opts.agent ?? "worker",
          mode: "background",
          task: "test task",
          slug: "test",
          startedAt: opts.startedAt ?? 1000,
          rootSessionId: opts.rootSessionId ?? "root-1",
          depth: 0,
        },
      },
    ];
    for (const text of opts.assistantTexts ?? []) {
      lines.push({
        type: "message",
        timestamp: "2026-08-14T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          usage: { input: 10, output: 5 },
          stopReason: "stop",
          timestamp: 2000,
        },
      });
    }
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (opts.finalized) fs.writeFileSync(`${file}.finalized`, "");
    if (opts.cancelled) {
      fs.writeFileSync(
        `${file}.cancelled`,
        JSON.stringify({ id: opts.id, status: "cancelled", agent: "worker", startedAt: 1000, endedAt: 3000 }) + "\n",
      );
    }
    return file;
  }

  it("A1: 缓存命中零文件读取——chmod 000 后记录仍在", () => {
    const f1 = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"], finalized: true });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"], finalized: true });

    const first = store.collectRecords(100, "all", "root-1");
    expect(first).toHaveLength(2);

    // 去读权限：若二次扫描退化回读文件，readIdentityHeader 会失败 → 记录消失。
    fs.chmodSync(f1, 0o000);
    const second = store.collectRecords(100, "all", "root-1");
    expect(second.map((r) => r.id).sort()).toEqual(["sa-1", "sa-2"]);
    fs.chmodSync(f1, 0o644);
  });

  it("A2: jsonl 变化触发单文件重建——append + finalize 后状态翻转", () => {
    const fA = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"] }); // 无 sidecar → running
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"] });

    expect(store.collectRecords(100, "all", "root-1").every((r) => r.status === "running")).toBe(true);

    // 文件 A 追加一条 assistant + 写 .finalized（模拟真实 finalize）
    fs.appendFileSync(
      fA,
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-14T00:01:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "more" }], usage: { input: 1, output: 1 }, stopReason: "stop", timestamp: 2500 },
      }) + "\n",
    );
    fs.writeFileSync(`${fA}.finalized`, "");

    const records = store.collectRecords(100, "all", "root-1");
    const a = records.find((r) => r.id === "sa-1");
    const b = records.find((r) => r.id === "sa-2");
    expect(a?.status).toBe("closed");
    expect(a?.closedReason).toBe("gc");
    expect(a?.endedAt).toBeGreaterThan(0); // light 分支 2 用 jsonl mtime 近似
    expect(b?.status).toBe("running"); // 未变文件不受影响
  });

  it("A3: sidecar 变化触发状态翻转——.finalized 换 .cancelled", () => {
    const f = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"], finalized: true });
    expect(store.collectRecords(100, "all", "root-1")[0].closedReason).toBe("gc");

    fs.rmSync(`${f}.finalized`);
    fs.writeFileSync(
      `${f}.cancelled`,
      JSON.stringify({ id: "sa-1", status: "cancelled", agent: "worker", startedAt: 1000, endedAt: 3000 }) + "\n",
    );

    const rec = store.collectRecords(100, "all", "root-1")[0];
    expect(rec.status).toBe("closed");
    expect(rec.closedReason).toBe("cancelled");
    expect(rec.error).toBe("cancelled by user");
    expect(rec.endedAt).toBe(3000);
  });

  it("A4: 删除文件后从结果中移除", () => {
    const f = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"], finalized: true });
    writeSession({ name: "b.jsonl", id: "sa-2", assistantTexts: ["r2"], finalized: true });
    expect(store.collectRecords(100, "all", "root-1")).toHaveLength(2);

    fs.rmSync(f);
    fs.rmSync(`${f}.finalized`);
    const records = store.collectRecords(100, "all", "root-1");
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("sa-2");
    // 缓存索引同步修剪：已删 id 的 full 查询 miss
    expect(store.getFullRecord("sa-1")).toBeUndefined();
  });

  it("B1: 列表返回 light——不含 result/eventLog/turns", () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["SECRET-RESULT"], finalized: true });

    const light = store.collectRecords(100, "all", "root-1")[0];
    expect(light.id).toBe("sa-1");
    expect(light.status).toBe("closed");
    expect(light.result).toBeUndefined();
    expect(light.eventLog).toEqual([]);
    expect(light.displayItems).toEqual([]);
    expect(light.turns).toBe(0);
    expect(light.totalTokens).toBe(0);
  });

  it("B2: getFullRecord 懒加载全量并缓存（chmod 000 后仍返回）", () => {
    const f = writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["SECRET-RESULT"], finalized: true });
    store.collectRecords(100, "all", "root-1"); // 建立轻量缓存

    const full = store.getFullRecord("sa-1");
    expect(full).toBeDefined();
    expect(full?.result).toContain("SECRET-RESULT");
    expect(full?.turns).toBe(1);
    expect(full?.totalTokens).toBe(15); // input 10 + output 5
    expect(full?.eventLog.length).toBeGreaterThan(0); // turn_end 派生事件
    expect(full?.displayItems.length).toBeGreaterThan(0);
    expect(full?.status).toBe("closed"); // 状态矩阵同样套用

    // 已缓存：去掉读权限再取，仍返回全量（不重读文件）
    fs.chmodSync(f, 0o000);
    const again = store.getFullRecord("sa-1");
    expect(again?.result).toContain("SECRET-RESULT");

    // 不存在的 id
    expect(store.getFullRecord("sa-missing")).toBeUndefined();
  });

  it("B3: identity-only 文件（无 assistant）按分支 4 running 呈现", () => {
    // v4 B-1 可续聊语义：pi 延迟写入下这类文件几乎不存在（首个 assistant 才 flush），
    // 若存在（崩溃前 flush）应可见为 running 而非静默消失。getFullRecord 回退 light。
    writeSession({ name: "a.jsonl", id: "sa-1" }); // 无 assistantTexts
    const rec = store.collectRecords(100, "all", "root-1")[0];
    expect(rec.id).toBe("sa-1");
    expect(rec.status).toBe("running");
    expect(rec.endedAt).toBeUndefined();

    const full = store.getFullRecord("sa-1");
    expect(full).toBeDefined();
    expect(full?.status).toBe("running"); // 哨兵回退 light，不重试全文解析
  });

  it("B5: 续聊场景 identity 在尾部——尾部定位 + 负缓存回归防护", () => {
    // 续聊（resume）场景：session_start 再次触发，identity append 到文件尾部附近。
    // 真实目录实测 ~65% 文件的 identity 不在头 64KB 而在尾 64KB（本用例复现该形态）。
    const file = path.join(sessionsDir, "resume.jsonl");
    const head = [
      JSON.stringify({ type: "session", id: "sess" }),
      // 首轮内容（无 identity——模拟崩溃后重启续聊的身份补写形态）：大体积填充
      // 把 identity 推出头部 64KB 窗口。
      JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(70000), timestamp: 1000 } }),
    ];
    const tail = [
      {
        type: "custom",
        customType: "subagent-identity",
        data: { id: "sa-tail", agent: "worker", mode: "background", task: "resumed", slug: "tail", startedAt: 1000, rootSessionId: "root-1", depth: 0 },
      },
      {
        type: "message",
        timestamp: "2026-08-14T00:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "after resume" }], usage: { input: 1, output: 2 }, stopReason: "stop", timestamp: 2000 },
      },
    ];
    fs.writeFileSync(file, [...head, ...tail.map((l) => JSON.stringify(l))].join("\n") + "\n");

    const rec = store.collectRecords(100, "all", "root-1").find((r) => r.id === "sa-tail");
    expect(rec).toBeDefined();
    expect(rec?.task).toBe("resumed");
    const full = store.getFullRecord("sa-tail");
    expect(full?.result).toBe("after resume");

    // 负缓存：无 identity 的 jsonl 不应每轮重读（写入后重复扫描结果稳定）
    const junk = path.join(sessionsDir, "junk.jsonl");
    fs.writeFileSync(junk, JSON.stringify({ type: "session", id: "sess2" }) + "\n");
    const ids = store.collectRecords(100, "all", "root-1").map((r) => r.id);
    expect(ids).not.toContain("junk");
    expect(store.collectRecords(100, "all", "root-1").map((r) => r.id)).toEqual(ids); // 负缓存稳定
  });

  it("B4: getFullRecord 内存源优先——register 后直接投影全量", () => {
    writeSession({ name: "a.jsonl", id: "sa-1", assistantTexts: ["r1"], finalized: true });
    store.collectRecords(100, "all", "root-1");

    // register 一个同 id 内存 running record（模拟跨重启恢复/续聊）
    const mem = {
      id: "sa-1",
      agent: "worker",
      slug: "test",
      status: "running",
      mode: "background",
      startedAt: 1000,
      rootSessionId: "root-1",
      parentRecordId: undefined,
      depth: 0,
      endedAt: undefined,
      turnCount: 7,
      turns: [],
      totalTokens: 42,
      model: "m/x",
      thinkingLevel: undefined,
      task: "test task",
      eventLog: [],
      displayItems: [],
      result: "live result",
      error: undefined,
      sessionFile: path.join(sessionsDir, "a.jsonl"),
    } as unknown as ExecutionRecord;
    store.register(mem);

    const full = store.getFullRecord("sa-1");
    expect(full?.status).toBe("running"); // 内存 running 覆盖磁盘 closed
    expect(full?.result).toBe("live result");
    expect(full?.turns).toBe(7);
  });
});
