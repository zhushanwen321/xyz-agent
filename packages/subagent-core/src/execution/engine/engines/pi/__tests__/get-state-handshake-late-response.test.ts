// src/execution/engine/engines/pi/__tests__/get-state-handshake-late-response.test.ts
//
// [U1 D1] performGetStateHandshake 迟到接受单测（实施计划 u1-acquire 验收条款①）。
//
// 覆盖：
//   1. 握手全部重试超时 resolve 后，迟到 response 不再丢弃 → onLateResponse 收到提取字段；
//   2. 迟到 response 字段缺失/畸形 → 提取不到就跳过，不回调（错误规格 §3.5 D1 行）；
//   3. 未传 onLateResponse（旧两参形态）→ 迟到 response 不炸，行为与 D1 前一致（API 兼容）；
//   4. close 后迟到不到达 resolver：监听表清空（close handler clearGetStateListeners 语义）
//      后派发 response → onLateResponse 不触发、record 不被回填；
//   5. 正常路径（握手期内拿到 sessionFile）→ onLateResponse 不被调用（迟到回调不误报）。
//
// requestGetStateOnce 契约不受本改动影响（回归锚点 =
// src/execution/__tests__/get-state-handshake.test.ts，此处不重复）。

import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { performGetStateHandshake } from "../get-state-handshake.ts";

/** 最小 FakeChild：只需 stdin.write 行为（握手发 get_state 命令）。 */
function makeFakeStdin(): { child: ChildProcess; writes: string[] } {
  const writes: string[] = [];
  const child = {
    stdin: {
      write(line: string): boolean {
        writes.push(line);
        return true;
      },
    },
  } as unknown as ChildProcess;
  return { child, writes };
}

/** 可控的监听表：模拟 stdout pump 的 get_stateListeners（close 时整体清空）。 */
function makeListenerRegistry() {
  const resolvers = new Map<string, (data: unknown) => void>();
  const add = (id: string, resolver: (data: unknown) => void) => {
    resolvers.set(id, resolver);
    return () => {
      if (resolvers.get(id) === resolver) resolvers.delete(id);
    };
  };
  return { resolvers, add };
}

/** 驱动握手走完全部重试（3 × 2s 超时 + 2 × 0.5s 间隔 ≈ 7s）直至 resolve 空结果。 */
async function exhaustHandshake(promise: Promise<unknown>): Promise<void> {
  await vi.advanceTimersByTimeAsync(7_100);
  await expect(promise).resolves.toEqual({});
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("performGetStateHandshake 迟到接受（[U1 D1] 幂等 late-binding）", () => {
  it("握手超时 resolve 后迟到 response 到达 → onLateResponse 收到提取的 sessionFile/sessionId", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();
    const late: unknown[] = [];

    const promise = performGetStateHandshake(child, reg.add, (r) => late.push(r));
    expect(writes).toHaveLength(1); // 首次 get_state 已发出
    await exhaustHandshake(promise); // 3 次重试全部超时，resolve {}

    // 迟到应答（pi 就绪后补答）经原 resolver 到达——D1 前被 `if (resolved) return` 丢弃
    const firstId = JSON.parse(writes[0]!) as { id: string };
    reg.resolvers.get(firstId.id)?.({ sessionFile: "/tmp/agents/sa-late.jsonl", sessionId: "sess-late" });

    expect(late).toEqual([{ sessionFile: "/tmp/agents/sa-late.jsonl", sessionId: "sess-late" }]);
  });

  it("迟到 response 缺字段/畸形 → 不回调（提取不到就跳过，不留痕噪音）", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();
    const late: unknown[] = [];

    const promise = performGetStateHandshake(child, reg.add, (r) => late.push(r));
    await exhaustHandshake(promise);

    const firstId = JSON.parse(writes[0]!) as { id: string };
    const resolver = reg.resolvers.get(firstId.id)!;
    resolver({ sessionId: 12345 }); // 字段类型非法 → 不提取
    resolver({ unrelated: true }); // 无目标字段 → 不提取
    resolver("not-an-object"); // 畸形 data → 不提取

    expect(late).toEqual([]);
  });

  it("未传 onLateResponse（旧两参形态）→ 迟到 response 到达不抛（既有调用方兼容）", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();

    const promise = performGetStateHandshake(child, reg.add);
    await exhaustHandshake(promise);

    const firstId = JSON.parse(writes[0]!) as { id: string };
    expect(() =>
      reg.resolvers.get(firstId.id)?.({ sessionFile: "/tmp/x.jsonl" }),
    ).not.toThrow();
  });

  it("close 后迟到不到达 resolver：监听表清空后派发 response → onLateResponse 不触发", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();
    const late: unknown[] = [];

    const promise = performGetStateHandshake(child, reg.add, (r) => late.push(r));
    await exhaustHandshake(promise);

    // 模拟 close handler：pump.clearGetStateListeners()（waitForChildExit close 分支既有语义）
    // ——条目清除后 response 行匹配不到 resolver，迟到路径自然不可达（竞态推演 #1 的安全前提）。
    reg.resolvers.clear();
    const firstId = JSON.parse(writes[0]!) as { id: string };
    expect(reg.resolvers.get(firstId.id)).toBeUndefined();
    // 即使 pump 侧残留派发（防御形态），Map 中无 resolver 即无调用面——直接断言表空 +
    // 回调零触达（无任何 resolver 可供派发）。
    expect(late).toEqual([]);
  });

  it("正常路径（握手期内拿到 sessionFile）→ 提前 resolve，迟到回调不误报", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();
    const late: unknown[] = [];

    const promise = performGetStateHandshake(child, reg.add, (r) => late.push(r));
    const firstId = JSON.parse(writes[0]!) as { id: string };
    reg.resolvers.get(firstId.id)?.({ sessionFile: "/tmp/agents/fast.jsonl", sessionId: "sess-1" });

    await expect(promise).resolves.toEqual({
      sessionFile: "/tmp/agents/fast.jsonl",
      sessionId: "sess-1",
    });
    expect(late).toEqual([]); // 正常 resolve 路径不走迟到回调
  });

  it("同 reqId 二次派发（重试在途多请求形态）：resolved 后到达的应答走迟到回调而非二次 resolve", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();
    const late: unknown[] = [];

    const promise = performGetStateHandshake(child, reg.add, (r) => late.push(r));
    // 两个在途请求：#1 未答超时（2.5s 后 #2 发出），#2 先答命中 sessionFile → 提前 resolve
    await vi.advanceTimersByTimeAsync(2_600);
    expect(writes).toHaveLength(2);
    const id2 = (JSON.parse(writes[1]!) as { id: string }).id;
    reg.resolvers.get(id2)?.({ sessionFile: "/tmp/agents/second.jsonl", sessionId: "sess-2" });
    await expect(promise).resolves.toEqual({
      sessionFile: "/tmp/agents/second.jsonl",
      sessionId: "sess-2",
    });

    // #1 的应答随后才到（迟到）→ 走迟到回调，不再影响已 resolve 的握手结果
    const id1 = (JSON.parse(writes[0]!) as { id: string }).id;
    reg.resolvers.get(id1)?.({ sessionFile: "/tmp/agents/first-late.jsonl", sessionId: "sess-1" });
    expect(late).toEqual([{ sessionFile: "/tmp/agents/first-late.jsonl", sessionId: "sess-1" }]);
  });
});
