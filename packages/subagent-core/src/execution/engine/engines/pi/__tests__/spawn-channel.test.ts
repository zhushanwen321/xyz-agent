// src/execution/engine/engines/pi/__tests__/spawn-channel.test.ts
//
// [U4 D4] spawn-channel 最小形状测试——证明策略注入位存在 + 新合一机制（行读取 /
// id 路由）的行为契约。不是行为改动测试：session-runner 消费面的行为等价由既有
// 全量测试锚定（u1-u3 基线），本文件只锁 spawn-channel 自身的原语语义与默认值。

import { describe, expect, it } from "vitest";

import {
  createGetStateResponseRouter,
  createLineReader,
  PI_KILL_GRACE_MS,
  SUBAGENT_CORE_SPAWN_POLICIES,
} from "../spawn-channel.ts";

describe("createLineReader（原语 2：LF 行读取）", () => {
  it("跨 chunk 缓冲切分：半个 LF 行跨两次 push 正确拼出完整行", () => {
    const lines: string[] = [];
    const reader = createLineReader({ onLine: (l) => lines.push(l) });
    reader.push('{"a":');
    reader.push('1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("空行也到达 onLine（既有语义：由消费方 parseSpawnLine 返回 undefined 跳过）", () => {
    const lines: string[] = [];
    const reader = createLineReader({ onLine: (l) => lines.push(l) });
    reader.push("a\n\nb\n");
    expect(lines).toEqual(["a", "", "b"]);
  });

  it("tee hook（onStdoutLine）：每行在 onLine 之前原样回调，含空行（注入位存在）", () => {
    const teed: string[] = [];
    const lines: string[] = [];
    const order: string[] = [];
    const reader = createLineReader({
      onLine: (l) => {
        lines.push(l);
        order.push(`onLine:${l}`);
      },
      onStdoutLine: (l) => {
        teed.push(l);
        order.push(`tee:${l}`);
      },
    });
    reader.push("x\n\ny");
    expect(teed).toEqual(["x", ""]);
    expect(lines).toEqual(["x", ""]);
    expect(order.slice(0, 2)).toEqual(["tee:x", "onLine:x"]);
    // 尾残行 "y" 同样先 tee 再进 onTrailingLine（缺省 = onLine）
    reader.flushTrailing();
    expect(teed).toEqual(["x", "", "y"]);
    expect(lines).toEqual(["x", "", "y"]);
  });

  it("尾残行：非空白才触发 onTrailingLine（既有 trim 门），空白残行与二次 flush 静默", () => {
    const trailing: string[] = [];
    const reader = createLineReader({ onLine: () => {}, onTrailingLine: (l) => trailing.push(l) });
    reader.push("a\n  ");
    reader.flushTrailing();
    expect(trailing).toEqual([]);
    reader.push("tail-no-lf");
    reader.flushTrailing();
    reader.flushTrailing(); // 幂等：缓冲已清空
    expect(trailing).toEqual(["tail-no-lf"]);
  });

  it("onTrailingLine 缺省复用 onLine（与原手写单一消费者形态等价）", () => {
    const lines: string[] = [];
    const reader = createLineReader({ onLine: (l) => lines.push(l) });
    reader.push("tail");
    reader.flushTrailing();
    expect(lines).toEqual(["tail"]);
  });

  it("maxBufferChars：超限丢最旧前缀保尾部；缺省 undefined 无上限（subagent-core 现状）", () => {
    const lines: string[] = [];
    const reader = createLineReader({
      onLine: (l) => lines.push(l),
      maxBufferChars: 4,
    });
    // 未完整行超 4 字符：缓冲保尾部 4 字符（"456\n"，含 LF）——补上 LF 后输出 "456"
    reader.push("123456\n");
    expect(lines).toEqual(["456"]);
  });
});

describe("createGetStateResponseRouter（原语 4：response id 路由）", () => {
  it("register → dispatch：命中即移除再调用（单次消费），二次分发 no-op", () => {
    const router = createGetStateResponseRouter();
    const seen: unknown[] = [];
    router.register("id-1", (d) => seen.push(d));
    expect(router.dispatch("id-1", { sessionFile: "/x" })).toBe(true);
    expect(seen).toEqual([{ sessionFile: "/x" }]);
    expect(router.dispatch("id-1", { sessionFile: "/x" })).toBe(false);
  });

  it("注销函数阻止后续分发；按句守卫不误删同 id 新 resolver", () => {
    const router = createGetStateResponseRouter();
    const seen: string[] = [];
    const unregister = router.register("id-1", () => seen.push("old"));
    const replace = router.register("id-1", () => seen.push("new"));
    unregister(); // 旧 resolver 注销：同 id 已被覆盖，按句守卫不删新条目
    expect(router.dispatch("id-1", {})).toBe(true);
    expect(seen).toEqual(["new"]);
    replace();
    expect(router.dispatch("id-1", {})).toBe(false);
  });

  it("未注册 id 与 clear 后的分发返回 false（close 统一清理语义）", () => {
    const router = createGetStateResponseRouter();
    expect(router.dispatch("nope", {})).toBe(false);
    router.register("id-1", () => {});
    router.clear();
    expect(router.dispatch("id-1", {})).toBe(false);
  });
});

describe("SUBAGENT_CORE_SPAWN_POLICIES（四维策略默认值登记，u5 注入对照基准）", () => {
  it("subagent-core 侧默认：事件帧直通 / 迟到幂等回填 / 容错降级 / SIGTERM→30s→SIGKILL", () => {
    expect(SUBAGENT_CORE_SPAWN_POLICIES.eventFrameGap).toEqual({ kind: "pass-through" });
    expect(SUBAGENT_CORE_SPAWN_POLICIES.lateResponse).toEqual({ kind: "idempotent-backfill" });
    expect(SUBAGENT_CORE_SPAWN_POLICIES.failureHandling).toEqual({ kind: "tolerant-degrade" });
    expect(SUBAGENT_CORE_SPAWN_POLICIES.kill).toEqual({
      mode: "escalating-sigterm",
      graceMs: 30_000,
    });
    expect(PI_KILL_GRACE_MS).toBe(30_000);
  });
});
