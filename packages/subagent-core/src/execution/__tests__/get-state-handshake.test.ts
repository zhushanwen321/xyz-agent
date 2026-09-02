// src/execution/__tests__/get-state-handshake.test.ts
//
// [T1/RC-1] requestGetStateOnce 单测：agent_end 决策点惰性回补用的单次 get_state 请求辅助。
//
// 契约锚点（与 performGetStateHandshake 共用消息构造 sendGetStateCommand + 字段提取
// extractGetStateFields，但不做重试循环）：
//   1. response 到达 → resolve 提取后的 GetStateResult（无条件 finish，单次语义无重试）；
//   2. 超时 → resolve 空对象（调用方走保守分支）；
//   3. stdin 同步写失败（EPIPE 形态）→ resolve 空对象、永不 reject（fire-and-forget 契约）；
//   4. 自清理：finish 后从监听表注销本请求 resolver（消费注册器返回的注销函数）；
//      注册器不返回注销函数时退化为 no-op（与握手同形态）。
//
// performGetStateHandshake 既有行为由 run-spawn-rpc-mode.test.ts 集成覆盖，此处不重复。

import { describe, expect, it, vi } from "vitest";

import { requestGetStateOnce } from "../get-state-handshake.ts";
import type { ChildProcess } from "node:child_process";

/** 最小 FakeChild：只需 stdin.write 行为（成功 / 可注入同步 throw）。 */
function makeFakeStdin(behavior?: { throwOnWrite?: Error }): { child: ChildProcess; writes: string[] } {
  const writes: string[] = [];
  const child = {
    stdin: {
      write(line: string): boolean {
        if (behavior?.throwOnWrite) throw behavior.throwOnWrite;
        writes.push(line);
        return true;
      },
    },
  } as unknown as ChildProcess;
  return { child, writes };
}

/** 可控的监听表：模拟 stdout pump 的 get_stateListeners（注册返回注销函数）。 */
function makeListenerRegistry() {
  const resolvers = new Map<string, (data: unknown) => void>();
  const removed: string[] = [];
  const add = (id: string, resolver: (data: unknown) => void) => {
    resolvers.set(id, resolver);
    return () => {
      if (resolvers.get(id) === resolver) resolvers.delete(id);
      removed.push(id);
    };
  };
  return { resolvers, removed, add };
}

describe("requestGetStateOnce（[T1/RC-1] 惰性回补单次请求）", () => {
  it("response 到达 → resolve 提取的 sessionFile/sessionId，并从监听表注销", async () => {
    const { child, writes } = makeFakeStdin();
    const reg = makeListenerRegistry();

    const promise = requestGetStateOnce(child, reg.add, 1000);
    // 消息构造：单行 JSON {id, type:"get_state"}（与 performGetStateHandshake 同一 sendGetStateCommand）
    expect(writes).toHaveLength(1);
    const sent = JSON.parse(writes[0]!) as { id: string; type: string };
    expect(sent.type).toBe("get_state");
    expect(reg.resolvers.has(sent.id)).toBe(true);

    // response 到达（含空串 sessionFile 应被过滤的字段形态覆盖提取规则）
    reg.resolvers.get(sent.id)?.({
      sessionFile: "/tmp/sessions/abc.jsonl",
      sessionId: "sess-1",
    });

    await expect(promise).resolves.toEqual({
      sessionFile: "/tmp/sessions/abc.jsonl",
      sessionId: "sess-1",
    });
    // 自清理：finish 后从监听表移除本请求 resolver
    expect(reg.resolvers.has(sent.id)).toBe(false);
    expect(reg.removed).toEqual([sent.id]);
  });

  it("response 只含部分字段（仅 sessionId）→ resolve 已提取部分（单次语义：到达即 finish，不等重试）", async () => {
    const { child } = makeFakeStdin();
    const reg = makeListenerRegistry();

    const promise = requestGetStateOnce(child, reg.add, 1000);
    const id = reg.resolvers.keys().next().value as string;
    reg.resolvers.get(id)?.({ sessionId: "only-id" });

    await expect(promise).resolves.toEqual({ sessionId: "only-id" });
  });

  it("超时无 response → resolve 空对象（不 reject，不调注销前的 resolver）", async () => {
    vi.useFakeTimers();
    try {
      const { child } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = requestGetStateOnce(child, reg.add, 1000);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("stdin 同步写失败（EPIPE code，writeStdinLine rethrow 路径）→ 立即 resolve 空对象、永不 reject", async () => {
    // writeStdinLine 只对 code 为 EPIPE / ERR_STREAM_DESTROYED 的错误 rethrow（[R3]），
    // requestGetStateOnce 的 catch 捕获后按「回补失败」resolve 空对象（同超时语义）。
    const epipeErr = Object.assign(new Error("write after end"), { code: "EPIPE" });
    const { child } = makeFakeStdin({ throwOnWrite: epipeErr });
    const reg = makeListenerRegistry();

    await expect(requestGetStateOnce(child, reg.add, 1000)).resolves.toEqual({});
    // 写失败路径不注册监听（未发出请求）
    expect(reg.resolvers.size).toBe(0);
  });

  it("注册器不返回注销函数（void 形态，对齐旧握手调用方）→ 正常 resolve 不抛", async () => {
    const { child } = makeFakeStdin();
    const resolvers = new Map<string, (data: unknown) => void>();
    const addVoid = (id: string, resolver: (data: unknown) => void): void => {
      resolvers.set(id, resolver);
    };

    const promise = requestGetStateOnce(child, addVoid, 1000);
    const id = resolvers.keys().next().value as string;
    resolvers.get(id)?.({ sessionFile: "/tmp/x.jsonl" });

    await expect(promise).resolves.toEqual({ sessionFile: "/tmp/x.jsonl" });
  });
});
