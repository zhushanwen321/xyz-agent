// src/execution/__tests__/notify-ledger.test.ts
//
// U2 B-ledger 单测族：通知账本与 courier 的四步生命周期
// （设计 docs/design/subagent-dispatch-reliability.md §3.3 D4/D5）。
//
// 覆盖验收面：
//   - 写账先于投递（顺序断言：appendEntry ledger entry 先于 sendMessage）
//   - settled 边沿投递 + isIdle 二次复查命中 busy 时挂回 pending
//   - 回执销账（ack entry 追加）后两列 entry 差集为空
//   - 重启恢复（新实例扫账本）重放未销账号、已销账零重发
//   - notifyId 幂等（重复 record / 重复投递条目可识别）
//   - 120s 看门狗触发（fake timers；主 session 长期无 settled 兜底 + 超时重投）
//   - 合并投递（同一边沿多条 pending 单条送达，content join + batch details）
//   - compaction 降级（ledger/ack entry 被清除后按内存态补写）
//   - session_start 恢复钩子（bindNotifyLedgerHost + recoverFromSession：
//     mock session entries 含 ledger/ack entry → 重放差集）
//   - notifier 四步接线（createNotifier + bindNotifyLedgerHost：notify → 写账 →
//     边沿投递 → 回执销账全链路）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { clearRateLimiterState, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { createDelivery } from "@xyz-agent/session-delivery";
import { configureNotifyDomain, resetNotifyDomainForTests } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import {
  bindNotifyLedgerHost,
  createNotifyLedger,
  getBoundNotifyLedger,
  NOTIFY_ACK_CUSTOM_TYPE,
  NOTIFY_CUSTOM_TYPE,
  NOTIFY_LEDGER_CUSTOM_TYPE,
  NOTIFY_WATCHDOG_MS,
  _resetNotifyLedgerForTest,
  type NotifyLedgerHost,
} from "@zhushanwen/subagent-core/execution/notify-ledger.ts";
import { createNotifier, type BgNotifyRecord, type NotifierHost } from "@zhushanwen/subagent-core/execution/notifier.ts";

// 投递内核经通知域窄端口注入（notifier 不再直接 import session-delivery）——
// 「ledger 未 bind 退回内核路径」与「U4 warn 注入」用例依赖真实内核语义
// （gate / 合批 / onSendFail warn 出口），注入真实 createDelivery 保住回归面；
// afterEach 重置防注入态泄漏。
beforeEach(() => {
  configureNotifyDomain({ createDelivery });
});
afterEach(() => {
  resetNotifyDomainForTests();
});

// ─── mock host ─────────────────────────────────────────────

interface LedgerHostMock {
  host: NotifyLedgerHost;
  /** 追加的 plain custom entry（ledger/ack 两列，含 customType）。与 sessionEntries
   *  共享同一数组——送达 custom_message entry 也会落入（无 data 字段）。 */
  entries: { type: string; customType: string; data?: Record<string, unknown> }[];
  /** session entries 视图（回执扫描 + 恢复扫描的输入；与 entries 共享同一数组）。 */
  sessionEntries: unknown[];
  /** 送达消息（sendDelivery 调用）。 */
  sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  /** settled 边沿回调（测试手动触发模拟 pi agent_settled 事件）。 */
  settledHandlers: Array<() => void>;
  setIdle(idle: boolean): void;
  /** 送达是否同步落盘为 custom_message entry（模拟 pi：triggerTurn run 结束后落盘）。
   *  false = 模拟回执延迟/丢失（消息滞留内存）。 */
  deliverPersists: { value: boolean };
  /** U4：sendDelivery 是否抛异常（模拟受理被拒——下方 sendDelivery 首行 throw）。 */
  deliveryThrows: { value: boolean };
}

