// src/execution/__tests__/notify-ledger.test.ts
//
// T4③ 重投止损（PS-6）单测族：回执确认不可达时 attempts 上限 + 放弃终态
// （设计 docs/design/subagent-core-unbounded-wait-audit.md §7.2 T4③ / §8.2 S-E）。
//
// 覆盖验收面：
//   - ①回执不可匹配 → 重投至 NOTIFY_REDELIVERY_MAX_ATTEMPTS → 放弃：
//     abandoned 终态 entry 落盘 + warn 含 subagent 标识与 subagents action:"list"
//     恢复指引，此后零重投（同一条完成通知不无限唤醒 LLM）
//   - ②放弃条目跨重启不复活：recoverFromSession 跳过 abandoned 差集，
//     同 notifyId record 幂等拒绝，后续 watchdog/settled 零投递
//   - ③未达上限时正常重投行为不变：照常超时重投，回执到达后照常销账
//   - 放弃终态持久化的 compaction 补写：abandoned entry 被清除后按内存态补写
//
// 全族 fake timers（看门狗 120s 周期）；warn 断言经 configureCore 日志 sink 捕获
// （core logger facade 动态解析宿主实现，见 agents-assembly.test.ts 同款）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNotifyLedger,
  NOTIFY_ABANDONED_CUSTOM_TYPE,
  NOTIFY_ACK_CUSTOM_TYPE,
  NOTIFY_LEDGER_CUSTOM_TYPE,
  NOTIFY_REDELIVERY_MAX_ATTEMPTS,
  NOTIFY_WATCHDOG_MS,
  _resetNotifyLedgerForTest,
  type NotifyLedgerHost,
} from "../notify-ledger.ts";
import { configureCore, resetCoreForTests } from "../../core/host-services.ts";

// ─── mock host ─────────────────────────────────────────────

interface LedgerHostMock {
  host: NotifyLedgerHost;
  /** 追加的 plain custom entry（ledger/ack/abandoned 三列，含 customType）。与
   *  sessionEntries 共享同一数组——送达 custom_message entry 也会落入（无 data 字段）。 */
  entries: { type: string; customType: string; data?: Record<string, unknown> }[];
  /** session entries 视图（回执扫描 + 恢复扫描的输入；与 entries 共享同一数组）。 */
  sessionEntries: unknown[];
  /** 送达消息（sendDelivery 调用）。 */
  sentMessages: { customType: string; content: string; display: boolean; details?: unknown }[];
  /** settled 边沿回调（测试手动触发模拟 pi agent_settled 事件）。 */
  settledHandlers: Array<() => void>;
  setIdle(idle: boolean): void;
  /** 送达是否同步落盘为 custom_message entry。false = 模拟回执不可匹配（PS-6 触发态）。 */
  deliverPersists: { value: boolean };
}

function makeLedgerHost(): LedgerHostMock {
  const entries: LedgerHostMock["entries"] = [];
  const sessionEntries: unknown[] = entries;
  const sentMessages: LedgerHostMock["sentMessages"] = [];
  const settledHandlers: Array<() => void> = [];
  const idle = { value: true };
  const deliverPersists = { value: true };
  const host: NotifyLedgerHost = {
    appendLedgerEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data: data as Record<string, unknown> });
    },
    readSessionEntries: () => sessionEntries,
    isIdle: () => idle.value,
    onAgentSettled: (handler) => {
      settledHandlers.push(handler);
    },
    sendDelivery: (message) => {
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
  };
}

/** 触发一次 settled 边沿（模拟 pi agent_settled 事件）。 */
function fireSettled(mock: LedgerHostMock): void {
  for (const handler of mock.settledHandlers) handler();
}

/** 未终态号差集：ledger entry 的 notifyId −（ack ∪ abandoned）的 notifyId。 */
function unsettledDiff(mock: LedgerHostMock): Set<string> {
  const ledgerIds = new Set<string>();
  const settled = new Set<string>();
  for (const e of mock.entries) {
    if (e.customType !== NOTIFY_LEDGER_CUSTOM_TYPE && e.customType !== NOTIFY_ACK_CUSTOM_TYPE && e.customType !== NOTIFY_ABANDONED_CUSTOM_TYPE) {
      continue;
    }
    const notifyId = e.data?.["notifyId"];
    if (typeof notifyId !== "string") continue;
    if (e.customType === NOTIFY_LEDGER_CUSTOM_TYPE) ledgerIds.add(notifyId);
    else settled.add(notifyId);
  }
  for (const id of settled) ledgerIds.delete(id);
  return ledgerIds;
}

