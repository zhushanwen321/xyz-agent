/**
 * readLastJsonlLine 孤儿终态判定用例（W2 移交 CRAP 43.1；私有函数，经公共 API
 * RecordStore.recoverOrphanRecords 驱动——appendEntry 捕获判定结果）。
 *
 * [HISTORICAL] 回归锚点（record-store.ts 窗口扩容注释 / V1 探针）：真实库存在
 * 28 个末行 65KB-776KB 的完整 entry（subagent-identity 的 task 内嵌大 payload）。
 * 旧实现固定 64KB 尾窗把超长末行从中间切开 → JSON.parse 失败 → 误判「截断」→
 * 孤儿恢复错落 error。本文件的 300KB 完整末行用例在旧实现上会红。
 *
 * 判定矩阵（finalizeOrphanRecord）：
 *   - 末行完整 JSON（含超长行）→ closed/gc 且无 error
 *   - 末行截断（无尾换行的半行 JSON）→ closed/gc + error "truncated last line"
 *   - 超长且截断的组合 → 仍按截断判 error（不因行长放宽）
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManifestStore } from "../execution/manifest-store";
import { RecordStore } from "../execution/record-store";

interface CapturedEntry {
  type: string;
  data: Record<string, unknown>;
}

function makePiHook() {
  const entries: CapturedEntry[] = [];
  return {
    entries,
    pi: { appendEntry: vi.fn((type: string, entry: unknown) => { entries.push({ type, data: entry as Record<string, unknown> }); }) },
  };
}

describe("readLastJsonlLine 孤儿终态判定（超长末行 / 截断行）", () => {
  let rootDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lastline-"));
    sessionsDir = path.join(rootDir, "sessions");
    fs.mkdirSync(sessionsDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写一个会被重建为 running 孤儿的子 session 文件（首行 identity + 自定义末行）。 */
  function writeOrphanSession(id: string, lastLine: string, opts: { trailingNewline?: boolean } = {}): string {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id, agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    const file = path.join(sessionsDir, `2026-07-18T12-00-00-000Z_${id}.jsonl`);
    const middle = JSON.stringify({ type: "message", role: "assistant", content: "mid" });
    const body = [identity, middle, lastLine].join("\n") + (opts.trailingNewline === false ? "" : "\n");
    fs.writeFileSync(file, body, "utf8");
    return file;
  }

  function recovered(id: string) {
    const { pi, entries } = makePiHook();
    const store = new RecordStore(sessionsDir, new ManifestStore(path.join(rootDir, "records")), pi);
    store.recoverOrphanRecords("session-main");
    const hits = entries.filter((e) => e.data && (e.data as { id?: string }).id === id);
    if (hits.length === 0) throw new Error("orphan record not reported for " + id);
    return hits[hits.length - 1].data as Record<string, unknown>;
  }

  it("300KB 完整超长末行 → closed/gc 无 error（64KB 固定尾窗的旧实现会误判截断）", () => {
    // 300KB 单行 entry：> 64KB 初始窗 × 4 扩窗一档（64K→256K 仍不够 → 1M 覆盖到文件头）
    const bigPayload = "x".repeat(300 * 1024);
    writeOrphanSession("orphan-bigline", JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: bigPayload, status: "done" } }));
    const rec = recovered("orphan-bigline");
    expect(rec.status).toBe("closed");
    expect(rec.closedReason).toBe("gc");
    expect(rec.error).toBeUndefined();
  });

  it("末行截断（无尾换行的半行 JSON）→ closed/gc + error 标记截断", () => {
    // 半写入形态：最后一行 JSON 被切断且无尾换行
    const truncated = '{"type":"message","role":"assistant","content":"half-written line without clos';
    writeOrphanSession("orphan-truncated", truncated, { trailingNewline: false });
    const rec = recovered("orphan-truncated");
    expect(rec.status).toBe("closed");
    expect(rec.closedReason).toBe("gc");
    expect(rec.error).toContain("truncated last line");
  });

  it("超长且截断的末行 → 仍判截断 error（扩窗是为完整行服务，不放宽截断判定）", () => {
    const bigTruncated = JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: "y".repeat(300 * 1024) } }).slice(0, 300 * 1024);
    writeOrphanSession("orphan-bigcut", bigTruncated, { trailingNewline: false });
    const rec = recovered("orphan-bigcut");
    expect(rec.status).toBe("closed");
    expect(rec.error).toContain("truncated last line");
  });

  it("常规末行（多行文件、完整 JSON）→ closed/gc 无 error", () => {
    writeOrphanSession("orphan-normal", JSON.stringify({ type: "message", role: "assistant", content: "final" }));
    const rec = recovered("orphan-normal");
    expect(rec.status).toBe("closed");
    expect(rec.closedReason).toBe("gc");
    expect(rec.error).toBeUndefined();
  });

  it("仅 identity 单行文件（首行即末行，合法 JSON）→ closed 无 error", () => {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id: "orphan-empty", agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    // identity 首行 + 紧跟空行结尾：非空段只剩 identity（窗口到文件头，首段完整）
    fs.writeFileSync(path.join(sessionsDir, "2026-07-18T12-00-00-000Z_orphan-empty.jsonl"), identity + "\n", "utf8");
    const rec = recovered("orphan-empty");
    // 唯一非空行 = identity 首行（合法 JSON）→ 不判 error
    expect(rec.status).toBe("closed");
    expect(rec.error).toBeUndefined();
  });
});
