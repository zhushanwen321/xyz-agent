// chat-round-protocol.test.ts —— [W6] chat 轮次协议 v1.x 增量的协议黑盒契约。
//
// 设计权威源：chat-domain-v1x-liveness-governance.md §3.2 D1-A + §5 W1/W6 行 +
// 验收 A6。W1 SDK 已交付第 9 反向通道 host/roundLifecycle（settled/idle/failed
// 三相位，关联键 runId|recordId 互斥分路）与 conversation gate 负向构造器；本套件
// 在 conformance 层（协议客户端 × fake 引擎 CLI）钉住三条语义，供 W3 chat 改线与
// A7 live 门回归：
//
//   ① roundLifecycle 三相位（settled/idle/failed）× 双关联键：数据面回执链闭合
//      （宿主必须确认收到——fake 引擎收到帧②应答后回发 host/log "ack …" 回声，
//      NDJSON 单连接有序保证回声先于 run 应答帧到达）；core 不误判引擎故障
//      （run 正常 resolve + 客户端保持 ready，10s 数据面守卫不触发）。
//   ② recordId 键 streamDelta 分路：续聊轮 delta 经 recordId 关联（D1-A 裁定，
//      InteractParams/Result 无 runId）。现状 reverse-router 对 recordId 键 break
//      （W1 偏差 #1 登记的 no-op 分支——真实消费接线归 W3）：本用例钉「宿主确认
//      收到 + 不误投 runId 路由」的现状契约；W3 接线替换 no-op 分支时同步更新
//      断言（delta 投影到 chat 轮消费点）。
//   ③ conversation gate 负向（A6）：manifest 无 conversation 位的引擎（capabilities
//      覆写 unsupported）→ assertChatConversationSupported 同步拒——错误码
//      engine_capability_unsupported + 恢复指引含「升级引擎包」文案契约；同一
//      客户端的 run 域完全正常（gate 只拦 chat 面不伤 run 域）。
//
// 帧载荷类型权威 = W1 SDK `HostRoundLifecycleParams`（isHostRoundLifecycleParams
// 的相位居留形状由 SDK 包内测试覆盖）；fake 引擎按该形状发帧，本套件断言消费侧。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertChatConversationSupported,
  isHostRoundLifecycleParams,
  type InitializeResult,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineClient } from "../../client/engine-client.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "engine-protocol");
const FAKE_ENGINE = join(FIXTURE_DIR, "fake-engine-protocol.mjs");
const FIXTURE = join(FIXTURE_DIR, "smoke-run.fixture.json");

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w6-chat-round-protocol-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface Harness {
  client: EngineClient;
  logs: Array<{ level: string; message: string }>;
  streamDeltas: string[];
}

function makeHarness(extraEnv: Record<string, string> = {}): Harness {
  const h: Harness = {
    client: undefined as unknown as EngineClient,
    logs: [],
    streamDeltas: [],
  };
  h.client = new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    hostVersion: "w6-chat-round-protocol",
    dataDir,
    envPrefixes: [],
    log: (p) => h.logs.push({ level: p.level, message: p.message }),
    baseEnv: {
      ...process.env,
      FAKE_PROTOCOL_FIXTURE: FIXTURE,
      ...extraEnv,
    },
  });
  const unregister = h.client.registerRunRoute("run-smoke-1", {
    onStreamDelta: (delta) => {
      h.streamDeltas.push(delta);
    },
  });
  void unregister;
  return h;
}

