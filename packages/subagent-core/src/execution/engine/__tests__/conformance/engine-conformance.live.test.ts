// engine-conformance.live.test.ts —— conformance run 层（真实 spawn 简单任务，C2/C4
// 真机面）。手动门（设计 §3.3.8：run 层需已装引擎 + 有效凭据，不进默认 CI）：
//
//   cd extensions/universal/subagent-workflow
//   ENGINE_CONFORMANCE_LIVE=1 pnpm vitest run src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts
//
// pi 部分复用 PiEngine 的服务面注入（真实 executeAndAwait 需要完整 SubagentService 装配，
// live 场景从进程单例取——未初始化时该用例 skip 并说明）；zcode 部分与 P3 的
// zcode-engine.live.test.ts 互补（后者已覆盖 schema 全链，此处只跑 conformance 最小面）。
//
// relay 变体（E 方案 §2.3）= 同一契约 × 不同 spawn 通道：测试内起伪 runtime（net server，
// 按 E-2 协议收握手回 accept / down 帧转写真实 pi stdin / pi stdout 回发 up 帧 / exit 帧收尾），
// 经 PiEngine 真实 run 全链断言 C2+C3。前置 = SubagentService 已装配（真实会话进程内），
// 且需真实模型凭据（最小任务由 LLM 完成）——纯 CI/无凭据环境必然 skip，属预期。

import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getSubagentService } from "../../../subagent-service.ts";
import { ZcodeEngine } from "../../engines/zcode/zcode-engine.ts";
import { createPiEngine } from "../../engines/pi/registration.ts";
import type { RunContext } from "../../port.ts";
import type { AgentEvent } from "../../../types.ts";
import type { AgentCallOpts } from "../../../../orchestration/models/types.ts";
import { getPiInvocation } from "../../engines/pi/pi-invocation.ts";
import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_PROTOCOL_VERSION,
  isRelayActive,
} from "../../../relay-env.ts";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";

