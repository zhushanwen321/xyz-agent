// src/execution/__tests__/start-collect-guard.test.ts
//
// startHandler 的 collect 语义（subagent-sync-collect U1 foundation）：
//   1. E4 校验（设计 §3.1.5）：conversation:true + collect:"sync" → immediate throw，
//      不产生半启动 record（execute 零调用）；文案指引「sync 仅支持 one-shot，
//      去掉 conversation 或 collect」；
//   2. 合法组合放行：collect 透传 service.execute（ExecuteOptions.collect）；
//   3. start 响应 collect 段（设计 §3.1.1）：仅 resolved=sync 附段（async 响应字节
//      零变化，G3）；pendingSyncCount = 未闭合批 sync 成员数（collectMode=sync 且无
//      batchFinalized）+ 本条（U1 阶段 record 落点未接线，manual +1，U2 接线后去除）。
//
// stub SubagentService 仅实现 handler 触达的方法子集（subagent-actions-core.test.ts
// 同款形态）；真实 service 行为归属 subagent-service 各自测试。

import { describe, expect, it, vi } from "vitest";

import { startHandler } from "../subagent-actions-core.ts";
import type {
  ExecutionHandle,
  SubagentRecord,
  SubagentService,
  SubagentToolDetails,
} from "../types.ts";

function makeDetails(): SubagentToolDetails {
  return {
    status: "running",
    mode: "background",
    agent: "/home/u/agents/worker.md",
    model: "prov/m1",
    thinkingLevel: undefined,
    slug: "src-slug",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
  } as SubagentToolDetails;
}

function makeHandle(): ExecutionHandle {
  return { mode: "background", subagentId: "sa-new", sessionFile: undefined, details: makeDetails() };
}

/** collectRecords stub 数据行（只含 pendingSyncCount 口径判读所需字段）。 */
function makeRec(over: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "sa-1",
    agent: "/home/u/agents/worker.md",
    task: "t",
    slug: "worker",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: "root-A",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 1,
    totalTokens: 42,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    ...over,
  } as SubagentRecord;
}

type ServiceStub = SubagentService & {
  execute: ReturnType<typeof vi.fn>;
  collectRecords: ReturnType<typeof vi.fn>;
};

function makeService(collectRecordsReturn: SubagentRecord[] = []): ServiceStub {
  const execute = vi.fn(async () => makeHandle());
  const collectRecords = vi.fn(() => collectRecordsReturn);
  return { execute, collectRecords } as unknown as ServiceStub;
}

const BASE_INPUT = { task: "do things", slug: "do-things" };

// ============================================================
// E4：conversation + collect:"sync" 即拒
// ============================================================

describe("startHandler E4 guard (conversation + collect:sync)", () => {
  it("throws immediately and never calls execute (不产生半启动 record)", async () => {
    const service = makeService();
    await expect(
      startHandler(service, { ...BASE_INPUT, conversation: true, collect: "sync" }, undefined),
    ).rejects.toThrow();
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("error copy carries the design guidance verbatim (文案锚定)", async () => {
    const service = makeService();
    const err = await startHandler(
      service,
      { ...BASE_INPUT, conversation: true, collect: "sync" },
      undefined,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'collect:"sync" only supports one-shot subagents — it cannot be combined with conversation:true. ' +
      'Remove either conversation or collect (use collect:"async", or omit it, for conversational subagents).',
    );
  });

  it("allows conversation:true + collect:async (async 语义与 conversation 正交)", async () => {
    const service = makeService();
    const result = await startHandler(
      service,
      { ...BASE_INPUT, conversation: true, collect: "async" },
      undefined,
    );
    expect(result.subagentId).toBe("sa-new");
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it("allows collect:sync alone (one-shot sync 是合法主场景)", async () => {
    const service = makeService();
    const result = await startHandler(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.subagentId).toBe("sa-new");
    expect(service.execute).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// collect 透传 + 响应 collect 段
// ============================================================

describe("startHandler collect forwarding + response collect segment", () => {
  it("forwards collect to service.execute via ExecuteOptions.collect", async () => {
    const service = makeService();
    await startHandler(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBe("sync");
  });

  it("omits collect in ExecuteOptions when not provided (undefined = config 默认语义)", async () => {
    const service = makeService();
    await startHandler(service, { ...BASE_INPUT }, undefined);
    const opts = service.execute.mock.calls[0]?.[0] as { collect?: string };
    expect(opts.collect).toBeUndefined();
  });

  it("attaches collect segment with pendingSyncCount=1 for the first sync start (含本条)", async () => {
    const service = makeService();
    const result = await startHandler(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 1 });
  });

  it("counts pending unmarked sync members + this one (跨轮续累口径)", async () => {
    const service = makeService([
      makeRec({ id: "sa-1", collectMode: "sync" }), // 未闭合（无 batchFinalized）→ 计入
      makeRec({ id: "sa-2", collectMode: "sync", batchFinalized: true }), // 已离场 → 排除
      makeRec({ id: "sa-3" }), // async → 排除
      makeRec({ id: "sa-4", collectMode: "sync", batchFinalized: false }), // 显式 false → 计入
    ]);
    const result = await startHandler(service, { ...BASE_INPUT, collect: "sync" }, undefined);
    expect(result.response.collect).toEqual({ mode: "sync", pendingSyncCount: 3 });
  });

  it("omits the collect segment for async starts (G3: async 响应字节零变化)", async () => {
    for (const input of [{ ...BASE_INPUT }, { ...BASE_INPUT, collect: "async" as const }]) {
      const service = makeService();
      const result = await startHandler(service, input, undefined);
      expect(result.response.collect).toBeUndefined();
      // G3 字节锚：response 其余字段与既有形态全等
      expect(result.response).toEqual({
        status: "running",
        mode: "background",
        message: result.response.message,
        notifyContract: "ledger+at-least-once",
      });
    }
  });
});
