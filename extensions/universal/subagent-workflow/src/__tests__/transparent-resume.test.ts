// src/__tests__/transparent-resume.test.ts
//
// [v8.5 D] 透明重生（transparent resurrection）集成测试：
//   message action 对断联类 ended 记录（finalizedReason ∈ {'disconnected','parent-shutdown'}）
//   直接同 id 续聊——冷查放宽 + resurrectClosed 回边 + 续写原 sessionFile（不开新 JSONL）。
//
// 六类断言：
//   1. happy path：closed(disconnected) → message → 内部状态翻 running + resume 触达
//      （runAndFinalize 边界捕获，对齐 ended-message-and-fork-from.test.ts 手法）+
//      原 sessionFile 作为续写目标传递 + subagent-record entry 落盘（live/reload 视图恢复）。
//   2. rejected 四态：cancelled(tombstone) / user-close / worktree 记录 / 异进程活实例。
//   3. 空 .finalized 兼容：旧格式空文件 → disconnected → 可重生。
//   4. guard 一致性：fork-from 与 message 在 user-close 上行为一致地拒绝，各有文案断言。
//   外加：parent-shutdown 同样可重生、gc 完成记录维持 fork-from 指引不重生、
//        陈旧 .alive（软超时外）不拦截重生、resurrectClosed 单元语义、close action 维持严格。
//
// mock 手法对齐 ended-message-and-fork-from.test.ts：mock session-runner（不 spawn 真子进程）
// + logger；record-store / finalized-marker / alive-store / tombstone-store 走真实实现
// （fixture 用临时目录写真实 .jsonl + sidecar）。
//
// 注意：本测试进程可能运行在 pi subagent 环境（PI_SUBAGENT_* env 被继承会污染
// rootSessionId 基线与 rootCwd 编码），beforeEach/afterEach 清理同 IDENTITY_ENV_KEYS；
// 运行侧也应 env -u 排除泄漏变量。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock, rafCapture, chainPromises } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  // 捕获穿透到 runAndFinalize 边界的 (record.id, opts.task, resume)：resume.sessionFile
  // 是「透明重生存活后链路零改动复用」的核心观测点（冷路径 --session 续写原 jsonl），
  // model/thinkingLevel 从 record identity 复原（探针 P-10 防漂移语义的延续）。
  rafCapture: [] as Array<{
    recordId: string;
    task?: string;
    resume?: { sessionFile: string; model?: string; thinkingLevel?: string };
  }>,
  // [确定性收链] 捕获 detached runAndFinalize 的返回 promise——测试内显式 await 其结算，
  // 杜绝后台链跨用例游走与 runner 竞态（宽松挂起隔离差的机器上表现为事件循环级冻结）。
  chainPromises: [] as Array<Promise<unknown>>,
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));
vi.mock("../core/logger", () => ({ getLogger: () => loggerMock }));

vi.mock("../execution/session-runner.ts", () => ({
  runSpawn: vi.fn(async () => ({
    text: "",
    turns: 1,
    durationMs: 10,
    success: true,
    sessionId: "spawned",
    toolCalls: [],
  })),
  killAllSpawnedChildren: vi.fn(),
  getChildByRecord: vi.fn(() => undefined),
  spawnedChildren: new Map(),
}));

import { findForeignLiveInstance } from "../execution/alive-store.ts";
import { resurrectClosed } from "../execution/execution-record.ts";
import { writeFinalized } from "../execution/finalized-marker.ts";
import { getSubagentSessionDir } from "../execution/path-encoding.ts";
import type { ExecuteOptions } from "../execution/types.ts";
import { SubagentService } from "../execution/subagent-service.ts";
import { ModelConfigService } from "../execution/model-config-service.ts";
import { forkFromHandler, messageHandler, closeHandler } from "../interface/subagent-actions.ts";