function abandonedEntries(mock: LedgerHostMock): { data?: Record<string, unknown> }[] {
  return mock.entries.filter((e) => e.customType === NOTIFY_ABANDONED_CUSTOM_TYPE);
}

/** 从日志 sink 中取放弃 warn（区别于分桶 warn「notify delivery bucket [...]」）。 */
function abandonedWarns(logs: Array<{ level: string; message: string; data?: unknown }>): Array<{
  level: string;
  message: string;
  data?: unknown;
}> {
  return logs.filter((l) => l.level === "warn" && l.message.includes("abandoned"));
}

// ─── T4③ 重投止损（PS-6） ─────────────────────────────────

describe("NotifyLedger — T4③ 重投止损（PS-6）", () => {
  let logCalls: Array<{ level: string; component: string; message: string; data?: unknown }>;

  beforeEach(() => {
    vi.useFakeTimers();
    logCalls = [];
    configureCore({
      dataRoot: () => "/fake-notify-ledger-data-root",
      log: (level, component, message, data) => {
        logCalls.push({ level, component, message, data });
      },
    });
    _resetNotifyLedgerForTest();
  });
  afterEach(() => {
    _resetNotifyLedgerForTest();
    resetCoreForTests();
    vi.useRealTimers();
  });

  it("① 回执不可匹配 → 重投至 attempts 上限后放弃：abandoned 终态 entry + warn 含恢复指引，此后零重投", () => {
    const mock = makeLedgerHost();
    // 回执永不可匹配（模拟 compaction 清除送达 entry —— PS-6 触发态）
    mock.deliverPersists.value = false;
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-cap", "content", { notifyId: "sa-cap", id: "sa-cap", agent: "worker" });
    ledger.attemptDeliver(); // 第 1 次投递（attempts=1）
    expect(mock.sentMessages).toHaveLength(1);

    // 未达上限：每周期照常超时重投（共 4 次重投，attempts 累至上限）
    for (let i = 2; i <= NOTIFY_REDELIVERY_MAX_ATTEMPTS; i += 1) {
      vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
      expect(mock.sentMessages).toHaveLength(i);
    }
    expect(abandonedEntries(mock)).toHaveLength(0);
    expect(ledger.waitingReceiptCount()).toBe(1);

    // 第 5 个周期：attempts 已达上限仍无回执 → 放弃，不再重投
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS);
    expect(mock.sentMessages).toHaveLength(NOTIFY_REDELIVERY_MAX_ATTEMPTS); // 零新增
    // 终态 entry 落盘（与 ack 同形：{ v:1, notifyId }）
    const abandoned = abandonedEntries(mock);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.data).toEqual({ v: 1, notifyId: "sa-cap" });
    // 账面摘除：pending / waiting 归零，差集为空（ledger − ack − abandoned）
    expect(ledger.pendingCount()).toBe(0);
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(unsettledDiff(mock)).toEqual(new Set());
    // 放弃不计入 watchdogReplays 桶（该桶口径 = 实际重投条数 = 上限 − 1）
    expect(ledger.deliveryMetrics().watchdogReplays).toBe(NOTIFY_REDELIVERY_MAX_ATTEMPTS - 1);

    // warn：含 subagent 标识（agent 名）与 subagents action:"list" 恢复指引；
    // notifyId / attempts 动态值在 data（D4 约定，msg 近固定 key）
    const warns = abandonedWarns(logCalls);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.component).toBe("subagents");
    expect(warns[0]?.message).toContain("worker");
    expect(warns[0]?.message).toContain('subagents action:"list"');
    expect(warns[0]?.data).toEqual({ notifyId: "sa-cap", attempts: NOTIFY_REDELIVERY_MAX_ATTEMPTS });

    // 止损后看门狗空转：同一条通知不无限重复注入
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 3);
    expect(mock.sentMessages).toHaveLength(NOTIFY_REDELIVERY_MAX_ATTEMPTS);

    // 放弃是终态：同 notifyId 再 record 被幂等拒绝（绝不重发）
    expect(ledger.record("sa-cap", "content", { notifyId: "sa-cap" })).toBe(false);

    ledger.dispose();
  });

  it("② 放弃条目重启恢复不复活：recoverFromSession 跳过 abandoned 差集，watchdog/settled 零投递", () => {
    const mock = makeLedgerHost();
    // 模拟重启前落盘：s-gone 已放弃（ledger + abandoned 两列），s-live 未销账未放弃
    mock.sessionEntries.push(
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-gone", content: "cg", record: { notifyId: "s-gone", agent: "gone-agent" } } },
      { type: "custom", customType: NOTIFY_ABANDONED_CUSTOM_TYPE, data: { v: 1, notifyId: "s-gone" } },
      { type: "custom", customType: NOTIFY_LEDGER_CUSTOM_TYPE, data: { v: 1, notifyId: "s-live", content: "cl", record: { notifyId: "s-live" } } },
    );
    mock.setIdle(false); // busy：恢复路径的 attemptDeliver 挂 pending，隔离投递时机

    const ledger = createNotifyLedger(mock.host);
    // 仅 s-live 重放；s-gone 被放弃终态挡住
    expect(ledger.recoverFromSession()).toBe(1);
    expect(mock.sentMessages).toHaveLength(0);
    expect(ledger.pendingCount()).toBe(1);

    // 放弃号幂等拒绝（重启后 record 也不复活）
    expect(ledger.record("s-gone", "cg", { notifyId: "s-gone" })).toBe(false);

    // 看门狗多周期 + settled 边沿：s-gone 零投递
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 3);
    expect(mock.sentMessages).toHaveLength(0);
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(0);

    // 对照：idle 后 s-live 正常补投（证明差集重放本身未被破坏）
    mock.setIdle(true);
    fireSettled(mock);
    expect(mock.sentMessages).toHaveLength(1);
    expect(mock.sentMessages[0]?.details).toMatchObject({ notifyId: "s-live" });

    ledger.dispose();
  });

  it("③ 未达上限时正常重投行为不变：照常超时重投，回执到达后照常销账", () => {
    const mock = makeLedgerHost();
    // 前三轮回执不可匹配（重投路径）
    mock.deliverPersists.value = false;
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-ok", "content", { notifyId: "sa-ok", id: "sa-ok", agent: "worker" });
    ledger.attemptDeliver(); // 第 1 次投递
    expect(mock.sentMessages).toHaveLength(1);

    // 两个周期无回执 → 两次照常重投（attempts=3 < 上限），无任何放弃痕迹
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * 2);
    expect(mock.sentMessages).toHaveLength(3);
    expect(abandonedEntries(mock)).toHaveLength(0);
    expect(abandonedWarns(logCalls)).toHaveLength(0);
    expect(ledger.deliveryMetrics().watchdogReplays).toBe(2);

    // 回执恢复可达：本周期重投落盘 → settled 边沿销账（既有 at-least-once 闭环不变）
    mock.deliverPersists.value = true;
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS); // 第 3 次重投（本次落盘）
    expect(mock.sentMessages).toHaveLength(4);
    fireSettled(mock);
    expect(unsettledDiff(mock)).toEqual(new Set());
    expect(ledger.waitingReceiptCount()).toBe(0);
    expect(abandonedEntries(mock)).toHaveLength(0);

    ledger.dispose();
  });

  it("放弃终态持久化：abandoned entry 被 compaction 清除后按内存态补写，重启仍不复活", () => {
    const mock = makeLedgerHost();
    mock.deliverPersists.value = false;
    const ledger = createNotifyLedger(mock.host);

    ledger.record("sa-cp", "content", { notifyId: "sa-cp", id: "sa-cp", agent: "worker" });
    ledger.attemptDeliver();
    vi.advanceTimersByTime(NOTIFY_WATCHDOG_MS * NOTIFY_REDELIVERY_MAX_ATTEMPTS); // 达上限放弃
    expect(abandonedEntries(mock)).toHaveLength(1);

    // 模拟 compaction 只清掉 abandoned entry（ledger entry 保留）
    const idx = mock.entries.findIndex((e) => e.customType === NOTIFY_ABANDONED_CUSTOM_TYPE);
    expect(idx).toBeGreaterThanOrEqual(0);
    mock.entries.splice(idx, 1);

    // compaction 降级补写放弃终态（内存是权威）
    expect(ledger.compactionCheck()).toBe(1);
    expect(abandonedEntries(mock)).toHaveLength(1);
    ledger.dispose();

    // 重启：abandoned 在场 → 不复活不重投
    const mock2 = makeLedgerHost();
    mock2.sessionEntries.push(...mock.entries);
    mock2.setIdle(false);
    const ledger2 = createNotifyLedger(mock2.host);
    expect(ledger2.recoverFromSession()).toBe(0);
    mock2.setIdle(true);
    fireSettled(mock2);
    expect(mock2.sentMessages).toHaveLength(0);
    ledger2.dispose();
  });
});