function makeLedgerHost(): LedgerHostMock {
  const entries: LedgerHostMock["entries"] = [];
  const sessionEntries: unknown[] = entries;
  const sentMessages: LedgerHostMock["sentMessages"] = [];
  const settledHandlers: Array<() => void> = [];
  const idle = { value: true };
  const deliverPersists = { value: true };
  const deliveryThrows = { value: false };
  const host: NotifyLedgerHost = {
    appendLedgerEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data: data as Record<string, unknown> | undefined });
    },
    readSessionEntries: () => sessionEntries,
    isIdle: () => idle.value,
    onAgentSettled: (handler) => {
      settledHandlers.push(handler);
    },
    sendDelivery: (message) => {
      if (deliveryThrows.value) {
        throw new Error("delivery rejected (mock)");
      }
      sentMessages.push(message);
      if (deliverPersists.value) {
        sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
    },
  };
  return {
    host,
    entries,
    sessionEntries,
    sentMessages,
    settledHandlers,
    setIdle: (v: boolean) => {
      idle.value = v;
    },
    deliverPersists,
    deliveryThrows,
  };
}

/** 触发一次 settled 边沿（模拟 pi agent_settled 事件）。 */
function fireSettled(mock: LedgerHostMock): void {
  for (const handler of mock.settledHandlers) handler();
}

/** 两列 entry 差集（未销账号）：ledger entry 的 notifyId − ack entry 的 notifyId。 */
function ledgerDiff(mock: LedgerHostMock): Set<string> {
  const ledgerIds = new Set<string>();
  const acked = new Set<string>();
  for (const e of mock.entries) {
    if (e.customType !== NOTIFY_LEDGER_CUSTOM_TYPE && e.customType !== NOTIFY_ACK_CUSTOM_TYPE) continue;
    const notifyId = e.data?.["notifyId"];
    if (typeof notifyId !== "string") continue;
    if (e.customType === NOTIFY_LEDGER_CUSTOM_TYPE) ledgerIds.add(notifyId);
    if (e.customType === NOTIFY_ACK_CUSTOM_TYPE) acked.add(notifyId);
  }
  for (const id of acked) ledgerIds.delete(id);
  return ledgerIds;
}

// ─── 账本四步生命周期 ─────────────────────────────────────