/** SpawnResumeOpts 的观测投影（args[8]，仅需本测试断言的字段）。 */
type ResumeCapture = { sessionFile: string; model?: string; thinkingLevel?: string };

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

/** [确定性收链] 等待全部已触发的 detached 执行链结算（runAndFinalize 返回值）。 */
async function drainChains(): Promise<void> {
  await vi.waitFor(() => expect(chainPromises.length).toBeGreaterThan(0));
  await Promise.allSettled([...chainPromises]);
}

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 写一个最小合法 subagent session.jsonl。identity 前置 model_change/thinking_level_change——
 *  light 重建只从头两处 change entry 读 model/thinkingLevel（parseIdentityFromText 找到
 *  identity 即停），respawn 时经 record identity 复原进 SpawnResumeOpts（防漂移）。 */
function writeSessionJsonl(
  sessionsDir: string,
  identity: {
    id: string;
    rootSessionId: string;
    parentRecordId?: string;
    depth?: number;
    chatMode?: boolean;
    worktree?: boolean;
  },
): string {
  const file = path.join(sessionsDir, `${identity.id}.jsonl`);
  const startedAt = 1_700_000_000_000;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-uuid",
      timestamp: new Date(startedAt).toISOString(),
      cwd: "/tmp",
    }),
    JSON.stringify({ type: "model_change", provider: "p", modelId: "m-1" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    JSON.stringify({
      type: "custom",
      id: "id-1",
      parentId: null,
      timestamp: new Date(startedAt).toISOString(),
      customType: "subagent-identity",
      data: {
        id: identity.id,
        agent: "general-purpose",
        mode: "background",
        task: "disconnected predecessor task",
        slug: identity.id.replace(/^sa-/, ""),
        startedAt,
        rootSessionId: identity.rootSessionId,
        ...(identity.parentRecordId !== undefined ? { parentRecordId: identity.parentRecordId } : {}),
        ...(identity.depth !== undefined ? { depth: identity.depth } : {}),
        ...(identity.chatMode !== undefined ? { chatMode: identity.chatMode } : {}),
        ...(identity.worktree !== undefined ? { worktree: identity.worktree } : {}),
      },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "id-1",
      timestamp: new Date(startedAt + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "predecessor progress" }],
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: startedAt + 1000,
      },
    }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  return file;
}

function writeTombstone(sessionFile: string, id: string): void {
  fs.writeFileSync(
    `${sessionFile}.cancelled`,
    `${JSON.stringify({ id, status: "cancelled", agent: "general-purpose", startedAt: 1, endedAt: 2 })}\n`,
    "utf-8",
  );
}

/** 写 .alive marker（异进程活实例复检 fixture）。 */
function writeAliveMarker(sessionFile: string, pid: number, startedAt: number): void {
  fs.writeFileSync(
    `${sessionFile}.alive`,
    `${JSON.stringify({ pid, id: path.basename(sessionFile, ".jsonl"), startedAt })}\n`,
    "utf-8",
  );
}

