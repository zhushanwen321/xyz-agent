/**
 * Golden snapshot 固化测试：记录 notifier.buildLlmContent 在各种输入下的输出。
 *
 * 此测试在迁移**前**运行并固化结果——迁移后必须逐字节一致（G4）。
 *
 * 这些测试直接测试 BgNotifier 的输出内容，不涉及 send/handle 机制，
 * 因此迁移后应通过内核装配 + 同一 buildLlmContent 产生相同输出。
 */
import { describe, expect, it } from "vitest";
import { createNotifier, type BgNotifyRecord, type NotifierHost, buildLlmContent } from "../notifier.ts";

/** 创建 mock host，notifier 会立即 flush（hasRunningBackground=false）。 */
function makeMockHost(): NotifierHost {
  return {
    sendMessage: () => {},
    hasRunningBackground: () => false,
    isIdle: () => true,
  };
}

/**
 * 调用 notifier.notify 并捕获 sendMessage 的 content 参数。
 * 前置条件：hasRunningBackground=false → notify 立即 flush。
 */
function captureNotificationContent(record: BgNotifyRecord): string {
  let capturedContent = "";
  const host: NotifierHost = {
    sendMessage: (msg) => {
      capturedContent = (msg as { content: string }).content;
    },
    hasRunningBackground: () => false,
    isIdle: () => true,
  };
  const notifier = createNotifier(host);
  notifier.notify(record);
  notifier.dispose();
  return capturedContent;
}

describe("U3_UNIT notifier golden snapshots (pre-migration freeze)", () => {
  it("single closed success — one-shot completed notification", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-7",
      status: "closed",
      agent: "worker",
      result: "done",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "worker" (sa-ptr-7) completed. Result:\ndone');
  });

  it("single closed + sessionFile — pointer line appended", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-2",
      status: "closed",
      agent: "w",
      result: "final result",
      sessionFile: "/tmp/sessions/child-2.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      'Subagent "w" (sa-ptr-2) completed. Result:\nfinal result\n\nFull transcript: /tmp/sessions/child-2.jsonl',
    );
  });

  it("single running round (chatMode) — round notification", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-4",
      status: "running",
      agent: "w",
      round: 2,
      result: "round2 text",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-4) finished a round. Reply:\nround2 text');
  });

  it("single running round + sessionFile — pointer appended to round notification", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-1",
      status: "running",
      agent: "w",
      round: 1,
      result: "round1 text",
      sessionFile: "/tmp/sessions/child-1.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      'Subagent "w" (sa-ptr-1) finished a round. Reply:\nround1 text\n\nFull transcript: /tmp/sessions/child-1.jsonl',
    );
  });

  it("single cancelled — cancelled message, no pointer", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-5",
      status: "closed",
      closedReason: "cancelled",
      agent: "w",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-5) cancelled.');
  });

  it("single gc-failed — error message, no pointer", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-6",
      status: "closed",
      closedReason: "gc",
      agent: "w",
      error: "spawn EPIPE",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-6) failed: spawn EPIPE');
  });

  it("single gc-failed + patchFile — failed takes priority, no patch hint", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-8",
      status: "closed",
      closedReason: "gc",
      agent: "w",
      error: "spawn EPIPE",
      patchFile: "/tmp/patches/sa-ptr-8.patch",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe('Subagent "w" (sa-ptr-8) failed: spawn EPIPE');
  });

  it("single closed + patchFile + sessionFile — patch hint + pointer", () => {
    const content = captureNotificationContent({
      id: "sa-ptr-3",
      status: "closed",
      agent: "w",
      result: "did work",
      patchFile: "/tmp/patches/sa-ptr-3.patch",
      sessionFile: "/tmp/sessions/child-3.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toContain("git apply /tmp/patches/sa-ptr-3.patch");
    expect(content.endsWith("\n\nFull transcript: /tmp/sessions/child-3.jsonl")).toBe(true);
  });

  it("closed + totalRounds — chatMode close with round stats", () => {
    const content = captureNotificationContent({
      id: "sa-rounds-1",
      status: "closed",
      agent: "w",
      totalRounds: 3,
      result: "",
      sessionFile: "/tmp/sessions/child-rounds.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      "Subagent \"w\" (sa-rounds-1) completed after 3 rounds. Result:\n\n\nFull transcript: /tmp/sessions/child-rounds.jsonl",
    );
  });

  it("closed no totalRounds — one-shot, no round stats", () => {
    const content = captureNotificationContent({
      id: "sa-rounds-2",
      status: "closed",
      agent: "w",
      result: "done",
      sessionFile: "/tmp/sessions/child-oneshot.jsonl",
      startedAt: 1,
      endedAt: 2,
    });
    expect(content).toBe(
      'Subagent "w" (sa-rounds-2) completed. Result:\ndone\n\nFull transcript: /tmp/sessions/child-oneshot.jsonl',
    );
  });
});

describe("notifier golden — batch merge (60s window, two records)", () => {
  it("two closed records joined with separator", () => {
    let capturedContent = "";
    let capturedDetails: unknown;
    const host: NotifierHost = {
      sendMessage: (msg) => {
        capturedContent = (msg as { content: string }).content;
        capturedDetails = (msg as { details: unknown }).details;
      },
      hasRunningBackground: () => true, // true → 合批窗口激活
      isIdle: () => true,
    };
    const notifier = createNotifier(host);

    // 两条通知入队（不立即 flush——hasRunningBackground=true）
    notifier.notify({
      id: "batch-1", status: "closed", agent: "w1", result: "result1",
      startedAt: 1, endedAt: 2,
    });
    notifier.notify({
      id: "batch-2", status: "closed", agent: "w2", result: "result2",
      startedAt: 3, "endedAt": 4,
    });

    // 手动 flush（模拟窗口到期）
    notifier.flushPendingNotifications();

    expect(capturedContent).toBe(
      'Subagent "w1" (batch-1) completed. Result:\nresult1\n\n---\n\nSubagent "w2" (batch-2) completed. Result:\nresult2',
    );
    // details 结构
    expect(capturedDetails).toMatchObject({ batch: true });
    expect(Array.isArray((capturedDetails as { items: unknown[] }).items)).toBe(true);

    notifier.dispose();
  });
});