describe("NotifyLedger — 四步生命周期（D4/D5）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("①→② 写账先于投递：appendEntry(ledger) 先于 sendDelivery（顺序断言）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    const recorded = ledger.record("sa-1", "content-1", { notifyId: "sa-1", id: "sa-1" });
    expect(recorded).toBe(true);
    // idle → notify 后立即投递（record 内不自投，attemptDeliver 由调用方驱动；
    // 此处显式调用验证顺序）
    ledger.attemptDeliver();

    expect(mock.sentMessages).toHaveLength(1);
    // 顺序断言：账本 entry（entries[0]）先于送达消息（sentMessages[0]）
    expect(mock.entries[0]?.customType).toBe(NOTIFY_LEDGER_CUSTOM_TYPE);
    expect(mock.sentMessages[0]?.customType).toBe(NOTIFY_CUSTOM_TYPE);
    // 单条投递形态：details = record 本体（notifyId 携带在 details，不在文案）
    expect(mock.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-1" });

    ledger.dispose();
  });

  it("② settled 边沿投递：busy 挂回 pending，isIdle 复查通过后边沿送达", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // busy：notify 后 attemptDeliver 放弃本次，消息挂回 pending
    mock.setIdle(false);
    expect(ledger.record("sa-busy", "content", { notifyId: "sa-busy" })).toBe(true);
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);

    // settled 边沿（边沿回调内 isIdle 复查）：仍 busy → 继续挂 pending
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);

    // 主 agent 空闲后的下一 settled 边沿 → 送达
    mock.setIdle(true);
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(1);
    expect(ledger.pendingCount()).toBe(0);
    expect(ledger.waitingReceiptCount()).toBe(1);

    ledger.dispose();
  });

  it("②→③ 回执销账：送达 entry 出现后下一 settled 边沿追加 ack entry，差集为空", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-ack", "content", { notifyId: "sa-ack" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);
    expect(ledgerDiff(mock)).toEqual(new Set(["sa-ack"])); // 已送达未销账

    // 下一 settled 边沿：checkReceipts 扫到 custom_message entry（sendDelivery 已
    // 模拟落盘）→ 追加 ack entry → 两列差集为空
    fireSettled(mock);
    expect(ledgerDiff(mock)).toEqual(new Set());
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(mock.entries.some((e) => e.customType === NOTIFY_ACK_CUSTOM_TYPE)).toBe(true);

    ledger.dispose();
  });

  it("③ 内存不承担销账职责：回执缺失（消息滞留内存）时不销账，差集保留", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // 模拟消息滞留内存（如竞态窗口掉进 steer 队列）：sendDelivery 不落盘
    mock.deliverPersists.value = false;
    ledger.record("sa-lost", "content", { notifyId: "sa-lost" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);

    fireSettled(mock);
    // 无 custom_message entry 回执 → 不销账（内存不销账，等看门狗重投）
    expect(ledgerDiff(mock)).toEqual(new Set(["sa-lost"]));
    expect(ledger.waitingReceiptCount()).toBe(1);

    ledger.dispose();
  });

  it("④ 重启恢复：新实例扫两列差集，未销账号重放、已销账零重发", () => {
    // 旧实例（模拟崩溃前的进程）：sa-r1/sa-r2 送达销账，sa-r3 入账未投
    const oldMock = makeLedgerHost();
    const oldLedger = createNotifyLedger(oldMock.host);
    for (const id of ["sa-r1", "sa-r2"]) {
      oldLedger.record(id, `content-${id}`, { notifyId: id });
    }
    oldLedger.attemptDeliver();
    fireSettled(oldMock);
    oldLedger.record("sa-r3", "content-sa-r3", { notifyId: "sa-r3" }); // 崩溃前未投
    expect(ledgerDiff(oldMock)).toEqual(new Set(["sa-r3"]));
    oldLedger.dispose();

    // 重启：新实例扫同一 session 文件（sessionEntries 视图保留旧 entry 列）
    const newMock = makeLedgerHost();
    newMock.sessionEntries.push(...oldMock.sessionEntries);
    const newLedger = createNotifyLedger(newMock.host);
    const replayed = newLedger.recoverFromSession();

    expect(replayed).toBe(1); // 仅未销账的 sa-r3 重放
    expect(newMock.sentMessages).toHaveLength(1);
    expect(newMock.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-r3" });
    // 已销账号零重发
    const sentIds = newMock.sentMessages.map((m) => (m.details as { notifyId?: string }).notifyId);
    expect(sentIds).not.toContain("sa-r1");
    expect(sentIds).not.toContain("sa-r2");

    newLedger.dispose();
  });

  it("④ notifyId 幂等：重复 record 同 notifyId 返回 false，不重复投递", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    expect(ledger.record("sa-dup", "content", { notifyId: "sa-dup" })).toBe(true);
    expect(ledger.record("sa-dup", "content", { notifyId: "sa-dup" })).toBe(false);

    ledger.attemptDeliver();
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1); // 至多一次

    // 销账后同 notifyId 再来（重复调用方）→ 仍幂等拒绝（已销账号绝不重发）
    fireSettled(mock);
    expect(ledger.record("sa-dup", "content", { notifyId: "sa-dup" })).toBe(false);

    ledger.dispose();
  });

  it("④ 重复投递条目可识别：批量送达 details.items 每项携带 notifyId（回执匹配）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-m1", "c1", { notifyId: "sa-m1" });
    ledger.record("sa-m2", "c2", { notifyId: "sa-m2" });
    ledger.attemptDeliver();

    expect(mock.sentMessages).toHaveLength(1); // 合并为一条
    const msg = mock.sentMessages[0]!;
    expect(msg.content).toBe("c1\n\n---\n\nc2");
    const details = msg.details as { batch: boolean; items: Array<{ notifyId?: string }> };
    expect(details.batch).toBe(true);
    expect(details.items.map((i) => i.notifyId)).toEqual(["sa-m1", "sa-m2"]);

    // 批量回执匹配：items[].notifyId 命中 → 两条全部销账
    fireSettled(mock);
    expect(ledgerDiff(mock)).toEqual(new Set());

    ledger.dispose();
  });
});

// ─── 120s 看门狗（fake timers） ───────────────────────────

