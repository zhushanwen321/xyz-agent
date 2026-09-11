// src/execution/__tests__/conversation-continuation.test.ts
//
// [H1 U2] ConversationContinuation 单测族（§5 U2 验收清单逐项对应用例）+ SubagentService
// 集成面（one-shot 四分支回归 / closeAfterRound 退役 / 引擎死亡单发通知 / stale-child
// 兜底 / 收割链之外的 chat 编排面）。
//
// 设计权威源：docs/design/subagent-chat-run-unification.md §3.4（伪码即实现契约）/
// §3.3 D4 状态迁移表 / D5 双写点 gate / D7 轮末分流。Continuation 单测 = mock host
//（编排能力全注入，次序断言用 order 账本）；集成面 = registerFakePiEngine 协议替身
//（与 delivery-methods.test.ts 同源 setup 形态）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

const { killChildSpy } = vi.hoisted(() => ({ killChildSpy: vi.fn() }));
vi.mock("../engine/host/spawned-children.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/host/spawned-children.ts")>();
  return { ...actual, killRecordChildWithEscalation: killChildSpy };
});

import { ConversationContinuation } from "../conversation-continuation.ts";
import type {
  ContinuationDispatchInput,
  ContinuationHost,
} from "../conversation-continuation.ts";
import type { RoundSettlementOutcome } from "../finalize-record.ts";
import { createNotifier, type BgNotifyRecord } from "../notifier.ts";
import { bindNotifyLedgerHost } from "../notify-ledger.ts";
import type { AgentOutcome } from "../engine/types.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines, registerEngine } from "../engine/registry.ts";
import { createRecord } from "../execution-record.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { RecordStore } from "../record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import type { PiLike } from "../subagent-service.ts";
import {
  armMidRoundNoProgress,
  getSettledWatchdogPhase,
  hasSettledWatchdog,
  _resetSettledWatchdogsForTest,
  _setMidRoundNoProgressWindowMsForTest,
} from "../settled-watchdog.ts";
import { _resetLifecycleState } from "../lifecycle-manager.ts";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  registerSpawnedChildForRecord,
} from "../engine/host/spawned-children.ts";
import type { ExecutionRecord } from "../types.ts";

// ============================================================
// Continuation 单测（mock host）
// ============================================================

interface HostCalls {
  order: string[];
  dispatched: Array<ContinuationDispatchInput & { recordId: string }>;
  finalized: Array<{ recordId: string; outcome: RoundSettlementOutcome }>;
  routed: string[];
  notified: BgNotifyRecord[];
  killStale: string[];
  killedRound: Array<{ recordId: string; source: string }>;
  revived: string[];
  transitions: string[];
  closed: string[];
  gateAllows: boolean;
}

function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
  const { id = "sa-cont", ...rest } = overrides;
  const r = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "cont",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  Object.assign(r, rest);
  return r;
}

function makeHost(record: ExecutionRecord, overrides: Partial<HostCalls> = {}): {
  host: ContinuationHost;
  calls: HostCalls;
} {
  const calls: HostCalls = {
    order: [],
    dispatched: [],
    finalized: [],
    routed: [],
    notified: [],
    killStale: [],
    killedRound: [],
    revived: [],
    transitions: [],
    closed: [],
    gateAllows: true,
    ...overrides,
  };
  const host: ContinuationHost = {
    dispatchChatRound: (rec, input) => {
      calls.order.push(`dispatch:${rec.id}`);
      calls.dispatched.push({ ...input, recordId: rec.id });
    },
    finalizeRoundOutcome: async (rec, outcome) => {
      calls.order.push(`finalize:${outcome.kind}`);
      calls.finalized.push({ recordId: rec.id, outcome });
      // 模拟真实 doFinalizeRoundToIdle 的 round+1（dedup key 断言依赖）。
      // 刻意不清 closedReason（真实实现清）——notifyGate 门用例需要构造
      // 「running record + closedReason 残留」的门语义形态（真实链路该形态
      // 由 finalize 清除前的窗口构成，门是防御性第二闸）。
      record.round = (record.round ?? 0) + 1;
    },
    routeRecord: (rec) => {
      calls.order.push(`route:${rec.id}`);
      calls.routed.push(rec.id);
    },
    notifyRecord: (n) => {
      calls.order.push("notify");
      calls.notified.push(n);
    },
    killStaleChild: async (id) => {
      calls.order.push(`killStale:${id}`);
      calls.killStale.push(id);
    },
    killRoundChild: (id, source) => {
      calls.killedRound.push({ recordId: id, source });
    },
    upgradeGateAllows: () => calls.gateAllows,
    reviveClosedRecord: (rec) => {
      calls.revived.push(rec.id);
    },
    reportRecordTransition: (rec) => {
      calls.transitions.push(rec.id);
    },
    closeNow: async (rec) => {
      calls.closed.push(rec.id);
    },
  };
  return { host, calls };
}

function makeOutcome(partial: Partial<AgentOutcome> = {}): AgentOutcome {
  return { content: "", engineId: "pi", ...partial } as AgentOutcome;
}