describe.skipIf(!LIVE)("conformance run 层（真实 spawn，手动门）", () => {
  it("pi：简单任务全链（C2：outcome 无 error、content 非空、engineId=pi）", async (testCtx) => {
    const service = getSubagentService();
    if (service === null) {
      // 服务装配是 pi live 的前置（完整 SubagentService + modelRegistry 注入）——
      // live 门内说明跳过原因而非静默 pass（失败要出声）
      testCtx.skip("SubagentService 未装配（需在真实会话进程内运行）");
      return;
    }
    const engine = createPiEngine(() => service);
    const task: AgentCallOpts = { prompt: "Reply with the single word: ok", description: "live-c2" };
    const ctx: RunContext = { taskId: "sa-live-pi-c2", poolKey: "shared" };
    const { outcome } = await engine.run(task, ctx);
    expect(outcome.error).toBeUndefined();
    expect(outcome.content.trim().length).toBeGreaterThan(0);
    expect(outcome.engineId).toBe("pi");
  }, 120_000);

  it("zcode：probe 真机（C1 live 面：三项 check 全过）", async () => {
    const engine = new ZcodeEngine({ engineDataDir: () => "/tmp/zcode-conformance-live" });
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toMatch(/^0\.\d+\.\d+$/);
  }, 60_000);

  // [R6] 常驻通道的 conformance run 层（RA8「C1-C8 适配后全绿」的 live 面）：
  // 跑最小任务——C2 outcome + C3 stream 不变量（app-server 设计 §3.4 不变量 1）。
  // 2026-09 起单一 app-server 形态即缺省路径（无模式钉扎 env）；更深断言（schema/
  // abort/进程锚定）由 engines/zcode/__tests__/zcode-engine.live.test.ts 承载。
  it("zcode：app-server 常驻通道 run 全链（C2 outcome 无 error + C3 stream 事件不变量）", async (testCtx) => {
    const model = process.env["ZCODE_E2E_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("ZCODE_E2E_MODEL 未设置（需真实 provider/model 凭据）——appserver live run 面跳过");
      return;
    }
    const engine = new ZcodeEngine({
      engineDataDir: () => "/tmp/zcode-conformance-live-appserver",
    });
    const events: AgentEvent[] = [];
    const { outcome } = await engine.run(
      { task: "Reply with the single word: ok", slug: "live-appserver-c2", model, cwd: "/tmp" },
      { taskId: "sa-live-zcode-appserver", poolKey: "", onEvent: (e) => events.push(e) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.content.trim().length).toBeGreaterThan(0);
    expect(outcome.sessionId).toMatch(/^sess_/);
    assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
    await engine.dispose().catch(() => undefined);
  }, 180_000);
});

// ── relay 变体（E 方案 §2.3：同一契约 × 不同 spawn 通道，手动门内的手动门）──
//
// 前置：①ENGINE_CONFORMANCE_LIVE=1（套件级门）；②SubagentService 已装配（真实会话
// 进程内跑——vitest 裸进程恒 null → skip 说明，与上方 pi live 用例同形态）；③真实模型
// 凭据（最小任务由 LLM 完成）。relay 三 env 由测试自构（socket 指向测试内伪 runtime，
// 执行器 = 本进程 node，脚本 = 包根 relay/relay.mjs），不依赖外部注入。

describe.skipIf(!LIVE)("conformance relay 变体（经代理 spawn 全链，手动门）", () => {
  /** 伪 runtime：按 E-2 协议扮演 runtime 侧——握手 accept + spawn 真实 pi + 双向转发 + exit 传播。 */
  function startFakeRuntime(socketPath: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((conn) => {
        let lineBuf = "";
        let pi: ChildProcess | null = null;
        const send = (frame: Record<string, unknown>): void => {
          conn.write(`${JSON.stringify(frame)}\n`);
        };
        const handleLine = (line: string): void => {
          let frame: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (typeof parsed !== "object" || parsed === null) return;
            frame = parsed as Record<string, unknown>;
          } catch {
            return;
          }
          if (frame.kind === "handshake" && pi === null) {
            // 按 E-2 协议回 accept，随后按握手帧 spawn 真实 pi（直连——本进程 env 已带
            // relay 三 env，必须 relay:false 防二次代理死循环）；env 剥离 relay 五键
            //（对齐 E-2 registry 剥离逻辑，防孙进程嵌套 relay 时旧值误导）。
            send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
            const argv = Array.isArray(frame.argv) ? (frame.argv as string[]) : [];
            const invocation = getPiInvocation(argv, { relay: false });
            const env: NodeJS.ProcessEnv = { ...(frame.env as NodeJS.ProcessEnv) };
            for (const key of [RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT, RELAY_ENV_SESSION_ID, RELAY_ENV_RECORD_ID]) {
              delete env[key];
            }
            pi = childSpawn(invocation.command, invocation.args, {
              env,
              cwd: typeof frame.cwd === "string" ? frame.cwd : undefined,
              stdio: ["pipe", "pipe", "pipe"],
            });
            pi.stdout?.on("data", (c: Buffer) => {
              send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up", b64: c.toString("base64") });
            });
            pi.stderr?.on("data", (c: Buffer) => {
              send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up-stderr", b64: c.toString("base64") });
            });
            pi.on("close", (code, signal) => {
              send(signal !== null ? { kind: "exit", signal } : { kind: "exit", code: code ?? 1 });
            });
            return;
          }
          if (frame.kind === "data" && frame.dir === "down" && typeof frame.b64 === "string") {
            pi?.stdin?.write(Buffer.from(frame.b64, "base64"));
          }
        };
        conn.setEncoding("utf8");
        conn.on("data", (chunk: string) => {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl);
            lineBuf = lineBuf.slice(nl + 1);
            if (line.trim()) handleLine(line);
          }
        });
        // 断连即杀（对齐 E-2 registry 语义）——防代理死/测试收尾后真实 pi 变孤儿
        conn.on("close", () => {
          if (pi !== null && !pi.killed) pi.kill("SIGTERM");
        });
      });
      server.once("error", reject);
      server.listen(socketPath, () => resolve(server));
    });
  }

  it("pi × relay：伪 runtime 环回全链（C2 outcome 无 error + C3 事件不变量经代理转发全等）", { timeout: 180_000 }, async (testCtx) => {
    const service = getSubagentService();
    if (service === null) {
      testCtx.skip(
        "SubagentService 未装配（需在真实会话进程内运行，如 pi --extension 挂载本包后触发）" +
          "——relay 变体与直连 live 用例共享该前置；纯 vitest 进程恒 skip，全链真机另由 " +
          "packages/runtime relay-integration.test.ts（已存在）+ §9 人工验收承载",
      );
      return;
    }

    // 测试自构 relay env：socket 指向伪 runtime，执行器 = 本进程 node，脚本 = 包根 relay.mjs
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conformance-live-"));
    const socketPath = path.join(tmpDir, "relay.sock");
    const server = await startFakeRuntime(socketPath);
    const savedEnv: Record<string, string | undefined> = {};
    const restoreKeys = [RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT];
    for (const key of restoreKeys) savedEnv[key] = process.env[key];
    process.env[RELAY_ENV_SOCKET] = socketPath;
    process.env[RELAY_ENV_NODE] = process.execPath;
    process.env[RELAY_ENV_SCRIPT] = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../relay/relay.mjs",
    );
    if (!isRelayActive(process.env)) {
      throw new Error("relay env 自构后仍不激活——前置断言失败");
    }

    try {
      const engine = createPiEngine(() => service);
      const events: AgentEvent[] = [];
      const task: AgentCallOpts = { prompt: "Reply with the single word: ok", description: "live-relay-c2" };
      const ctx: RunContext = {
        taskId: "sa-live-pi-relay",
        poolKey: "shared",
        onEvent: (event) => events.push(event),
      };
      const { outcome } = await engine.run(task, ctx);
      // C2：outcome 无 error + engineId 仍为 pi（relay 是 spawn 通道不是引擎身份）
      expect(outcome.error).toBeUndefined();
      expect(outcome.content.trim().length).toBeGreaterThan(0);
      expect(outcome.engineId).toBe("pi");
      // C3：事件不变量五条对「经代理转发的子进程 stdout」逐一成立（同一 parser 消费同一字节流）
      assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
    } finally {
      for (const key of restoreKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
