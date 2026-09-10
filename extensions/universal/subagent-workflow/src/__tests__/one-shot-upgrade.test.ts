// src/__tests__/one-shot-upgrade.test.ts
//
// SP-5 one-shot upgrade：非 chatMode active record 收到 message 时自动升级 chatMode。
//
// 场景：one-shot subagent（conversation=false）完成首轮后 record 仍在内存（running），
// LLM 调 message 续聊 → messageHandler 检测非 chatMode + active → 置 chatMode=true（upgrade）→
// 走 deliverChatMessage 统一路径（热路径 interact 受理或冷路径 resume 续轮）。
//
// [W3 改写] mock 策略：真实 SubagentService + registerFakePiEngine 协议替身
//（原 vi.mock inproc session-runner / spawnedChildren Map 语义随 inproc pi 引擎目录
// 删除消亡）。热/冷分流观测面从「mock child 存在性 / mock runSpawn 调用」换成协议 seam：
//   - 热路径 = engine.interact(message) 受理（fake 默认 {ok:true, delivered:true}）；
//   - 冷路径 = interact 拒绝 engine_session_not_resumable → resumeColdRound →
//     kickOffChatRound → engine.run（fake.runs 捕获，resume 锚点在 ctx.chat.resume）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock logger
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock( "@zhushanwen/subagent-core/core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { registerFakePiEngine, type FakePiEnginePort } from "@zhushanwen/subagent-core/testing/execution/__tests__/helpers/fake-engine-port.ts";
import { clearEngines } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { createRecord } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import { ModelConfigService } from "@zhushanwen/subagent-core";
import { RecordStore } from "@zhushanwen/subagent-core";
import { SubagentService } from "@zhushanwen/subagent-core";
import type { PiLike } from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import { messageHandler } from "../interface/subagent-actions.ts";

// [commit 前修复] 测试进程可能继承宿主（pi 子进程链）的 PI_SUBAGENT_* 身份 env：
// initSession 的 sessionRootId/execCtx 基线读 env 优先于 init.sessionId——宿主 env
// 泄漏时 cross-tree 守卫（15448af73）把本测试自建的 record 判为异树拒绝 message
//（守卫行为正确，测试缺清理）。与 subagent-core collect-mixed-dispatch.test.ts
// 同病同修：beforeEach 删五键后再 initSession（delete 不 restore，同包既有范式）。
const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

function makeTmpAgentDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-test-"));
}

function makePi(): PiLike & {
  appendEntry: ReturnType<typeof vi.fn>;
  events: { emit: ReturnType<typeof vi.fn> };
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return { appendEntry: vi.fn(), events: { emit: vi.fn() }, sendMessage: vi.fn() };
}

interface ServiceInternals {
  store: RecordStore;
  sessionRootId: string | null;
}

/** 非 chatMode background record（one-shot 模式）。 */
function makeOneShotRecord(
  sessionRootId: string,
  status: "running" = "running",
  id = "sa-oneshot",
): ExecutionRecord {
  const record = createRecord(id, {
    agent: "general-purpose",
    model: "test/test-model",
    thinkingLevel: "low",
    mode: "background",
    task: "one-shot task",
    slug: "oneshot",
    startedAt: 1000,
    rootSessionId: sessionRootId,
    // chatMode 不传 = undefined = 非 chatMode（one-shot）
  });
  record.status = status;
  record.controller = new AbortController();
  // v4 B-1：one-shot 完成后 record 为 running（idle 折入 running）+ isResumable（无活进程）。
  // sessionFile 总设（冷路径 resume 锚点校验需要，热路径无害）。
  record.sessionFile = "/tmp/fake-session.jsonl";
  record.round = 1;
  return record;
}

// ============================================================
// SP-5 one-shot upgrade
// ============================================================