describe("NotifyLedger — 120s 看门狗（D5 ②兜底触发面）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
    vi.useRealTimers();
  });

  it("主 session 长期无 settled：busy 挂起的 pending 由看门狗在空闲后补投", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    mock.setIdle(false);
    ledger.record("sa-wd1", "content", { notifyId: "sa-wd1" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(0);

    // 第一个周期仍 busy → 不投
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(0);

    // 主 agent 空闲（长期无 settled 事件）→ 下一周期看门狗补投
    mock.setIdle(true);
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(1);

    ledger.dispose();
  });

  it("超时重投：sent 后一个周期无回执（消息滞留内存丢失）→ 看门狗重投", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // 投递但不落盘（模拟 steer 滞留后丢失——回执永不到）
    mock.deliverPersists.value = false;
    ledger.record("sa-wd2", "content", { notifyId: "sa-wd2" });
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);

    // 一个周期后：无回执 → sentAt 超时转回 pending → 本 tick 重投（at-least-once）
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(2);
    expect(mock.sentMessages[1]?.details).toMatchObject({ notifyId: "sa-wd2" }); // 同 notifyId 可识别

    ledger.dispose();
  });

  it("回执正常时序不重投：送达落盘 + settled 销账后，看门狗空转零动作", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-wd3", "content", { notifyId: "sa-wd3" });
    ledger.attemptDeliver();
    fireSettled(mock); // 销账
    expect(ledgerDiff(mock)).toEqual(new Set());

    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 3);
    expect(mock.sentMessages).toHaveLength(1); // 无重投
    expect(ledgerDiff(mock)).toEqual(new Set()); // 差集保持为空

    ledger.dispose();
  });
});

// ─── U4 投递计数分桶（设计 §5 U4 × §2.2 三条丢失路径） ─────