describe("[W6] host/roundLifecycle 三相位 × 双关联键（协议黑盒回执链）", () => {
  it("settled/idle/failed 相位 × runId|recordId 键全部被宿主确认（ack 回声）且不判引擎故障", async () => {
    const h = makeHarness({ FAKE_RUN_LIFECYCLE: "1" });
    try {
      await h.client.ensureConnected();
      const result = (await h.client.request("run", {
        runId: "run-smoke-1",
        task: "w6 round lifecycle probe",
        ctx: { poolKey: "shared", cwd: dataDir, model: "fake/fake-1" },
      })) as { outcome: Record<string, unknown> };
      void result;

      // 回执链闭合：6 帧（三相位 × runId 键 "run-smoke-1" / recordId 键 "rec-chat-1"）
      // 的帧②应答全部到达 fake 引擎并回发回声——「宿主必须确认收到」的数据面契约。
      // 回声帧经引擎侧往返（core 帧②应答 → fake 收到 → 回发 log），晚于 run 应答
      // 帧到达——断言轮询等待（NDJSON 单连接有序，run resolve 后毫秒级必达）。
      await expect
        .poll(
          () => h.logs.map((l) => l.message).filter((m) => m.startsWith("ack roundLifecycle ")),
          { timeout: 5_000, interval: 20 },
        )
        .toEqual([
        "ack roundLifecycle run-smoke-1 settled",
        "ack roundLifecycle run-smoke-1 idle",
        "ack roundLifecycle run-smoke-1 failed",
        "ack roundLifecycle rec-chat-1 settled",
        "ack roundLifecycle rec-chat-1 idle",
        "ack roundLifecycle rec-chat-1 failed",
      ]);

      // 不误判引擎故障：run 正常 resolve + 客户端保持 ready（10s 数据面应答守卫
      // 未触发杀链——roundLifecycle 是数据面回执语义，不是故障信号）。
      expect(h.client.currentState).toBe("ready");

      // failed 相位的 error{code,message} 居留形状（isHostRoundLifecycleParams
      // 判据的 failed 分支）——fake 引擎按 W1 载荷类型构造，宿主侧对同形状自证。
      const failedShape = {
        runId: "run-smoke-1",
        phase: "failed",
        error: { code: "engine_run_failed", message: "round failed (scripted)", recovery: "retry" },
      };
      expect(isHostRoundLifecycleParams(failedShape)).toBe(true);
      const malformedShape = { runId: "r", recordId: "c", phase: "settled" };
      expect(isHostRoundLifecycleParams(malformedShape)).toBe(false);
    } finally {
      await h.client.dispose();
    }
  });
});

describe("[W6] recordId 键 streamDelta 分路（续聊轮关联键，D1-A）", () => {
  it("recordId 键 delta：宿主确认收到（ack 回声）且不误投 runId 路由（W3 接线前 no-op 现状）", async () => {
    const h = makeHarness({ FAKE_RUN_RECORD_DELTA: "1" });
    try {
      await h.client.ensureConnected();
      await h.client.request("run", {
        runId: "run-smoke-1",
        task: "w6 record-key delta probe",
        ctx: { poolKey: "shared", cwd: dataDir, model: "fake/fake-1" },
      });

      // 宿主确认收到（数据面回执闭合；回声帧晚于 run 应答到达，轮询等待）。
      await expect
        .poll(() => h.logs.map((l) => l.message), { timeout: 5_000, interval: 20 })
        .toContain("ack streamDelta recordId=rec-chat-1");
      // 现状契约：recordId 键不投 runId 路由（reverse-router no-op 分支，W1 偏差
      // #1 登记；W3 chat 改线接线 recordId 消费时本断言同步更新为「投递到 chat
      // 轮消费点」）。runId 键 fixture delta 不受影响。
      expect(h.streamDeltas).toEqual(["Hello", " world"]);
      expect(h.client.currentState).toBe("ready");
    } finally {
      await h.client.dispose();
    }
  });
});

describe("[W6] conversation gate 负向（A6：无 gate 位引擎 chat 请求同步拒，run 域不受影响）", () => {
  it("capabilities.conversation=unsupported → assertChatConversationSupported 同步拒 + 文案契约；同客户端 run 正常", async () => {
    const h = makeHarness({ FAKE_CAPABILITIES_CONVERSATION: "unsupported" });
    try {
      await h.client.ensureConnected();
      const diagnostics = h.client.getInitializeDiagnostics() as InitializeResult;
      expect(diagnostics.capabilities.conversation).toBe("unsupported");

      // W1 具名构造器（W3 chat 路由接线的判据单源）：同步拒、错误码与恢复指引
      // 文案契约——「升级引擎包」恢复指引对齐 core capability-gate conversation
      // 分支（错误 → 权威源 → 重试闭环）。
      let thrown: unknown;
      try {
        assertChatConversationSupported("fake", diagnostics.capabilities);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({
        name: "EngineSdkError",
        code: "engine_capability_unsupported",
      });
      expect((thrown as Error).message).toContain("conversation");
      expect((thrown as { recovery: string }).recovery).toContain("升级引擎包");

      // A6 后半：gate 只拦 chat 面——同一客户端的 run 域完全正常。
      const result = (await h.client.request("run", {
        runId: "run-smoke-1",
        task: "w6 gate-negative run-domain probe",
        ctx: { poolKey: "shared", cwd: dataDir, model: "fake/fake-1" },
      })) as { outcome: Record<string, unknown> };
      expect(result.outcome).toBeDefined();
      expect(h.client.currentState).toBe("ready");
    } finally {
      await h.client.dispose();
    }
  });
});