describe("ConversationContinuation — D4 状态迁移表：closed 可重连终态 revive 格（含非 chatMode 升级两成员）", () => {
  it.each(["disconnected", "parent-shutdown"] as const)(
    "closed + %s + 非 chatMode → D5 gate 放行 → 升级 chatMode=true + revive + 续聊轮派发（resume 锚点）",
    async (reason) => {
      const record = makeRecord({ id: `sa-revive-${reason}`, chatMode: false, sessionFile: "/tmp/s.jsonl" });
      record.status = "closed";
      record.closedReason = reason;
      const { host, calls } = makeHost(record);
      const cont = new ConversationContinuation(record, host);

      cont.onMessage("continue please");

      // 升级置位（D4 revive 格——v4 显式化：水合保留持久化 chatMode 后的升级语义）
      expect(record.chatMode).toBe(true);
      expect(record.status).toBe("running");
      expect(record.closedReason).toBeUndefined();
      expect(calls.revived).toEqual([record.id]);
      // 续聊轮派发：resume 锚点 = record.sessionFile
      await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
      expect(calls.dispatched[0]!.task).toBe("continue please");
      expect(calls.dispatched[0]!.resume?.sessionRef["sessionFile"]).toBe("/tmp/s.jsonl");
      expect(calls.dispatched[0]!.resume?.poolKey).toBe("shared");
    },
  );

  it("closed 可重连终态 + 非 chatMode + D5 gate 不过（unsupported 引擎）→ 硬拒 + fork/重派指引，chatMode 不置位", async () => {
    const record = makeRecord({ id: "sa-gate-deny", chatMode: false, sessionFile: "/tmp/s.jsonl", engine: "zcode" });
    record.status = "closed";
    record.closedReason = "disconnected";
    const { host, calls } = makeHost(record, { gateAllows: false });
    const cont = new ConversationContinuation(record, host);

    let gateError: (Error & { recovery?: string }) | undefined;
    try {
      cont.onMessage("hi");
    } catch (err) {
      gateError = err as Error & { recovery?: string };
    }
    // message = 失败原因（capabilities.conversation = 'unsupported' 依据）
    expect(gateError?.message).toContain("cannot be upgraded to a resumable conversation");
    // recovery = fork/重派指引（D5：避免升级后续聊行为悬空）
    expect(gateError?.recovery).toContain("fork-from");
    expect(gateError?.recovery).toContain("action:'start'");
    expect(record.chatMode).toBe(false);
    expect(record.status).toBe("closed");
    expect(calls.revived).toEqual([]);
    expect(calls.dispatched.length).toBe(0);
  });

  it("closed 可重连终态 + chatMode 已置位 → 不经 gate 直接 revive（gate 判据不触达）", async () => {
    const record = makeRecord({ id: "sa-revive-chat", chatMode: true, sessionFile: "/tmp/s.jsonl" });
    record.status = "closed";
    record.closedReason = "parent-shutdown";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("hello again");

    expect(record.status).toBe("running");
    expect(calls.revived).toEqual([record.id]);
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
  });

  it("closed user-close → 硬拒（D4 closed 硬拒格：nothing can reattach）", () => {
    const record = makeRecord({ id: "sa-user-close", chatMode: true });
    record.status = "closed";
    record.closedReason = "user-close";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    expect(() => cont.onMessage("hi")).toThrow(/cannot be messaged or resumed/);
    expect(calls.dispatched.length).toBe(0);
  });

  it("closed parent-new（不可重连集外）→ 硬拒（fork-from 语义由 endedMessageGuard 分流）", () => {
    const record = makeRecord({ id: "sa-parent-new", chatMode: true });
    record.status = "closed";
    record.closedReason = "parent-new";
    const { host } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    expect(() => cont.onMessage("hi")).toThrow(/cannot be messaged or resumed/);
  });
});