describe("NotifyLedger — U4 投递计数分桶", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
    clearRateLimiterState();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
    setPiHandle(undefined);
    clearRateLimiterState();
  });

  it("初始快照：三桶全 0（无投递异常时零计数）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);
    expect(ledger.deliveryMetrics()).toEqual({ settleRejected: 0, watchdogReplays: 0, recoveryReplays: 0 });
    ledger.dispose();
  });

  it("②settleRejected 桶：sendDelivery 受理被拒 → +1 且消息挂回 pending；恢复后不再累计", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    mock.deliveryThrows.value = true;
    ledger.record("sa-rj", "content", { notifyId: "sa-rj" });
    ledger.attemptDeliver();

    expect(ledger.deliveryMetrics().settleRejected).toBe(1);
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1); // 挂回 pending，账未丢

    // 下一边沿受理恢复：投递成功，rejection 桶不再增长
    mock.deliveryThrows.value = false;
    ledger.attemptDeliver();
    expect(mock.sentMessages).toHaveLength(1);
    expect(ledger.deliveryMetrics().settleRejected).toBe(1);

    ledger.dispose();
  });

  it("①watchdogReplays 桶：销账超时重投按条数累计（同消息反复超时继续累计）", () => {
    vi.useFakeTimers();
    try {
      const mock = makeLedgerHost();
      const ledger = createNotifyLedger(mock.host);

      // 投递但回执永不到（消息滞留内存丢失）
      mock.deliverPersists.value = false;
      ledger.record("sa-wd", "content", { notifyId: "sa-wd" });
      ledger.attemptDeliver();
      expect(ledger.deliveryMetrics().watchdogReplays).toBe(0);

      // 第一个周期：销账超时 → 转回 pending 重投，桶 +1
      vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
      expect(mock.sentMessages).toHaveLength(2);
      expect(ledger.deliveryMetrics().watchdogReplays).toBe(1);

      // 第二个周期仍无回执：同消息再重投，桶累计到 2（滞留深度可见）
      vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
      expect(mock.sentMessages).toHaveLength(3);
      expect(ledger.deliveryMetrics().watchdogReplays).toBe(2);

      ledger.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("③recoveryReplays 桶：session_start 恢复重放条数与返回值一致，已销账零计数", () => {
    const mock = makeLedgerHost();
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a", content: "ca", record: { notifyId: "s-a" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-b", content: "cb", record: { notifyId: "s-b" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a" } },
    );

    const ledger = createNotifyLedger(mock.host);
    const replayed = ledger.recoverFromSession();

    expect(replayed).toBe(1); // s-b 未销账重放；s-a 已销账零重发
    expect(ledger.deliveryMetrics().recoveryReplays).toBe(1);

    // 再次恢复（幂等）：差集已入账，零重发零计数
    expect(ledger.recoverFromSession()).toBe(0);
    expect(ledger.deliveryMetrics().recoveryReplays).toBe(1);

    ledger.dispose();
  });

  it("分桶增量经 core logger facade 落日志（warn，msg 固定 key + 动态值在 data）", () => {
    // 共享 loggerMock 跨用例累计（同 describe 前序分桶用例也打 warn）——用例级清零，
    // 断言「本次投递失败动作」恰产生一条分桶 warn。
    loggerMock.warn.mockClear();
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    mock.deliveryThrows.value = true;
    ledger.record("sa-log", "content", { notifyId: "sa-log" });
    ledger.attemptDeliver();

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [message, data] = loggerMock.warn.mock.calls[0] as unknown as [string, { total: number; pending: number }];
    expect(message).toContain("notify delivery bucket [settleRejected]");
    expect(data).toEqual({ total: 1, pending: 1 });

    ledger.dispose();
  });
});

// ─── compaction 降级（P-B4） ───────────────────────────────

describe("NotifyLedger — compaction 降级（P-B4 未验证，条件补写）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("compaction 清除 ledger/ack entry 后按内存态补写（重建两列差集）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);

    // sa-c1 送达销账、sa-c2 入账未投
    ledger.record("sa-c1", "c1", { notifyId: "sa-c1" });
    ledger.attemptDeliver();
    fireSettled(mock);
    ledger.record("sa-c2", "c2", { notifyId: "sa-c2" });
    expect(ledgerDiff(mock)).toEqual(new Set(["sa-c2"]));

    // 模拟 compaction 清掉全部 plain custom entry（ledger/ack 两列全丢，送达
    // custom_message entry 假设保留——保守验证降级闭环）
    mock.sessionEntries.length = 0;

    const rewritten = ledger.compactionCheck();
    expect(rewritten).toBe(2); // 补写 sa-c2 的 ledger + sa-c1 的 ack
    // 补写后差集恢复：仍只有 sa-c2 未销账（sa-c1 销账事实随 ack 补写恢复）
    expect(ledgerDiff(mock)).toEqual(new Set(["sa-c2"]));

    ledger.dispose();
  });

  it("entry 存活时 compactionCheck no-op（零补写）", () => {
    const mock = makeLedgerHost();
    const ledger = createNotifyLedger(mock.host);
    ledger.record("sa-nc", "c", { notifyId: "sa-nc" });
    ledger.attemptDeliver();
    fireSettled(mock);

    expect(ledger.compactionCheck()).toBe(0);
    ledger.dispose();
  });
});

// ─── session_start 恢复钩子（bindNotifyLedgerHost） ────────

describe("bindNotifyLedgerHost — session_start 恢复钩子", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("bind + recoverFromSession：mock session 含 ledger/ack entry → 重放差集", () => {
    const mock = makeLedgerHost();
    // 预置 session 文件内容（模拟重启前的落盘）：2 条 ledger + 1 条 ack + 1 条已送达
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a", content: "ca", record: { notifyId: "s-a" } } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-b", content: "cb", record: { notifyId: "s-b" } } },
      { type: "custom", customType: NOTIFY_ACK_CUSTOM_TYPE, data: { v: 1, notifyId: "s-a" } },
      { type: "custom_message", customType: NOTIFY_CUSTOM_TYPE, content: "ca", display: true, details: { notifyId: "s-a" } },
    );

    const ledger = bindNotifyLedgerHost(mock.host);
    const replayed = ledger.recoverFromSession();

    expect(replayed).toBe(1); // s-b 未销账重放；s-a 已销账零重发
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.content).toBe("cb");
    expect(mock.sentMessages[0]?.details).toMatchObject({ notifyId: "s-b" });
  });

  it("重复 bind 替换旧实例（/resume /fork /new 的 session_start）", () => {
    const mock1 = makeLedgerHost();
    bindNotifyLedgerHost(mock1.host);
    expect(bindNotifyLedgerHost(makeLedgerHost().host)).toBeDefined();
    // 旧实例已 dispose（settled 回调静默）
    fireSettled(mock1);
    expect(mock1.sentMessages).toHaveLength(0);
  });

  it("损坏 / 形态不符 entry 跳过不 throw（无 notifyId / data 非 object）", () => {
    const mock = makeLedgerHost();
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1 } }, // 无 notifyId
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE }, // 无 data
      { type: "custom", customType: "unrelated-type", data: { notifyId: "x" } },
      null,
    );
    const ledger = bindNotifyLedgerHost(mock.host);
    expect(ledger.recoverFromSession()).toBe(0);
  });
});

