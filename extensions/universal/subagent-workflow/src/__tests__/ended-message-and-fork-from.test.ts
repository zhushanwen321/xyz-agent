// src/__tests__/ended-message-and-fork-from.test.ts
//
// [v8.5 A1/A2/B] 三块改动的集成测试：
//   A1 — message 拒绝文案分流（endedMessageGuard）：user-close/cancelled →「主动关闭，
//        无法续聊」；断联/自然完成/异归属 →「fork-from 可行动指引」。两种形态各有断言。
//   A2 — `.finalized` sidecar 真实 reason 读回矩阵：带 reason 用 reason / 空（旧格式）
//        兜底 disconnected（向后兼容）/ 非法内容兜底 disconnected。
//   B  — fork-from handler：正常接续（新 id + prompt 注入 + forkSource 指向源文件）、
//        cancelled 拒绝、worktree 记录拒绝、不存在 id 拒绝、本进程 running 拒绝。
//
// mock 手法对齐 get-record-for-action-restart.test.ts：mock session-runner（不 spawn
// 真子进程）+ logger；record-store / finalized-marker / tombstone-store 走真实实现
// （fixture 用临时目录写真实 .jsonl + sidecar）。
//
// 注意：本测试进程可能运行在 pi subagent 环境（PI_SUBAGENT_* env 被继承会污染
// rootSessionId 基线与 rootCwd 编码），beforeEach/afterEach 清理同 IDENTITY_ENV_KEYS。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock, rafCapture } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  // 捕获穿透到 runAndFinalize 边界的 ExecuteOptions（fork-from 语义落点的服务层验证）。
  // buildSpawnArgs 层的 forkSource → --fork 映射已有专项直测（spawn-args.test.ts），
  // 两层合成即覆盖完整链路。
  rafCapture: [] as Array<{ task: string; forkSource?: string; slugId: string; resumeSessionFile?: string }>,
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({ getLogger: () => loggerMock }));

// mock session-runner：fork-from 的 execute 链经 kickOffBackground → runAndFinalize →
// runSpawn。runSpawn 返回最小成功 AgentResult，后台收尾链可完整走完（archive + notify）。
// [v8.5 D 修正] 路径必须是 ../execution/session-runner.ts——原 "../session-runner.ts"
// 指向不存在的文件，mock 从未生效（探针实证 identity=REAL），是历史上全量套件
// 偶发挂起的真根源之一：真实 detached 链泄漏句柄让 worker 无法收敛。
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

import { writeFinalized } from "../execution/finalized-marker.ts";
import { getSubagentSessionDir } from "../execution/path-encoding.ts";
import type { RecordStore } from "../execution/record-store.ts";
import type { ExecuteOptions } from "../execution/types.ts";
import { SubagentService } from "../execution/subagent-service.ts";
import { ModelConfigService } from "../execution/model-config-service.ts";
import { forkFromHandler, messageHandler } from "../interface/subagent-actions.ts";

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
  };
}

/** 写一个最小合法 subagent session.jsonl（session header + identity entry + assistant message）。 */
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