describe("ConversationContinuation — D2 打断 / abort 不终态化 / 单飞", () => {
  it("轮在途 message → abort 在途轮 signal + 入队（record 不终态化、不二次派发）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const round1Signal = calls.dispatched[0]!.signal;

    cont.onMessage("interrupt: change angle");

    // D2：打断 = 轮级 abort（非 record 级 cancel——record 保持 running）
    expect(round1Signal.aborted).toBe(true);
    expect(record.status).toBe("running");
    expect(cont.pendingCount).toBe(1);
    expect(calls.dispatched.length).toBe(1); // 单飞：无二次派发
    expect(calls.order.filter((s) => s.startsWith("dispatch")).length).toBe(1);
  });

  it("abort 收敛（onRunSettled 失败形态）→ drain 聚合队列为下一轮（单写者前置满足后才派发）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    cont.onMessage("msg A");
    cont.onMessage("msg B");

    // 被打断轮以失败形态收敛（abort 合成 error outcome）
    cont.onRunSettled(makeOutcome({ content: "", error: "engine_run_failed: run aborted" }));

    // 失败簿记 + drain：两条聚合为一轮输入
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(2));
    expect(calls.dispatched[1]!.task).toBe("msg A\n\nmsg B");
    expect(cont.pendingCount).toBe(0);
  });

  it("record 终态化后 onRunSettled → 整体 early-return：不簿记、不通知、不 drain（close 抢先）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    record.status = "closed";
    record.closedReason = "user-close";
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    // 成功形态应答（close 抢先后的迟到应答）
    cont.onRunSettled(makeOutcome({ content: "late" }));
    expect(calls.finalized.length).toBe(0);
    expect(calls.routed.length).toBe(0);
    expect(calls.notified.length).toBe(0);
    expect(cont.pendingCount).toBe(0);

    // 失败形态应答（迟到）同样 early-return
    cont.onRunSettled(makeOutcome({ content: "", error: "late failure" }));
    expect(calls.finalized.length).toBe(0);
    expect(calls.notified.length).toBe(0);
  });

  it("close 语义（abortAndClearQueue）→ abort 在途 + 清空队列（终态化由 host.closeNow 承接）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const signal = calls.dispatched[0]!.signal;
    cont.onMessage("queued during round");

    cont.abortAndClearQueue();

    expect(signal.aborted).toBe(true);
    expect(cont.pendingCount).toBe(0);
    expect(record.status).toBe("running"); // 终态化归 closeNow（编排方调用）
  });
});

