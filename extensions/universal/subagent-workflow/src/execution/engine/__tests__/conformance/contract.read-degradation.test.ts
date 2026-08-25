// contract.read-degradation.test.ts —— conformance C5（read 降级链）：三级都不 throw、
// 坏 handle → 结构化降级（outcome-only）非崩溃、②级 journal 重放与 live 一致
// （重放等价性，§3.3.6——journal 重放与 live 通路共用同一 reducer 的断言面）。
//
// fake 注入：zcode 用坏 dbPath（①级失败）+ 临时 journal 文件（②级命中）；pi 用
// 不存在的 sessionFile（①级失败）+ journal（②级）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventsToSessionView } from "../../common/journal-replay.ts";
import { JournalWriter } from "../../common/event-journal.ts";
import { PiEngine } from "../../engines/pi/pi-engine.ts";
import { ZcodeEngine } from "../../engines/zcode/zcode-engine.ts";
import type { AgentEvent, EngineHandle } from "../../types.ts";

function makeHandle(engineId: string, sessionRef: Record<string, string>, journalPath?: string): EngineHandle {
  return {
    data: {
      v: 1,
      engineId,
      sessionRef,
      poolKey: "shared",
      ...(journalPath !== undefined ? { journalPath } : {}),
      adapterVersion: "1.0.0-test",
    },
  };
}

/** live 通路形态的事件序列（与 golden 回放同源——重放等价性的比对基准）。 */
const liveEvents: AgentEvent[] = [
  { type: "text_delta", delta: "part one. " },
  { type: "text_delta", delta: "part two." },
  { type: "message_end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
  { type: "turn_end" },
];

describe("conformance C5：read 降级链（三级都不 throw）", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "c5-read-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("重放等价性：journal 重放 turns 与 live 累积一致（共用 updateFromEvent reducer）", () => {
    const live = eventsToSessionView(liveEvents, "pi", "sess-x");
    expect(live.source).toBe("journal");
    expect(live.turns).toHaveLength(1);
    expect(live.turns[0]?.text).toBe("part one. part two.");
    expect(live.usage?.total).toBe(15);
  });

  it("zcode：①级坏 handle（dbPath 指向不存在文件）→ ②级 journal 命中（source=journal）", async () => {
    const journalPath = path.join(dataDir, "journal-sa-c5.jsonl");
    const writer = new JournalWriter({ path: journalPath, taskId: "sa-c5", engineId: "zcode" });
    for (const ev of liveEvents) writer.append(ev);
    await writer.close();

    const engine = new ZcodeEngine({ engineDataDir: () => dataDir });
    const handle = makeHandle("zcode", { sessionId: "sess-c5", dbPath: ".zcode/cli/db/db.sqlite" }, journalPath);
    const view = await engine.read(handle); // ①级 db 不存在 → catch → ②级重放
    expect(view.source).toBe("journal");
    expect(view.engineId).toBe("zcode");
    expect(view.turns[0]?.text).toBe("part one. part two.");
  });

  it("zcode：②级也不可达（无 journalPath）→ ③级 outcome-only，不 throw", async () => {
    const engine = new ZcodeEngine({ engineDataDir: () => dataDir });
    const handle = makeHandle("zcode", { sessionId: "sess-c5", dbPath: ".zcode/cli/db/db.sqlite" });
    const view = await engine.read(handle);
    expect(view.source).toBe("outcome-only");
    expect(view.turns).toEqual([]);
  });

  it("zcode：跨引擎 handle（engineId 不符）→ 结构化 outcome-only，不 throw", async () => {
    const engine = new ZcodeEngine({ engineDataDir: () => dataDir });
    const view = await engine.read(makeHandle("pi", {}));
    expect(view.source).toBe("outcome-only");
  });

  it("pi：①级坏 handle（sessionFile 不存在）→ ②级 journal 命中；②级缺省 → ③级", async () => {
    const engine = new PiEngine({ getService: () => null });

    const journalPath = path.join(dataDir, "journal-sa-pi-c5.jsonl");
    const writer = new JournalWriter({ path: journalPath, taskId: "sa-pi-c5", engineId: "pi" });
    for (const ev of liveEvents) writer.append(ev);
    await writer.close();

    const viaJournal = await engine.read(
      makeHandle("pi", { sessionFile: "/nonexistent/session.jsonl" }, journalPath),
    );
    expect(viaJournal.source).toBe("journal");
    expect(viaJournal.turns[0]?.text).toBe("part one. part two.");

    const outcomeOnly = await engine.read(makeHandle("pi", { sessionFile: "/nonexistent/session.jsonl" }));
    expect(outcomeOnly.source).toBe("outcome-only");
    expect(outcomeOnly.turns).toEqual([]);
  });
});