describe("[v8.5] ended-message 分流文案 + fork-from 恢复通道", () => {
  let agentDir: string;
  let sessionsDir: string;
  let service: SubagentService;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "swf-ended-msg-"));
    sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 真实 fs 路线：execute 链在 tmp 内落盘安全。
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
    });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session-cur" });

    // 捕获穿透 runAndFinalize 边界的 ExecuteOptions（detached 链路的服务层观测点）。
    (service as unknown as { runAndFinalize: (...a: unknown[]) => Promise<unknown> }).runAndFinalize =
      ((orig: (...a: unknown[]) => Promise<unknown>) =>
        (...args: unknown[]) => {
          const opts = args[1] as ExecuteOptions;
          const record = args[0] as { id: string };
          rafCapture.push({
            task: String(opts.task),
            forkSource: opts.forkFromSessionFile,
            slugId: record.id,
            // [v8.5 D] 冷路径续写观测点：runAndFinalize 第 9 个位置参数 = resume spawn
            // 选项（args[8].sessionFile = --session 重开目标；对齐 transparent-resume 同款手法）
            resumeSessionFile: (args[8] as { sessionFile?: string } | undefined)?.sessionFile,
          });
          return orig.apply(service as unknown as object, args);
        })((service as unknown as { runAndFinalize: (...a: unknown[]) => Promise<unknown> }).runAndFinalize);
    rafCapture.length = 0;
    rafCapture.length = 0;
  });

  afterEach(async () => {
    service.dispose();
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 收尾链排空
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  });

  // ============================================================
  // A2：`.finalized` sidecar reason 读回矩阵（磁盘重建侧）
  // ============================================================

  describe("A2 finalized sidecar reason 矩阵", () => {
    it("带合法 reason 的 sidecar → 重建 closedReason 为真实值（非 gc）", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-userclose", rootSessionId: "root-session-cur" });
      writeFinalized(file, "user-close");

      const rec = service.collectRecords(50, "all").find((r) => r.id === "sa-a2-userclose");
      expect(rec?.status).toBe("closed");
      expect(rec?.closedReason).toBe("user-close");
    });

    it("parent-shutdown reason 同样读回真实值", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-shutdown", rootSessionId: "root-session-cur" });
      writeFinalized(file, "parent-shutdown");

      const rec = service.collectRecords(50, "all").find((r) => r.id === "sa-a2-shutdown");
      expect(rec?.closedReason).toBe("parent-shutdown");
    });

    it("显式 gc reason（孤儿恢复写入形态）保持 gc", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-gc", rootSessionId: "root-session-cur" });
      writeFinalized(file, "gc");

      const rec = service.collectRecords(50, "all").find((r) => r.id === "sa-a2-gc");
      expect(rec?.closedReason).toBe("gc");
    });

    it("向后兼容：旧格式空内容 sidecar → disconnected（不再误导为 gc），message 不崩", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-legacy", rootSessionId: "root-session-cur" });
      writeFinalized(file); // v8.5 前：空文件

      const rec = service.collectRecords(50, "all").find((r) => r.id === "sa-a2-legacy");
      expect(rec?.status).toBe("closed");
      expect(rec?.closedReason).toBe("disconnected");

      // [v8.5 D 升级] disconnected ∈ 可重连集 → message 不再拒绝而是透明重生，续写原文件；
      // 「向后兼容」语义保持：旧格式 sidecar 可读、行为不崩、路径可达。
      const res = await messageHandler(service, { subagentId: "sa-a2-legacy", text: "hi" });
      expect(res.response.delivered).toBe(true);
      await vi.waitFor(() => expect(rafCapture.length).toBe(1));
      expect(rafCapture[0].resumeSessionFile).toBe(file);
    });

    it("sidecar 内容非法（外部损坏/手写垃圾）→ 兜底 disconnected", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-junk", rootSessionId: "root-session-cur" });
      fs.writeFileSync(`${file}.finalized`, "some random junk", "utf-8");

      const rec = service.collectRecords(50, "all").find((r) => r.id === "sa-a2-junk");
      expect(rec?.closedReason).toBe("disconnected");
    });

    it("cancel 路径的 tombstone 优先级不变：.cancelled 存在时恒 cancelled", () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-a2-tomb", rootSessionId: "root-session-cur" });
      writeTombstone(file, "sa-a2-tomb");

      const rec = service.collectRecords(50, "all").find((r) => r.id === "sa-a2-tomb");
      expect(rec?.status).toBe("closed");
      expect(rec?.closedReason).toBe("cancelled");
    });
  });

  // ============================================================
  // A1：message 拒绝文案两形态
  // ============================================================

  describe("A1 message 拒绝文案分流", () => {
    it("形态 X：user-close 终态 →「已主动关闭」文案，不再误报 not found", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-x-close", rootSessionId: "root-session-cur" });
      writeFinalized(file, "user-close");

      const err = await messageHandler(service, { subagentId: "sa-x-close", text: "hi" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/deliberately closed by user \(closedReason: user-close\)/);
      expect(msg).toMatch(/start a new subagent/);
      // 不再给出误导性的「历史完好可接续」指引
      expect(msg).not.toMatch(/fork-from/);
      expect(msg).not.toMatch(/not found or not owned/);
    });

    it("形态 X'：cancelled 终态 → 同款「真没了」语义", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-x-cancel", rootSessionId: "root-session-cur" });
      writeTombstone(file, "sa-x-cancel");

      await expect(messageHandler(service, { subagentId: "sa-x-cancel", text: "hi" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
    });

    it("形态 Y-closed：gc 完成的 done 记录追问 → fork-from 可行动指引 + sessionFile 路径", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-y-done", rootSessionId: "root-session-cur" });
      writeFinalized(file, "gc");

      const err = await messageHandler(service, { subagentId: "sa-y-done", text: "follow up?" }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/reconnectable/);
      expect(msg).toContain(file); // 指引必须带出 history 所在文件
      expect(msg).toMatch(/fork-from/);
      expect(msg).toMatch(/sourceSubagentId/);
    });

    it("形态 Y-running：断联遗留 running 态异树记录 → 归属差异说明 + fork-from 指引", async () => {
      // 主会话重启后（新 rootSessionId），断联 record 无 sidecar → 分支 4 重建为
      // running，但 rootSessionId=旧树 → getRecordForAction 拒绝。这是原「ended
      // cannot be messaged」文案最失真的场景——它并没有结束，只是断联了。
      writeSessionJsonl(sessionsDir, { id: "sa-y-stale-running", rootSessionId: "old-root-session" });

      const err = await messageHandler(service, { subagentId: "sa-y-stale-running", text: "hi" }).catch((e: unknown) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/different session tree/);
      expect(msg).toMatch(/fork-from/);
    });

    it("找不到的 id → 原样透传 not found 文案（id 打错场景不受影响）", async () => {
      await expect(messageHandler(service, { subagentId: "sa-nonexistent", text: "hi" })).rejects.toThrow(
        /not found or not owned: sa-nonexistent/,
      );
    });
  });

  // ============================================================
  // B：fork-from 场景
  // ============================================================

  describe("B fork-from action", () => {
    it("正常接续：done 记录 → 新 id + prompt 注入引导语 + forkSource 指向源 sessionFile", async () => {
      const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src", rootSessionId: "old-root" });
      writeFinalized(sourceFile, "gc");

      const result = await forkFromHandler(service, {
        sourceSubagentId: "sa-src",
        prompt: "verify test results first",
      });

      // 返回形状：{ newSubagentId, sourceSessionFile }
      expect(result.response.newSubagentId).toBeTruthy();
      expect(result.response.newSubagentId).not.toBe("sa-src");
      expect(result.response.sourceSessionFile).toBe(sourceFile);
      expect(result.subagentId).toBe(result.response.newSubagentId);

      // prompt 注入：task = 用户指令在前 + 接续框架在后（--fork 上下文重建要求）。
      // kickOffBackground 是 detached 编排——等后台链穿过 runAndFinalize 边界再断言。
      await vi.waitFor(() => expect(rafCapture.length).toBe(1));
      expect(rafCapture[0].task).toContain("verify test results first");
      expect(rafCapture[0].task).toMatch(/inherited conversation via --fork/);
      // forkSource 透传 RunOptions（下游 buildSpawnArgs 的 --fork 映射有专项直测覆盖）
      expect(rafCapture[0].forkSource).toBe(sourceFile);

      expect((service.findRecord(result.response.newSubagentId))?.status).toBe("running");
      expect((service.findRecord(result.response.newSubagentId))?.slug).toBe("src-resumed");
    });

    it("无 prompt → 注入默认接管框架（reconstruct state 引导语）", async () => {
      const sourceFile = writeSessionJsonl(sessionsDir, { id: "sa-src2", rootSessionId: "old-root" });
      writeFinalized(sourceFile, "gc");

      await forkFromHandler(service, { sourceSubagentId: "sa-src2" });

      await vi.waitFor(() => expect(rafCapture.length).toBe(1));
      expect(rafCapture[0].task).toMatch(/taking over work/i);
      expect(rafCapture[0].task).toMatch(/already done|left unfinished/);
      expect(rafCapture[0].forkSource).toBe(path.join(sessionsDir, "sa-src2.jsonl"));
    });

    it("cancelled 源拒绝（用户主动告别，无接续通道）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-canxx", rootSessionId: "old-root" });
      writeTombstone(file, "sa-canxx");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-canxx" })).rejects.toThrow(
        /deliberately closed by user \(closedReason: cancelled\)/,
      );
      expect(rafCapture.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("worktree 记录拒绝（binding 已丢，防 cwd 回落主仓破坏隔离）", async () => {
      const file = writeSessionJsonl(sessionsDir, { id: "sa-wtxx", rootSessionId: "old-root", worktree: true });
      writeFinalized(file, "gc");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-wtxx" })).rejects.toThrow(
        /worktree isolation/,
      );
      expect(rafCapture.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("本进程 running 记录拒绝（还在跑应走 message，防双写）", async () => {
      writeSessionJsonl(sessionsDir, { id: "sa-live", rootSessionId: "root-session-cur" });
      // 冷路径重建进内存（running）→ findRecord 命中
      service.getRecordForAction("sa-live");

      await expect(forkFromHandler(service, { sourceSubagentId: "sa-live" })).rejects.toThrow(
        /still active in this process[\s\S]*action:'message'/,
      );
      expect(rafCapture.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("不存在的 id 拒绝并给 list 确认指引", async () => {
      await expect(forkFromHandler(service, { sourceSubagentId: "sa-ghost" })).rejects.toThrow(
        /No subagent record with id "sa-ghost"[\s\S]*includeFinished:true/,
      );
      expect(rafCapture.length).toBe(0); // 守卫拒绝：不进入执行链
    });

    it("缺 sourceSubagentId 入参 → 行动语言报错", async () => {
      await expect(forkFromHandler(service, {})).rejects.toThrow(/forkFromParam\.sourceSubagentId is required/);
      await expect(forkFromHandler(service, { sourceSubagentId: "  " })).rejects.toThrow(
        /forkFromParam\.sourceSubagentId is required/,
      );
    });
  });
});