describe("ConversationContinuation — 轮末分流（D7）与通知面", () => {
  it("成功轮：doFinalizeRoundToIdle(success) → notifyGate 门 → route（route 晚于簿记——order 断言）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onRunSettled(makeOutcome({ content: "round text" }));

    await vi.waitFor(() => expect(calls.routed.length).toBe(1));
    expect(calls.finalized).toEqual([{ recordId: record.id, outcome: { kind: "success", content: "round text" } }]);
    const finalizeIdx = calls.order.indexOf("finalize:success");
    const routeIdx = calls.order.indexOf(`route:${record.id}`);
    expect(finalizeIdx).toBeGreaterThanOrEqual(0);
    expect(routeIdx).toBeGreaterThan(finalizeIdx); // route 晚于轮终簿记
    expect(calls.notified.length).toBe(0); // 成功通知经 route（record.result 权威），非独立载荷
  });

  it("失败轮：lastError 簿记（failed outcome）+ 独立载荷失败通知（不经 route）+ round 同样 +1（dedup 分离）", async () => {
    const record = makeRecord({ id: "sa-fail", sessionFile: "/tmp/s.jsonl", round: 1 });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onRunSettled(makeOutcome({ content: "", error: "engine_crashed: child died" }));

    await vi.waitFor(() => expect(calls.notified.length).toBe(1));
    // 失败通知：独立构造载荷（closed+failed 形态——正文 = 失败摘要 + 恢复指引）
    const notify = calls.notified[0]!;
    expect(notify.status).toBe("closed");
    expect(notify.outcome).toBe("failed");
    expect(notify.error).toContain("round did not complete: engine_crashed: child died");
    expect(notify.error).toContain("Recovery");
    expect(notify.error).toContain("action:'message'");
    // dedup key = record:round：round 已随簿记 +1 → 失败通知与上一轮成功通知 key 分离
    expect(record.round).toBe(2);
    expect(notify.round).toBe(2);
    // 不经 route(record)——其正文恒读 record.result = 前值，直接复用会以旧正文冒充失败通知
    expect(calls.routed.length).toBe(0);
    expect(calls.finalized[0]!.outcome).toEqual({ kind: "failed", reason: "engine_crashed: child died" });
  });

  it("成功分支 notifyGate 门：parent-new 编排性关闭的迟到应答不注入（route 不调）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    // 编排性关闭竞态窗（closedReason 残留于 running record 的门语义构造）
    record.closedReason = "parent-new";

    cont.onRunSettled(makeOutcome({ content: "late round" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(calls.routed.length).toBe(0); // 门拦——不注入可能已切换的 session
  });

  it("失败分支 notifyGate 门：cancelled 竞态窗不双发（cancelBackground 自行 notify）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    record.closedReason = "cancelled";

    cont.onRunSettled(makeOutcome({ content: "", error: "aborted" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(calls.notified.length).toBe(0); // 门拦——防双发
  });

  it("失败分支 notifyGate 门：parent-fork 竞态窗不注入（防僵尸回执）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    record.closedReason = "parent-fork";

    cont.onRunSettled(makeOutcome({ content: "", error: "boom" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(calls.notified.length).toBe(0);
    expect(calls.routed.length).toBe(0);
  });

  it("settle 交棒次序：onRunSettled 内 noteRoundSettledFromProtocol 先于轮终簿记（watchdog phase 观察）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    // 模拟泛化主干 arm（acquire 后挂中段——真实 arm 点在 kickOffChatRound）
    armMidRoundNoProgress(record.id, {
      onMidTimeout: () => {},
      onSettleTimeout: () => {},
    });
    expect(getSettledWatchdogPhase(record.id)).toBe("mid-round");

    // finalize mock 内观察：交棒（mid-round → settled）先于簿记
    let phaseAtFinalize: string | undefined;
    const origFinalize = host.finalizeRoundOutcome;
    const spyHost: ContinuationHost = {
      ...host,
      finalizeRoundOutcome: async (rec, outcome) => {
        phaseAtFinalize = getSettledWatchdogPhase(rec.id);
        await origFinalize(rec, outcome);
      },
    };
    const cont = new ConversationContinuation(record, spyHost);
    cont.onRunSettled(makeOutcome({ content: "text" }));

    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    expect(phaseAtFinalize).toBe("settled"); // 交棒先于簿记（watchdog 停表早于状态写）
    // 轮终簿记后两段一并清（不残留 armed——收尾段 fire 会对已收敛轮误发 kill）
    await vi.waitFor(() => expect(hasSettledWatchdog(record.id)).toBe(false));
  });

  it("成功分支不写 roundBaseTurnIndex（base 死记账退役——负向断言）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl", turnCount: 5 });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onRunSettled(makeOutcome({ content: "round text" }));

    await vi.waitFor(() => expect(calls.routed.length).toBe(1));
    // [H1 U6] base 死记账（roundBaseTurnIndex）已随字段退役——负向断言锚点改为
    // turns 记账不触碰（round 推进不携带 base 副作用）。
    expect(record.turnCount).toBe(5);
  });

  it("stale-child 兜底先于派发（红线②——killStaleChild 在 dispatch 之前的 order 断言）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("next round");

    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(calls.killStale).toEqual([record.id]);
    expect(calls.order.indexOf(`killStale:${record.id}`)).toBeLessThan(
      calls.order.indexOf(`dispatch:${record.id}`),
    );
  });

  it("watchdog fire → killRoundChild + abort 轮 signal（run 收敛后失败分支统一收口）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl" });
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    const signal = calls.dispatched[0]!.signal;

    cont.onWatchdogFire({ phase: "mid-round", waitedMs: 1000 });

    expect(calls.killedRound).toEqual([{ recordId: record.id, source: "settled watchdog (mid-round)" }]);
    expect(signal.aborted).toBe(true);
    expect(record.status).toBe("running"); // kill 本身不终态化——收口归 run 应答
  });

  it("派发前执行态信号清除（承接 resumeColdRound：result/resumable 清 + 迁移上报）", async () => {
    const record = makeRecord({ sessionFile: "/tmp/s.jsonl", round: 1 });
    record.result = "上一轮增量";
    record.resumable = true;
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);

    cont.onMessage("next");

    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    expect(record.result).toBeUndefined();
    expect(record.resumable).toBeUndefined();
    expect(calls.transitions).toEqual([record.id]);
  });

  it("[A2] drain 守卫失败 → 不 throw（无 unhandled rejection）+ 队列丢弃失败通知 + queue 清空（锚点缺失触发链）+ 丢弃通知独立 dedup 身份过真实去重链", async () => {
    // 可达触发链：首轮在途 message 打断入队 → 首轮崩溃（合成 outcome 无 sessionFile
    // ——mock host 不回填锚点）→ 失败 settle → drain 以 firstRound=false 走锚点守卫
    // → throw。修复前 throw 逃逸 settleRoundFailed 的 void promise = unhandled
    // rejection（Node ≥15 默认崩宿主）且队列消息静默丢失。
    const record = makeRecord({ id: "sa-drain-guard" }); // sessionFile undefined（首轮未回填）
    const { host, calls } = makeHost(record);

    // 通知面接真实 notifier + ledger（生产装配形态：ContinuationHost.notifyRecord →
    // notifyHost.notify → createNotifier().notify → ledger 四步链）。纯 push mock 不过
    // 真实去重——修复前丢弃通知与同轮失败单发同 key（`id:round`）会被 ledger 幂等吞
    // （sentMessages 恒 1 条），本用例的 2 条断言即该 bug 的回归锚。
    // 元素形态 = 两列合一（ledger 写账 entry 带 data；送达落盘 entry 带 content 等，
    // 与 notify-ledger.test.ts makeLedgerHost 的 entries/sessionEntries 共享数组同构）。
    const ledgerEntries: Array<{
      type: string;
      customType: string;
      data?: unknown;
      content?: string;
      display?: boolean;
      details?: unknown;
    }> = [];
    const delivered: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
    bindNotifyLedgerHost({
      appendLedgerEntry: (customType, data) => {
        ledgerEntries.push({ type: "custom", customType, data });
      },
      readSessionEntries: () => ledgerEntries,
      isIdle: () => true,
      onAgentSettled: () => {},
      // 送达即落盘 custom_message entry（ledger 回执扫描输入，模拟 pi 落盘）。
      sendDelivery: (message) => {
        delivered.push(message);
        ledgerEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      },
    });
    const notifier = createNotifier({
      sendMessage: () => {}, // ledger 路径送达出口 = sendDelivery；本端口仅内核兜底路径消费
      hasRunningBackground: () => false,
      isIdle: () => true,
    });
    const origNotifyRecord = host.notifyRecord;
    host.notifyRecord = (n) => {
      origNotifyRecord(n);
      notifier.notify(n);
    };

    try {
      const cont = new ConversationContinuation(record, host);
      cont.startFirstRound("round 1"); // firstRound=true，无锚点守卫
      await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
      cont.onMessage("queued while running");
      expect(cont.pendingCount).toBe(1);

      // 首轮失败收敛 → settleRoundFailed 尾部 drain 触发锚点守卫 throw（修复后就地转错误面）
      cont.onRunSettled(makeOutcome({ content: "", error: "engine_crashed: child died" }));

      // 第一条 = 失败单发（既有语义）；第二条 = drain 守卫失败的队列丢弃通知
      await vi.waitFor(() => expect(calls.notified.length).toBe(2));
      const dropped = calls.notified[1]!;
      expect(dropped.status).toBe("closed");
      expect(dropped.outcome).toBe("failed");
      expect(dropped.error).toContain("queued message could not be dispatched");
      expect(dropped.error).toContain("no transcript anchor");
      // 独立 dedup 身份：与同轮失败单发 key（`id:round`）区分，避免被永久去重吞掉
      expect(dropped.dedupKey).toBe("sa-drain-guard:1:drain-drop");
      // 真实去重链上两条都可达（修复前第二条同 key 被 ledger 吞——本断言红），
      // 且第二条 notifyId 独立、正文为丢弃文案（key 独立性在投递产物上可见）
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      expect(delivered[0]!.details).toMatchObject({ notifyId: "sa-drain-guard:1" });
      expect(delivered[1]!.details).toMatchObject({ notifyId: "sa-drain-guard:1:drain-drop" });
      expect(delivered[1]!.content).toContain("queued message could not be dispatched");
      // 队列清空 + record 保持 running-resumable + 无僵尸轮派发
      expect(cont.pendingCount).toBe(0);
      expect(record.status).toBe("running");
      expect(calls.dispatched.length).toBe(1);
      // 队列丢弃留痕（warn）
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.stringContaining("queued message dispatch rejected"),
      );
    } finally {
      // dispose 摘除 ledger 模块级绑定——防泄漏到同文件后续用例
      notifier.dispose();
    }
  });

  it("[A2] drain 守卫失败 + notifyGate 门拦（cancelled 竞态窗）→ 通知不发（防双发语义一致）", async () => {
    const record = makeRecord({ id: "sa-drain-gate" });
    record.closedReason = "cancelled"; // 门拦竞态窗构造（与既有门用例同形态）
    const { host, calls } = makeHost(record);
    const cont = new ConversationContinuation(record, host);
    cont.startFirstRound("round 1");
    await vi.waitFor(() => expect(calls.dispatched.length).toBe(1));
    cont.onMessage("queued while running");
    cont.onRunSettled(makeOutcome({ content: "", error: "boom" }));

    // 失败单发被门拦（既有语义）→ drain 守卫失败的通知同被门拦：notified 恒 0
    await vi.waitFor(() => expect(calls.finalized.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.notified.length).toBe(0);
    expect(cont.pendingCount).toBe(0);
    expect(calls.dispatched.length).toBe(1);
  });
});