describe("[v8.5 D] 透明重生：ended 记录同 id 续写原 session", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-transparent-resume-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    pi = makePi();
    service.initSession({ pi, sessionId: "root-session-cur" });

    // 捕获穿透 runAndFinalize 边界的参数（detached 链路的服务层观测点，args[8]=resume）。
    (service as unknown as { runAndFinalize: (...a: unknown[]) => Promise<unknown> }).runAndFinalize =
      ((orig: (...a: unknown[]) => Promise<unknown>) =>
        (...args: unknown[]) => {
          const opts = args[1] as ExecuteOptions;
          const record = args[0] as { id: string };
          rafCapture.push({
            recordId: record.id,
            task: opts.task === undefined ? undefined : String(opts.task),
            resume: args[8] as ResumeCapture | undefined,
          });
          const chained = orig.apply(service as unknown as object, args);
          if (chained instanceof Promise) chainPromises.push(chained);
          return chained;
        })((service as unknown as { runAndFinalize: (...a: unknown[]) => Promise<unknown> }).runAndFinalize);
    rafCapture.length = 0;
    chainPromises.length = 0;
  });

  afterEach(async () => {
    service.dispose();
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 收尾链排空
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  // ============================================================
  // 1. happy path：closed(disconnected) → 同 id 重生续写原文件
  // ============================================================

  describe("happy path", () => {
    it("closed(disconnected) 记录 message → 内部状态翻 running + resume 触达 + 原 sessionFile 作为续写目标", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-happy", rootSessionId: "root-session-cur" });
      writeFinalized(file, "disconnected");
      expect(service.findRecord("sa-d-happy")).toBeUndefined(); // 前置：内存无

      const result = await messageHandler(service, { subagentId: "sa-d-happy", text: "continue the work" });
      expect(result.response.delivered).toBe(true);
      // 不开新 JSONL：sessions 目录仍只有原文件一个
      expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))).toEqual([
        "sa-d-happy.jsonl",
      ]);

      // 内部状态翻 running（resurrect 回边生效；轮次收尾链走完后为 running-resumable，round=1）
      await vi.waitFor(() => {
        const snap = service.findRecord("sa-d-happy");
        expect(snap?.status).toBe("running");
        expect(snap?.sessionFile).toBe(file); // 身份字段复原：原 session 文件
      });
      const snap = service.findRecord("sa-d-happy");
      expect(snap?.chatMode).toBe(true);

      // 收链：本轮 detached runAndFinalize 在用例内结算（防跨用例竞态）
      await drainChains();

      // resume 触达：原 sessionFile 作为 --session 续写目标传递；model/thinkingLevel 从
      // record identity 复原（fixture 的 model_change/thinking_level_change entry）。
      expect(rafCapture.length).toBe(1);
      expect(rafCapture[0].recordId).toBe("sa-d-happy");
      expect(rafCapture[0].task).toBe("continue the work");
      expect(rafCapture[0].resume?.sessionFile).toBe(file);
      expect(rafCapture[0].resume?.model).toBe("p/m-1");
      expect(rafCapture[0].resume?.thinkingLevel).toBe("high");

      // subagent-record entry 落盘（register/reportRecordTransition）→ live/reload 视图恢复。
      const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
      expect(entries.length).toBeGreaterThan(0);
      const lastEntry = entries[entries.length - 1][1] as { status?: string; resumable?: boolean; round?: number };
      expect(lastEntry.status).toBe("running");

      // 重生后的死因语义位已清（不再是 closed 态残留）
      expect(snap?.closedReason).toBeUndefined();
      expect(snap?.endedAt).toBeUndefined();
    });

    it("closed(parent-shutdown) 同样可重生（可重连集第二员）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-shut", rootSessionId: "root-session-cur" });
      writeFinalized(file, "parent-shutdown");

      const result = await messageHandler(service, { subagentId: "sa-d-shut", text: "pick up where left" });
      expect(result.response.delivered).toBe(true);
      await drainChains();
      expect(rafCapture.length).toBe(1);
      expect(rafCapture[0].resume?.sessionFile).toBe(file);
    });

    it("完成后第二条完成通知 dedup key 含 round（round 从 0 重建 → key=id:1），不与终态通知互吞", async () => {
      // 结构性验证：notifier dedup key = `${id}:${round}`；重生记录 round 重建为 undefined →
      // 首轮 settle 时 onRoundSettled 推进 round=(0)+1=1 —— 与旧实例在另一进程的通知互不可见
      // （notifier 去重集随服务实例重建）。此处断言 settle 后 entry 携带 round+resumable，
      // 保证第二轮起 key 正常递增（文档化 spec 第 4 点的行为契约）。
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-notify", rootSessionId: "root-session-cur" });
      writeFinalized(file, "disconnected");

      await messageHandler(service, { subagentId: "sa-d-notify", text: "go" });
      // 收链：本轮 detached runAndFinalize 在用例内结算（防跨用例竞态）
      await drainChains();

      const entries = pi.appendEntry.mock.calls.filter((c) => c[0] === "subagent-record");
      const last = entries[entries.length - 1][1] as { round?: number; resumable?: boolean };
      expect(last.round).toBe(1);
      expect(last.resumable).toBe(true);
    });
  });

  // ============================================================
  // 2. rejected 四态：一律拒绝 + 不进入执行链 + 不注册内存
  // ============================================================

  describe("rejected 四态（红线内不走透明重生）", () => {
    it("cancelled（tombstone）→ 保持「主动关闭」拒绝文案", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-cancel", rootSessionId: "root-session-cur" });
      writeTombstone(file, "sa-d-cancel");

      await expect(messageHandler(service, { subagentId: "sa-d-cancel", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
      expect(service.findRecord("sa-d-cancel")).toBeUndefined();
      expect(rafCapture.length).toBe(0);
    });

    it("user-close → 保持「主动关闭」拒绝文案（close 正式语义完整保留）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-uclose", rootSessionId: "root-session-cur" });
      writeFinalized(file, "user-close");

      await expect(messageHandler(service, { subagentId: "sa-d-uclose", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)[\s\S]*nothing can reattach/,
      );
      expect(service.findRecord("sa-d-uclose")).toBeUndefined();
      expect(rafCapture.length).toBe(0);
    });

    it("worktree 记录 → 拒绝（binding 已丢，重生会让 spawn cwd 回落主仓）", async () => {
      const file = writeSessionJsonl(sessionsDir, {
        id: "sa-d-wt",
        rootSessionId: "root-session-cur",
        worktree: true,
      });
      writeFinalized(file, "disconnected");

      const err = await messageHandler(service, { subagentId: "sa-d-wt", text: "hi" }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/worktree isolation/);
      expect(msg).toMatch(/cannot be transparently resumed/);
      expect(service.findRecord("sa-d-wt")).toBeUndefined();
      expect(rafCapture.length).toBe(0);
    });

    it("异进程活实例（.alive + 存活 pid + 未超软超时）→ 拒绝（防双写 jsonl）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-alive", rootSessionId: "root-session-cur" });
      writeFinalized(file, "disconnected");
      writeAliveMarker(file, process.pid, Date.now()); // 本测试进程 pid 必然存活
      expect(findForeignLiveInstance(file)).toBeDefined(); // 探针前置自检

      await expect(messageHandler(service, { subagentId: "sa-d-alive", text: "hi" })).rejects.toThrow(
        /transparently resumable[\s\S]*previous instance still finishing/,
      );
      expect(service.findRecord("sa-d-alive")).toBeUndefined();
      expect(rafCapture.length).toBe(0);
    });

    it("陈旧 .alive（超过软超时）不再拦截 → 可重生（软超时判据 e2e）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-stale", rootSessionId: "root-session-cur" });
      writeFinalized(file, "disconnected");
      // pid 本身还活着（本进程），但 startedAt 已超 1h 软超时 → marker 视为陈旧
      writeAliveMarker(file, process.pid, Date.now() - 2 * 3_600_000);

      const result = await messageHandler(service, { subagentId: "sa-d-stale", text: "revive" });
      expect(result.response.delivered).toBe(true);
      await drainChains();
    });

    it("gc 完成记录（自然 done）→ 维持 fork-from 指引、不透明重生", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-gc", rootSessionId: "root-session-cur" });
      writeFinalized(file, "gc");

      await expect(messageHandler(service, { subagentId: "sa-d-gc", text: "follow up" })).rejects.toThrow(
        /reconnectable[\s\S]*fork-from/,
      );
      expect(service.findRecord("sa-d-gc")).toBeUndefined();
      expect(rafCapture.length).toBe(0);
    });
  });

  // ============================================================
  // 3. 空 .finalized 兼容：旧格式空文件 → disconnected → 可重生
  // ============================================================

  it("空 .finalized（v8.5 前旧格式）→ 磁盘重建兜底 disconnected → 透明重生成功", async () => {
    const file = writeSessionJsonl(sessionsDir, { id: "sa-d-legacy", rootSessionId: "root-session-cur" });
    writeFinalized(file); // 无 reason 参数 → 空内容文件

    // A 档兼容读：磁盘层 closedReason=disconnected
    const diskRec = service.collectRecords(50, "all").find((r) => r.id === "sa-d-legacy");
    expect(diskRec?.status).toBe("closed");
    expect(diskRec?.closedReason).toBe("disconnected");

    // D 档：message 直接重生（Y 分支文案不再触达）
    const result = await messageHandler(service, { subagentId: "sa-d-legacy", text: "legacy continues" });
    expect(result.response.delivered).toBe(true);
    await vi.waitFor(() => expect(rafCapture.length).toBe(1));
    expect(rafCapture[0].resume?.sessionFile).toBe(file);
  });

  // ============================================================
  // 4. guard 一致性：fork-from 与 message 在 user-close 上行为一致地拒绝
  // ============================================================

  describe("guard 一致性（fork-from × message 在 user-close 上）", () => {
    it("fork-from 对 user-close 源拒绝（与 message 的 X 拒绝对齐，close 语义无旁路）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-fkclose", rootSessionId: "old-root" });
      writeFinalized(file, "user-close");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-d-fkclose" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)[\s\S]*cannot be resumed or branched from/,
      );
      expect(rafCapture.length).toBe(0); // 不产生 fork 执行链
    });

    it("fork-from 对 cancelled 源拒绝（原文案升级覆盖两类）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-fkcancel", rootSessionId: "old-root" });
      writeTombstone(file, "sa-d-fkcancel");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-d-fkcancel" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
      expect(rafCapture.length).toBe(0);
    });

    it("message 对同一 user-close 记录拒绝——两边各有独立断言（文案分叉但语义一致：都拒）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-both", rootSessionId: "root-session-cur" });
      writeFinalized(file, "user-close");

      // message 侧：X 分支专属文案
      await expect(messageHandler(service, { subagentId: "sa-d-both", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)/,
      );
      // fork-from 侧：守卫 4 升级文案（含 user-close 显式列入）
      await expect(forkFromHandler(service, { sourceSubagentId: "sa-d-both" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: user-close\)[\s\S]*cannot be resumed or branched from/,
      );
      expect(rafCapture.length).toBe(0);
    });
  });

  // ============================================================
  // 回归边界：严格语义保持
  // ============================================================

  describe("回归边界", () => {
    it("close action 对断联类 ended 记录维持严格拒绝（默认无放宽）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-d-closestrict", rootSessionId: "root-session-cur" });
      writeFinalized(file, "disconnected");

      await expect(closeHandler(service, { subagentId: "sa-d-closestrict" })).rejects.toThrow(
        /not found or not owned/,
      );
      expect(service.findRecord("sa-d-closestrict")).toBeUndefined();
      expect(rafCapture.length).toBe(0);
    });

    it("resurrectClosed 单元语义：仅 closed 可翻边且清除语义位；running 体拒绝", () => {
      const closed = {
        status: "closed" as const,
        closedReason: "disconnected" as const,
        endedAt: 123,
      };
      expect(resurrectClosed(closed)).toBe(true);
      expect(closed.status).toBe("running");
      expect(closed.closedReason).toBeUndefined();
      expect(closed.endedAt).toBeUndefined();

      const running = { status: "running" as const, closedReason: undefined, endedAt: undefined };
      expect(resurrectClosed(running)).toBe(false); // 非 closed 入态防御：no-op
      expect(running.status).toBe("running");
    });
  });
});