describe("SP-5 one-shot upgrade（message → chatMode + 冷 resume）", () => {
  let agentDir: string;
  let service: SubagentService;
  let store: RecordStore;
  let sessionRootId: string;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    agentDir = makeTmpAgentDir();
    const modelService = new ModelConfigService({ agentDir });
    service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session" });
    const internals = service as unknown as ServiceInternals;
    store = internals.store;
    sessionRootId = internals.sessionRootId!;
    // 协议替身引擎（registry 'pi'）：冷/热分流由 fake.interactMessageResult 逐用例注入。
    fake = registerFakePiEngine();
  });

  afterEach(() => {
    service.dispose();
    // registry 是 globalThis 进程单例——清空防替身引擎泄漏进其他测试文件。
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // TC-1: one-shot done 后 message 触发 upgrade（chatMode=true）
  // 场景：one-shot running record → message → chatMode 被置 true → 热路径投递
  //（引擎侧活会话：interact message 受理）
  it("TC-1: one-shot running record 收到 message → chatMode 升级为 true", async () => {
    const record = makeOneShotRecord(sessionRootId, "running");
    store.register(record);

    // 热路径前提：引擎侧活会话受理 message（fake 默认 {ok:true, delivered:true}）
    expect(record.chatMode).toBeFalsy();

    await messageHandler(service, { subagentId: record.id, text: "follow-up" });

    // 验证升级前后的 chatMode 与投递形态
    expect(record.chatMode).toBe(true);
    // 热路径：engine.interact(message) 恰 1 次（受理即热路径，无 resume run）
    expect(fake.interacts).toHaveLength(1);
    expect(fake.interacts[0].action).toMatchObject({ kind: "message", payload: "follow-up" });
    expect(fake.runs).toHaveLength(0);
    // 验证 record 仍为 running（热路径投递设 running）
    expect(record.status).toBe("running");
    // 验证 record 在内存中（非终态，未被 archive）
    expect(store.getMutable(record.id)).toBeDefined();
  });

  // TC-2: upgrade 后走冷路径 resume
  // 场景：one-shot idle record（引擎侧无活会话）→ message → chatMode=true →
  // 冷路径续轮（interact 拒绝 not_resumable → resume run）
  it("TC-2: one-shot idle record 收到 message → chatMode 升级 + 冷路径 resume", async () => {
    const record = makeOneShotRecord(sessionRootId);
    store.register(record);

    // 引擎侧无活会话：interact 拒绝 not_resumable → 冷路径续轮（resume run）
    fake.interactMessageResult = { ok: false, code: "engine_session_not_resumable", message: "no live session" };

    expect(record.chatMode).toBeFalsy();

    await messageHandler(service, { subagentId: record.id, text: "resume message" });

    // 验证 chatMode 被升级
    expect(record.chatMode).toBe(true);
    // 验证走了冷路径 resume（resumeColdRound → kickOffChatRound → engine.run）
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    // resume 锚点 = record 身份（sessionFile 原样携带——W3 协议 ResumeAnchor）
    expect(fake.runs[0].ctx.chat?.resume?.sessionRef["sessionFile"]).toBe(record.sessionFile);
    // record 被 resumeRound 设为 running，轮次收尾后保持 running（v4 B-1 idle 折入 running）
    // 关键是 record 不在终态
    expect(record.status).not.toBe("closed");
  });

  // TC-3: upgrade 后 record 可续聊（非终态）
  // 场景：验证升级后的 record 不会被 finalize 为终态，仍可接受后续 message
  it("TC-3: upgrade 后 record 可续聊（非终态，仍在内存）", async () => {
    const record = makeOneShotRecord(sessionRootId);
    store.register(record);

    fake.interactMessageResult = { ok: false, code: "engine_session_not_resumable", message: "no live session" };

    await messageHandler(service, { subagentId: record.id, text: "first resume" });
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));

    // chatMode 已升级
    expect(record.chatMode).toBe(true);

    // 关键验证：record 仍在内存（getMutable 返回非 undefined）——未被 archive 到终态
    const mutable = store.getMutable(record.id);
    expect(mutable).toBeDefined();
    expect(mutable!.chatMode).toBe(true);

    // 验证 status 不是终态（closed 是终态；running 是非终态，v4 B-1 idle 折入 running）
    expect(record.status).toBe("running");
  });
});