// ============================================================
// SubagentService 集成面（fake engine 协议替身）
// ============================================================

function makePi(): PiLike {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  } as unknown as PiLike;
}

interface ServiceInternals {
  store: RecordStore;
}

function makeService(): {
  agentDir: string;
  service: SubagentService;
  store: RecordStore;
  pi: PiLike;
  fake: FakePiEnginePort;
} {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cont-integration-"));
  clearEngines();
  const fake = registerFakePiEngine();
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  // execute() 路径的 pi 链三层解析需要 registry（首轮派发用例消费）
  modelService.initModel({
    modelRegistry: { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true },
    sessionId: "root-session",
    ctxModel: { id: "m", name: "M", provider: "prov", reasoning: false },
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  service.initSession({ pi, sessionId: "root-session" });
  const store = (service as unknown as ServiceInternals).store;
  return { agentDir, service, store, pi, fake };
}

/** chatMode 续聊 record（首轮已完成，等待续聊）。 */
function makeChatRecord(id: string, agentDir: string): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "prov/model-1",
    thinkingLevel: "low",
    mode: "background",
    task: "initial task",
    slug: "cont",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: true,
    controller: new AbortController(),
  });
  record.status = "running";
  record.round = 1;
  record.sessionFile = path.join(agentDir, `${id}-session.jsonl`);
  fs.writeFileSync(record.sessionFile, "{}\n", "utf-8");
  return record;
}

