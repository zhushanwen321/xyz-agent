// session-view-service-zcode-dbpath.test.ts —— zcode ①级 dbPath 白名单的分支守护。
//
// 三视角：①构建者——白名单三分支（绝对=宿主 db 精确匹配 / 绝对≠宿主 db 拒绝 /
// 相对池锚定 + 越界拒绝）逐路径断言；②使用者——共享 HOME 形态 record（写侧
// zcode-engine 恒绝对 dbPath）tier1 不再被误拒静默降②级；③观察者——reader 调用
// 参数（白名单通过后传入的 dbPath 精确值）与未调用事实（拒绝路径 reader 零触达）。
//
// readZcodeSessionView 以 vi.mock 替身：本文件测的是白名单分支（不可触达真实
// ~/.zcode/cli/db/db.sqlite——那是用户真机数据），reader 本体行为由
// engines/zcode/__tests__/reader.test.ts 真库覆盖。

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../engines/zcode/reader.ts", () => ({
  readZcodeSessionView: vi.fn(),
}));

import { readZcodeSessionView } from "../../engines/zcode/reader.ts";
import { ZCODE_HOST_DB_SUFFIX } from "../../engines/zcode/constants.ts";
import { JournalWriter } from "../../common/event-journal.ts";
import { readSubagentHistoryMessages } from "../../common/session-view-service.ts";
import { resetNativeSessionReaders } from "../../common/session-view-service.ts";
import type { SubagentRecordSnapshot } from "../../common/session-view-types.ts";
import type { AgentEvent } from "../../../types.ts";
import type { SessionView } from "../../types.ts";

const mockedRead = vi.mocked(readZcodeSessionView);

/** 共享 HOME 形态写侧恒写入的唯一合法绝对 dbPath（与 zcode-engine hostZcodeDbPath 同源推导）。 */
const HOST_DB = resolve(homedir(), ...ZCODE_HOST_DB_SUFFIX);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "svs-dbpath-test-"));
  mockedRead.mockReset();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  resetNativeSessionReaders();
});

function makeRecord(overrides: Partial<SubagentRecordSnapshot> = {}): SubagentRecordSnapshot {
  return {
    subagentId: "sub-1",
    task: "do the thing",
    startedAt: 1_000,
    engine: "zcode",
    engineHandle: {
      sessionRef: { sessionId: "sess-1", dbPath: HOST_DB },
      poolKey: "shared",
    },
    ...overrides,
  };
}

async function writeJournal(path: string, events: AgentEvent[]): Promise<void> {
  const writer = new JournalWriter({ path, taskId: "sub-1", engineId: "zcode" });
  for (const ev of events) writer.append(ev);
  await writer.close();
}

/** record 带②级可达 journal（tier1 被拒后的可观察落点：journal 内容被投影）。 */
async function journalRecord(dbPath: string): Promise<SubagentRecordSnapshot> {
  const journalPath = join(dataDir, "engines", "zcode", "shared", "journal-sub-1.jsonl");
  await writeJournal(journalPath, [{ type: "text_delta", delta: "journal says" }]);
  return makeRecord({
    result: "outcome fallback",
    engineHandle: {
      sessionRef: { sessionId: "sess-1", dbPath },
      poolKey: "shared",
      journalPath,
    },
  });
}

describe("zcode ①级 dbPath 白名单（分支守护）", () => {
  it("绝对 dbPath = 宿主 db（SSOT 精确匹配）→ 白名单通过，reader 收到原样路径，tier1 命中", async () => {
    const view: SessionView = {
      engineId: "zcode",
      sessionId: "sess-1",
      turns: [{ text: "from host db", thinking: "", toolCalls: [], closed: true }],
      source: "native",
    };
    mockedRead.mockResolvedValue(view);
    const messages = await readSubagentHistoryMessages(makeRecord(), dataDir);
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedRead).toHaveBeenCalledWith(HOST_DB, "sess-1");
    expect(messages[1]).toMatchObject({ role: "assistant", content: "from host db" });
  });

  it("绝对 dbPath ≠ 宿主 db → 拒绝 tier1（reader 零触达），降②级 journal", async () => {
    const record = await journalRecord("/tmp/attacker-chosen/db.sqlite");
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(mockedRead).not.toHaveBeenCalled();
    expect(messages[1]).toMatchObject({ role: "assistant", content: "journal says" });
  });

  it("宿主 db 路径的目录内变体（/../ 注入）≠ 精确匹配 → 同样拒绝", async () => {
    // 白名单是文本级精确匹配（resolve 不可用于反构造——会把 .. 规约掉变回正身）
    const sneaky = `${HOST_DB}/../db.sqlite`;
    const record = await journalRecord(sneaky);
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(mockedRead).not.toHaveBeenCalled();
    expect(messages[1]).toMatchObject({ content: "journal says" });
  });

  it("相对 dbPath 池内（旧池时代 record）→ 锚池目录解析，reader 收到池内绝对路径", async () => {
    const view: SessionView = {
      engineId: "zcode",
      sessionId: "sess-1",
      turns: [{ text: "legacy pool", thinking: "", toolCalls: [], closed: true }],
      source: "native",
    };
    mockedRead.mockResolvedValue(view);
    const record = makeRecord({
      engineHandle: {
        sessionRef: { sessionId: "sess-1", dbPath: "pool-db/db.sqlite" },
        poolKey: "shared",
      },
    });
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(mockedRead).toHaveBeenCalledWith(
      join(dataDir, "engines", "zcode", "shared", "pool-db", "db.sqlite"),
      "sess-1",
    );
    expect(messages[1]).toMatchObject({ content: "legacy pool" });
  });

  it("相对 dbPath ../ 逃逸池目录 → 拒绝 tier1（reader 零触达），降②级 journal", async () => {
    const record = await journalRecord("../../escape/db.sqlite");
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(mockedRead).not.toHaveBeenCalled();
    expect(messages[1]).toMatchObject({ content: "journal says" });
  });

  it("白名单通过但 reader 抛错（结构化降级契约）→ 仍降②级不崩", async () => {
    mockedRead.mockRejectedValue(new Error("engine_session_read_failed: db 文件不存在"));
    const record = await journalRecord(HOST_DB);
    const messages = await readSubagentHistoryMessages(record, dataDir);
    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(messages[1]).toMatchObject({ content: "journal says" });
  });
});