// ─── notifier 四步接线（createNotifier × ledger） ─────────

describe("createNotifier — ledger 四步接线（U2）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  /** notifier 侧 mock host：sendMessage 是 ledger sendDelivery 的下游（index.ts
   *  装配 sendDelivery = pi.sendMessage({triggerTurn:true})，此处直接捕获）。 */
  function makeNotifierHost(): NotifierHost & {
    sentOptions: unknown[];
    sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  } {
    const sentOptions: unknown[] = [];
    const sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[] = [];
    return {
      sentOptions,
      sentMessages,
      sendMessage(message, options) {
        sentOptions.push(options);
        sentMessages.push(message);
      },
      hasRunningBackground: () => false,
      isIdle: () => true,
    };
  }

  function oneShotRecord(id: string, result = "done"): BgNotifyRecord {
    return { id, status: "closed", agent: "worker", result, startedAt: 1, endedAt:2 };
  }

  it("notify → 写账 → 投递 → 回执销账全链路（notifyId = id，G4 文案不变）", () => {
    const ledgerMock = makeLedgerHost();
    // sendDelivery 桥接到 notifier host.sendMessage（模拟 index.ts 装配）
    const notifierHost = makeNotifierHost();
    ledgerMock.host.sendDelivery = (message) => {
      ledgerMock.sentMessages.push(message);
      if (ledgerMock.deliverPersists.value) {
        ledgerMock.sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
      notifierHost.sendMessage(message, { triggerTurn: true });
    };
    bindNotifyLedgerHost(ledgerMock.host);

    const notifier = createNotifier(notifierHost);
    notifier.notify(oneShotRecord("sa-n1"));

    // ① 写账先于 ② 投递：ledger entry 落盘且消息已送达
    expect(ledgerMock.entries[0]?.customType).toBe(NOTIFY_LEDGER_CUSTOM_TYPE);
    expect(notifierHost.sentMessages).toHaveLength(1);
    // 单通道断言：options 只有 triggerTurn，无 deliverAs
    expect(notifierHost.sentOptions[0]).toEqual({ triggerTurn: true });
    // G4 文案锚：one-shot 完成通知逐字节不变（notifyId 不进文案）
    expect(notifierHost.sentMessages[0]?.content).toBe('Subagent "worker" (sa-n1) completed. Result:\ndone');
    // details 携带 notifyId + outcome 物化（U3）
    expect(notifierHost.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-n1", outcome: "completed" });

    // ③ 回执销账：settled 边沿 → ack entry + 差集为空
    fireSettled(ledgerMock);
    expect(ledgerDiff(ledgerMock)).toEqual(new Set());

    notifier.dispose();
  });

  it("chatMode round dedupe key 平移：notifyId = `${id}:${round}`，规则不变", () => {
    const ledgerMock = makeLedgerHost();
    const notifierHost = makeNotifierHost();
    // 桥接：ledger sendDelivery → notifier host.sendMessage（模拟 index.ts 装配）
    ledgerMock.host.sendDelivery = (message) => {
      notifierHost.sendMessage(message, { triggerTurn: true });
      if (ledgerMock.deliverPersists.value) {
        ledgerMock.sessionEntries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }
    };
    bindNotifyLedgerHost(ledgerMock.host);

    const notifier = createNotifier(notifierHost);
    notifier.notify({ id: "sa-chat", status: "running", agent: "w", round: 1, result: "r1", startedAt: 1, endedAt: 2 });
    notifier.notify({ id: "sa-chat", status: "running", agent: "w", round: 2, result: "r2", startedAt: 3, endedAt: 4 });
    // 同 id 同 round 第二次被 notifyId 幂等吞
    notifier.notify({ id: "sa-chat", status: "running", agent: "w", round: 1, result: "r1-again", startedAt: 5, endedAt: 6 });

    expect(notifierHost.sentMessages).toHaveLength(2);
    expect(notifierHost.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-chat:1" });
    expect(notifierHost.sentMessages[1]?.details).toMatchObject({ notifyId: "sa-chat:2" });
    // chatMode 轮次通知文案（running 分支）不变
    expect(notifierHost.sentMessages[0]?.content).toBe('Subagent "w" (sa-chat) finished a round. Reply:\nr1');

    notifier.dispose();
  });

  it("ledger 未 bind 时退回内核路径（向后兼容，options 仍单通道 triggerTurn）", () => {
    const notifierHost = makeNotifierHost();
    const notifier = createNotifier(notifierHost);
    notifier.notify(oneShotRecord("sa-nb"));

    expect(notifierHost.sentMessages).toHaveLength(1);
    expect(notifierHost.sentOptions[0]).toEqual({ triggerTurn: true });
    expect(notifierHost.sentMessages[0]?.content).toBe('Subagent "worker" (sa-nb) completed. Result:\ndone');

    notifier.dispose();
  });

  it("U4 warn 注入：内核路径 port.send 失败 → 警告经 core logger 出口，console.warn 零调用", () => {
    // 本文件 vi.mock 了 core/logger——notifier 的 U4 warn 出口（u0-notify 后走
    // core facade）被 mock 截到 loggerMock，host-services 层不可达，无需 configureCore。
    // U4 意图断言保持：警告落可检索通道（loggerMock = 注入出口）而非 console.warn。
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const notifierHost = makeNotifierHost();
      // sendMessage 抛异常 = port.send 同步失败 → 内核 onSendFail → warn（经注入出口）
      notifierHost.sendMessage = () => {
        throw new Error("channel closed (mock)");
      };
      const notifier = createNotifier(notifierHost);
      notifier.notify(oneShotRecord("sa-warn"));

      const sendFailLogged = loggerMock.warn.mock.calls.some(
        ([m]) => typeof m === "string" && m.includes("port.send failed"),
      );
      expect(sendFailLogged).toBe(true);
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      notifier.dispose();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("dispose 摘除模块级绑定：后续 notify 走内核路径，settled 边沿静默", () => {
    const ledgerMock = makeLedgerHost();
    bindNotifyLedgerHost(ledgerMock.host);
    const notifierHost = makeNotifierHost();
    const notifier = createNotifier(notifierHost);
    notifier.dispose();

    fireSettled(ledgerMock);
    // revive（/resume /fork /new 后）：notifier 复活，但 ledger 已随 dispose 摘除
    // ——notify 退回内核路径
    notifier.revive();
    notifier.notify(oneShotRecord("sa-post-dispose"));
    expect(notifierHost.sentMessages).toHaveLength(1); // 内核路径立即投（无 ledger）
  });
});

// ─── MF-5: settled 监听单例化 ──────────────────────────────
//
// 回归背景：index.ts:428-430 每次 session_start 注册新 pi.on("agent_settled")
// handler，旧实例 dispose 只置标志不移除物理监听（pi 0.84.1 on() 无 off）——
// 长会话 N 次切换累积 N 个死 handler。修复：bind 路径首次注册模块级单例
// handler（settledEdgeDispatch），后续 bind 只换 boundLedger 引用。

describe("MF-5: settled 监听单例化（多次 bind 物理监听数不增）", () => {
  beforeEach(() => {
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
  });

  it("连续 3 次 bind（/resume /fork /new 的 session_start）→ onAgentSettled 注册仅首次发生", () => {
    const mocks = [makeLedgerHost(), makeLedgerHost(), makeLedgerHost()];
    const registerSpies = mocks.map((mock) => {
      const spy = vi.fn();
      mock.host.onAgentSettled = spy;
      return spy;
    });

    bindNotifyLedgerHost(mocks[0]!.host);
    bindNotifyLedgerHost(mocks[1]!.host);
    bindNotifyLedgerHost(mocks[2]!.host);

    // 首次 bind 注册一次（单例 handler）；后续 bind 只换 boundLedger 引用
    expect(registerSpies[0]).toHaveBeenCalledTimes(1);
    expect(registerSpies[1]).not.toHaveBeenCalled();
    expect(registerSpies[2]).not.toHaveBeenCalled();
  });

  it("边沿分发到当前活跃实例：旧 mock 上的边沿事件驱动新 ledger 投递，旧实例零动作", () => {
    const mock1 = makeLedgerHost();
    bindNotifyLedgerHost(mock1.host);
    const mock2 = makeLedgerHost();
    bindNotifyLedgerHost(mock2.host);

    // 活跃实例（mock2 的 ledger）入账 pending
    const ledger = getBoundNotifyLedger();
    expect(ledger).toBeDefined();
    ledger!.record("sa-active", "content", { notifyId: "sa-active" });

    // 旧 mock（mock1）上触发边沿——单例 handler 分发到 boundLedger（mock2）
    fireSettled(mock1);
    expect(mock2.sentMessages).toHaveLength(1);
    expect(mock2.sentMessages[0]?.details).toMatchObject({ notifyId: "sa-active" });
    // 旧实例无动作（disposed 短路语义：不会成为分发目标）
    expect(mock1.sentMessages).toHaveLength(0);
  });

  it("活跃实例 dispose 后边沿静默（boundLedger 摘除 → 单例 handler 无分发目标）", () => {
    const mock1 = makeLedgerHost();
    bindNotifyLedgerHost(mock1.host);
    getBoundNotifyLedger()!.dispose();

    fireSettled(mock1);
    expect(mock1.sentMessages).toHaveLength(0);
  });

  it("直调 createNotifyLedger 注册行为不变（默认注册 / 显式 registerSettledListener:false 跳过）", () => {
    const mockDefault = makeLedgerHost();
    const ledgerDefault = createNotifyLedger(mockDefault.host);
    expect(mockDefault.settledHandlers).toHaveLength(1);
    ledgerDefault.dispose();

    const mockSkip = makeLedgerHost();
    const ledgerSkip = createNotifyLedger(mockSkip.host, { registerSettledListener: false });
    expect(mockSkip.settledHandlers).toHaveLength(0);
    ledgerSkip.dispose();
  });
});

// ─── 常量等值钉住（notify-ledger 与 notifier/渲染器共用字符串） ──

describe("notify-ledger 常量锚", () => {
  it("NOTIFY_CUSTOM_TYPE 与 notifier 送达 customType / ledger 回执扫描同源", async () => {
    const notifierModule = await import( "@zhushanwen/subagent-core/execution/notifier.ts");
    // notifier 模块不再自带本地常量（单一常量源 = notify-ledger）；用运行时行为钉住：
    // ledger 回执扫描匹配的 customType === notifier 送达消息的 customType。
    const mock = makeLedgerHost();
    const notifierHost: NotifierHost = {
      sendMessage: (message) => {
        mock.host.sendDelivery(message);
      },
      hasRunningBackground: () => false,
      isIdle: () => true,
    };
    const ledger = bindNotifyLedgerHost(mock.host);
    const notifier = createNotifier(notifierHost);
    notifier.notify({ id: "sa-cst", status: "closed", agent: "w", result: "r", startedAt: 1, endedAt: 2 });
    fireSettled(mock);
    // 全链路销账成功 === 三处 customType 同一字符串（否则回执扫描不命中）
    expect(ledgerDiff(mock)).toEqual(new Set());
    expect(typeof notifierModule.createNotifier).toBe("function");
    ledger.dispose();
    _resetNotifyLedgerForTest();
  });
});