describe("集成：chat 轮末分流（D7）——成功轮 / 失败轮 / 空正文兜底", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("成功轮：round+1 + result = 本轮 content + route 晚于簿记（次序断言）+ record 保持 running-resumable", async () => {
    const record = makeChatRecord("sa-round-ok", agentDir);
    store.register(record);
    const routeOrder: string[] = [];
    const coord = (service as unknown as {
      collectCoordinator: { route(r: ExecutionRecord): unknown };
    }).collectCoordinator;
    const storeSpy = vi.spyOn(store, "reportRecordTransition");
    const original = coord.route.bind(coord);
    Object.assign(coord, {
      route: (r: ExecutionRecord) => {
        routeOrder.push(`route:round=${r.round}`);
        original(r);
      },
    });

    await service.chatActions.deliverChatMessage(record, "round two");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "round two reply" });

    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.result).toBe("round two reply");
    // route 晚于轮终簿记（簿记 = reportRecordTransition 携带新 round；route 观察到 round=2）
    expect(storeSpy).toHaveBeenCalled();
    expect(routeOrder).toEqual(["route:round=2"]);
  });

  it("空 content 成功轮 → result = '(no output this round)'，lastError 不混入正文（D7 ⑤）", async () => {
    const record = makeChatRecord("sa-round-empty", agentDir);
    record.lastError = "stale engine_crashed: previous failure";
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "again");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "" });

    await vi.waitFor(() => expect(record.round).toBe(2));
    expect(record.result).toBe("(no output this round)");
    expect(record.result).not.toContain("stale engine_crashed");
  });

  it("失败轮：round 同样 +1 + result = 前值 ?? 失败摘要 + lastError 写入 + 失败通知单发（正文带失败摘要与恢复指引）", async () => {
    const record = makeChatRecord("sa-round-fail", agentDir);
    record.result = "first round output"; // 前值（有最后成功正文则保留）
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "round two");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.settle({ content: "", error: "engine_round_crashed: child died", exitCode: null });

    await vi.waitFor(() => expect(record.round).toBe(2));
    // D7 失败轮写入规则：result = 前值 ?? 失败摘要。Continuation 主链轮始已清
    // result（执行态信号清除承接 resumeColdRound——isStreaming 语义），前值分支
    // 不可达 → 失败摘要；lastError 写失败原因
    expect(record.result).toBe("round did not complete: engine_round_crashed: child died");
    expect(record.lastError).toBe("engine_round_crashed: child died");
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    // 失败通知：独立载荷（正文 = 失败摘要 + 恢复指引），dedup key = id:2
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ content?: string; details?: { notifyId?: string; round?: number } }]
    >;
    const content = calls[0]?.[0]?.content ?? "";
    expect(content).toContain("failed");
    expect(content).toContain("round did not complete: engine_round_crashed: child died");
    expect(content).toContain("Recovery");
    const details = calls[0]?.[0]?.details as { notifyId?: string } | undefined;
    expect(details?.notifyId).toBe(`${record.id}:2`);
    // 失败通知不经 route(record)——route 零调用（防旧正文冒充失败通知）。
    // [H1 U6] roundBaseTurnIndex 负向断言随 base 死记账字段退役删除。
  });

  it("首轮失败（无前值）→ result = 失败摘要（非 undefined——renderer hasRunning 判据保持）", async () => {
    const handle = await service.execute({ task: "first round", slug: "t", conversation: true });
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.fail(new Error("spawn prepare failed: model not available"));

    const record = store.getMutable(handle.subagentId);
    await vi.waitFor(() => expect(record?.resumable).toBe(true));
    expect(record?.status).toBe("running");
    expect(record?.result).toBe("round did not complete: spawn prepare failed: model not available");
    expect(record?.result).toBeDefined();
    // 失败通知单发
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
  });
});

describe("集成：close 抢先（S7）与 closeAfterRound 退役（D4 close = abort + 清队列 + 立即终态化）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("轮在途 close(force:false) → 立即终态化 closed/user-close + notifyClosed + 无挂起标志（closeAfterRound 退役）", async () => {
    const record = makeChatRecord("sa-close-mid", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    await service["closeSubagent"](record, false);

    // D4：close = abort 在途 + 立即终态化（不等轮终——closeAfterRound 挂起标志退役）
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect(record.closeAfterRound).toBeUndefined();
    // notifyClosed 送达（正文空串占位 + totalRounds）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    // 迟到的轮终应答：onRunSettled 整体 early-return——无回滚、无追加通知、无 drain
    const notifyCountAfterClose = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    fake.runs[0]!.settle({ content: "late round text" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect((pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      notifyCountAfterClose,
    );
    // 队列消息被 close 清空（close 前到达的排队消息不派发）
    await service.chatActions.deliverChatMessage(record, "after close").catch(() => {});
    expect(fake.runs.length).toBe(1); // 无僵尸轮
  });

  it("close 抢先后队列消息不派发、Continuation 实例随终态化清理", async () => {
    const record = makeChatRecord("sa-close-queue", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    // 在途轮打断入队
    await service.chatActions.deliverChatMessage(record, "queued msg");
    const conts = (service as unknown as { continuations: Map<string, { pendingCount: number }> }).continuations;
    expect(conts.get(record.id)?.pendingCount).toBe(1);

    await service["closeSubagent"](record, false);

    expect(record.status).toBe("closed");
    // [H1 U2] Continuation 实例随终态化清理（onRecordFinalizedCleanup 汇聚点——
    // closeChatIdle → doFinalizeRecord → onFinalized）
    expect(conts.has(record.id)).toBe(false);
    fake.runs[0]!.settle({ content: "late" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.runs.length).toBe(1); // 队列已清——无 drain 派发
  });
});

describe("集成：one-shot（非 chatMode）settleOneShotOutcome 四分支零变化回归（G3）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    ({ agentDir, service, store } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeOneShotRecord(id: string): ExecutionRecord {
    const record = createRecord(id, {
      agent: "general-purpose",
      model: "prov/model-1",
      mode: "background",
      task: "t",
      slug: "oneshot",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    store.register(record);
    return record;
  }

  async function settleOneShot(
    record: ExecutionRecord,
    result: { text: string; success: boolean; error?: string },
    aborted: boolean,
  ): Promise<void> {
    await (
      service as unknown as {
        settleOneShotOutcome: (
          r: ExecutionRecord,
          result: { text: string; success: boolean; error?: string },
          aborted: boolean,
        ) => Promise<void>;
      }
    ).settleOneShotOutcome(record, result as never, aborted);
  }

  it("分支①：成功（无挂起）→ doFinalizeRoundToIdle 保持 running-resumable（SP-5——成功轮不终态化）", async () => {
    const record = makeOneShotRecord("sa-oneshot-ok");
    await settleOneShot(record, { text: "done text", success: true }, false);
    expect(record.status).toBe("running");
    expect(record.resumable).toBe(true);
    expect(record.result).toBe("done text");
    expect(record.closedReason).toBeUndefined();
  });

  it("分支②：成功 + closeAfterRound → 消费挂起标志终态化 closed/user-close", async () => {
    const record = makeOneShotRecord("sa-oneshot-close");
    record.closeAfterRound = true;
    await settleOneShot(record, { text: "done", success: true }, false);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("user-close");
    expect(record.closeAfterRound).toBeUndefined();
  });

  it("分支③：失败 + closeAfterRound → 消费挂起标志终态化 closed/gc（含本轮 result）", async () => {
    const record = makeOneShotRecord("sa-oneshot-fail-close");
    record.closeAfterRound = true;
    await settleOneShot(record, { text: "", success: false, error: "boom" }, false);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
    expect(record.closeAfterRound).toBeUndefined();
  });

  it("分支④：失败/取消（无挂起）→ doFinalizeRecord 终态化 closed", async () => {
    const record = makeOneShotRecord("sa-oneshot-fail");
    await settleOneShot(record, { text: "", success: false, error: "boom" }, false);
    expect(record.status).toBe("closed");
    expect(record.closedReason).toBe("gc");
  });
});

describe("集成：引擎死亡 → Continuation 单发失败通知（D8 监督豁免维持回归）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("chatMode 轮 run reject（engine_crashed）→ 失败通知单发 + record 保持 running-resumable（不走监督器接管）", async () => {
    const record = makeChatRecord("sa-engine-death", agentDir);
    store.register(record);
    const adoptSpy = vi.spyOn(
      (service as unknown as { roundSupervisor: { adoptOnProcessDeath: (r: ExecutionRecord, m: string) => void } })
        .roundSupervisor,
      "adoptOnProcessDeath",
    );

    await service.chatActions.deliverChatMessage(record, "risky round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    fake.runs[0]!.fail(
      Object.assign(new Error("engine process exited unexpectedly: signal SIGKILL"), {
        name: "EngineSdkError",
      }),
    );

    // MF-6：record 保持 running-resumable（容器不被销毁——用户再 message 自动 resume）
    await vi.waitFor(() => expect(record.resumable).toBe(true));
    expect(record.status).toBe("running");
    // D8 豁免维持：chatMode 不进监督域接管链（adopt 调用 gate = chatMode !== true）
    expect(adoptSpy).not.toHaveBeenCalled();
    // 单发：Continuation 失败通知恰一条（不存在 supervisor merged notice 双发面）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ content?: string }]
    >;
    expect(calls[0]?.[0]?.content).toContain("engine process exited unexpectedly");
  });
});

describe("集成：stale-child 派发前兜底（红线②）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    vi.useRealTimers();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("镜像在途子进程活着 → kill 记账 + 协议 cancel + 有界退出窗后派发（无活项 = 直接派发）", async () => {
    const record = makeChatRecord("sa-stale-child", agentDir);
    store.register(record);
    // 模拟上一轮子进程滞留（引擎存活期状态错配——Continuation 无在途 run 但镜像有活项）
    registerSpawnedChildForRecord(record.id, { pid: 999999, killed: false } as never);

    await service.chatActions.deliverChatMessage(record, "next round");

    // kill 记账（镜像置死——[H1 U6] 协议 cancel 帧随 interact 面退役，真实杀链 =
    // 轮级 abort signal → cancel 帧 + 引擎轮末收割）
    expect(killChildSpy).toHaveBeenCalledWith(record.id, "stale-child guard (dispatch)");
    // 有界退出窗（STALE_CHILD_EXIT_WAIT_MS=300ms）后派发——双写窗收敛
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    expect(fake.runs[0]!.task.prompt).toBe("next round");
  });

  it("镜像无活项 → 派发不经兜底窗（无 kill、无 cancel）", async () => {
    const record = makeChatRecord("sa-no-stale", agentDir);
    store.register(record);

    await service.chatActions.deliverChatMessage(record, "next round");

    expect(killChildSpy).not.toHaveBeenCalledWith(record.id, "stale-child guard (dispatch)");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
  });
});

describe("集成：[A1] one-shot（非 chatMode）pi background 轮楔死熔断回归（G3 行为零变化恢复）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let pi: PiLike;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    vi.restoreAllMocks();
    killChildSpy.mockClear();
    ({ agentDir, service, store, pi, fake } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("one-shot 轮 arm 恢复（轮开跑即挂中段守护）+ fire → kill + abort + 终态化 closed/gc + 失败通知单发", async () => {
    // 测试注入秒级窗（M6 seam）——fire 走真实 timer 全链（arm → mid-round 到期 → 处置）。
    // 窗值须大于 vi.waitFor 轮询间隔（50ms），保证 arm 断言先于 fire 到期。
    _setMidRoundNoProgressWindowMsForTest(120);
    const handle = await service.execute({ task: "wedged task", slug: "oneshot-wedge" });
    const record = store.getMutable(handle.subagentId);
    expect(record).toBeDefined();
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));

    // arm 恢复断言（回归锚点：H1 重构曾误删——修复前本断言红，楔死 run 无恢复计时）
    await vi.waitFor(() => expect(hasSettledWatchdog(record!.id)).toBe(true));
    expect(getSettledWatchdogPhase(record!.id)).toBe("mid-round");

    // fire（在途 run 永悬 = 楔死形态）→ 处置：kill + abort 轮 signal + CAS 终态化
    await vi.waitFor(() => expect(record!.status).toBe("closed"));
    expect(record!.closedReason).toBe("gc");
    expect(killChildSpy).toHaveBeenCalledWith(record!.id, "settled watchdog (one-shot)");
    expect(record!.controller?.signal.aborted).toBe(true);
    // 终态失败文案（旧 onHotPathSettledWatchdogTimeout 非 chatMode 分支同文——含恢复指引）
    expect(record!.error).toContain("subagent did not reach agent_settled");
    expect(record!.error).toContain("settled watchdog");
    expect(record!.error).toContain("Recovery");
    // 失败通知发出（独立载荷过 notifyGate 门 → notifyHost.notify）
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const calls = (pi.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ content?: string; details?: { notifyId?: string; outcome?: string } }]
    >;
    expect(calls[0]?.[0]?.content).toContain(`Subagent "general-purpose" (${record!.id}) failed`);
    expect(calls[0]?.[0]?.content).toContain("settled watchdog");
    expect(calls[0]?.[0]?.content).toContain("Recovery");
    expect(calls[0]?.[0]?.details?.outcome).toBe("failed");
  });

  it("chat 轮路径零变化：continuation 轮 arm 仍走 onWatchdogFire（fire 不触发 one-shot 处置）", async () => {
    _setMidRoundNoProgressWindowMsForTest(300);
    const record = makeChatRecord("sa-chat-wedge", agentDir);
    store.register(record);
    await service.chatActions.deliverChatMessage(record, "long round");
    await vi.waitFor(() => expect(fake.runs.length).toBe(1));
    await vi.waitFor(() => expect(hasSettledWatchdog(record.id)).toBe(true));

    // fire → Continuation.onWatchdogFire（kill + abort，收口归 run 应答）——record 不终态化
    await vi.waitFor(() => expect(killChildSpy).toHaveBeenCalledWith(record.id, "settled watchdog (mid-round)"));
    // abort 的是轮级 signal（run ctx.signal——引擎侧杀链驱动），非 record 级 controller
    expect(fake.runs[0]!.ctx.signal?.aborted).toBe(true);
    expect(record.status).toBe("running");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("集成：[A5] D5 gate 判定本体直测（canUpgradeToConversation——此前仅被 mock）", () => {
  let agentDir: string;
  let service: SubagentService;

  beforeEach(() => {
    ({ agentDir, service } = makeService());
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    _resetLifecycleState();
    _resetSettledWatchdogsForTest();
    _resetCoreSpawnedChildrenMirrorForTest();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("registry 注册 engine capabilities.conversation='unsupported' 的 stub → false", () => {
    const fake = registerFakePiEngine();
    const caps = { ...fake.capabilities(), conversation: "unsupported" as const };
    registerEngine("stub-unsupported", () => ({ id: "stub-unsupported", capabilities: () => caps }) as never);

    expect(service.canUpgradeToConversation({ engine: "stub-unsupported" })).toBe(false);
  });

  it("引擎未注册 → fail-closed false（catch 分支）；engine 缺省 → 默认引擎（pi conversation=native）放行", () => {
    expect(service.canUpgradeToConversation({ engine: "no-such-engine" })).toBe(false);
    expect(service.canUpgradeToConversation({})).toBe(true);
  });
});
