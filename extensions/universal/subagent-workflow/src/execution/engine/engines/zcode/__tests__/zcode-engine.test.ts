// zcode-engine.test.ts —— EnginePort 四面单测（fake launcher/源 config，不依赖真机
// CLI 与真凭据；真机链路见 zcode-engine.live.test.ts 的手动门）。覆盖验收 6 的
// capabilities/probe 部分 + run 错误语义三条（§3.3.5）。

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunContext } from "../../../port.ts";
import type { AgentEvent, AgentTaskSpec, EngineHandle } from "../../../types.ts";
import { HOST_TIMEOUT_ABORT_REASON } from "../../../common/kill-chain.ts";
import { ZCODE_GOLDEN_STDOUT } from "../golden-sample.ts";
import type { ZcodeLaunchedProcess } from "../launcher.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const PROVIDER = "test-provider";

let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-engine-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
});

// ── fake launcher ──

interface FakeLaunchOpts {
  stdout?: string;
  exitCode?: number | null;
  signal?: string;
  preKilled?: boolean;
}

/** fake 句柄的 child（立即退出的真实 node 短进程——满足 ChildProcess 类型与 D10 记账形态）。 */
function fakeChild(): ChildProcess {
  return spawn(process.execPath, ["-e", ""]);
}

function makeFakeLaunch(fake: FakeLaunchOpts) {
  const calls: Array<{ cliPath: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  /** 每次 launch 创建的 child 句柄（D10 onChildSpawned 断言的 identity 数据源）。 */
  const children: ChildProcess[] = [];
  let killed = fake.preKilled === true;
  const launch = (o: { cliPath: string; args: string[]; env: NodeJS.ProcessEnv }): ZcodeLaunchedProcess => {
    calls.push(o);
    const child = fakeChild();
    children.push(child);
    const stdout = new PassThrough();
    stdout.end(fake.stdout ?? "");
    const stderr = new PassThrough();
    stderr.end("");
    return {
      child,
      pid: 4242,
      stdout,
      stderr,
      abort: async () => {
        killed = true;
      },
      exited: Promise.resolve({ code: fake.exitCode ?? 0, signal: fake.signal }),
      killedByUs: () => killed,
    };
  };
  return { launch, calls, children };
}

function makeEngine(overrides?: Partial<ZcodeEngineDeps>): ZcodeEngine {
  return new ZcodeEngine({
    engineDataDir: () => dataDir,
    sources: { v2ConfigPath: v2Path },
    processEnv: { PATH: "/usr/bin" },
    ...overrides,
  });
}

function makeTask(overrides?: Partial<AgentTaskSpec>): AgentTaskSpec {
  return { task: "Reply with the single word: ok", slug: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-test", poolKey: "", ...overrides };
}

// ── capabilities ──

describe("capabilities（D3 声明，验收 6）", () => {
  it("zcode 首期十项声明", () => {
    expect(makeEngine().capabilities()).toEqual({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
    });
  });
});

// ── probe ──

describe("probe（D7：二进制/版本/golden 干跑，验收 6）", () => {
  it("三项 check 全过 + 版本进 engineVersion", async () => {
    const engine = makeEngine({
      cliPath: fileURLToPath(import.meta.url), // 存在的文件过 binary check
      probeVersion: async () => "0.16.5",
    });
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toBe("0.16.5");
    expect(report.checks.map((c) => c.name)).toEqual(["binary", "version", "golden-regression"]);
    expect(report.error).toBeUndefined();
  });

  it("golden 样本回归：对实录样本解析出 sessionId/usage（探针干跑通过）", async () => {
    const engine = makeEngine({ cliPath: fileURLToPath(import.meta.url), probeVersion: async () => "x" });
    const report = await engine.probe();
    const golden = report.checks.find((c) => c.name === "golden-regression");
    expect(golden?.ok).toBe(true);
    expect(golden?.detail).toContain("0.16.5");
  });

  it("二进制缺失 → ok=false + 恢复指引（版本命令/探针重跑/文档路径）", async () => {
    const engine = makeEngine({ cliPath: "/nonexistent/zcode.cjs" });
    const report = await engine.probe();
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe("engine_probe_failed");
    expect(report.error?.recovery).toContain("--version");
    expect(report.error?.recovery).toContain("probe");
    expect(report.error?.recovery).toContain("docs/research/agent-engine-zcode.md");
  });

  it("结果缓存：非 force 二次探针不重跑版本命令", async () => {
    const probeVersion = vi.fn(async () => "0.16.5");
    const engine = makeEngine({ cliPath: fileURLToPath(import.meta.url), probeVersion });
    await engine.probe();
    await engine.probe();
    expect(probeVersion).toHaveBeenCalledTimes(1);
    await engine.probe({ force: true });
    expect(probeVersion).toHaveBeenCalledTimes(2);
  });
});

// ── run：错误语义三条（§3.3.5）──

describe("run ① prepare 期错误：进程创建前 reject、不产生 handle", () => {
  it("凭据缺失 → engine_credential_missing", async () => {
    writeJson(v2Path, { provider: {} });
    const engine = makeEngine({ launch: makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT }).launch });
    await expect(engine.run(makeTask(), makeCtx())).rejects.toThrowError(/engine_credential_missing/);
  });

  it("模型不可解析 → model_not_available（列可用模型）", async () => {
    const engine = makeEngine({ launch: makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT }).launch });
    await expect(engine.run(makeTask({ model: `${PROVIDER}/ghost` }), makeCtx())).rejects.toThrowError(
      /model_not_available/,
    );
  });

  it("argv 超限 → prompt_too_large（不调 launch）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    await expect(engine.run(makeTask({ task: "x".repeat(200 * 1024) }), makeCtx())).rejects.toThrowError(
      /prompt_too_large/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("conversation 任务标志 → engine_capability_unsupported（A11：无进程创建）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    await expect(engine.run(makeTask({ conversation: true }), makeCtx())).rejects.toThrowError(
      /engine_capability_unsupported/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("fork（pi 专属）→ engine_capability_unsupported", async () => {
    const engine = makeEngine();
    await expect(engine.run(makeTask({ fork: true }), makeCtx())).rejects.toThrowError(
      /engine_capability_unsupported/,
    );
  });

  it("maxTurns（pi 专属）→ engine_capability_unsupported，不调 launch（U4：静默丢弃会造成假上限）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    await expect(engine.run(makeTask({ maxTurns: 10 }), makeCtx())).rejects.toThrowError(
      /engine_capability_unsupported/,
    );
    // 恢复指引：去掉 maxTurns 或改用 pi 引擎
    await expect(engine.run(makeTask({ maxTurns: 10 }), makeCtx())).rejects.toThrowError(
      /maxTurns|engine: 'pi'/,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("run ② 成功路径：golden stdout → outcome/handle/事件合成", () => {
  it("content/usage/sessionId 正确，事件序 = message_end → turn_end（不变量 5）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    const events: AgentEvent[] = [];
    const { handle, outcome } = await engine.run(makeTask(), makeCtx({ onEvent: (e) => events.push(e) }));

    expect(outcome.error).toBeUndefined();
    expect(outcome.engineId).toBe("zcode");
    expect(outcome.content).toBe("ok");
    // 终态层 usage（orchestration 版）：cost=0 显式缺省、contextTokens/turns 来自 projection
    expect(outcome.usage).toEqual({
      input: 12599,
      output: 17,
      cacheRead: 512,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 12616,
      turns: 1,
    });
    expect(outcome.sessionId).toBe("sess_35852a0f-1302-4e20-9e48-87f47527abe3");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    // 事件：message_end（带完整 usage）在前、turn_end 最后
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "message_end", usage: { input: 12599, output: 17, cacheRead: 512, cacheWrite: 0 } });
    expect(events[1]).toEqual({ type: "turn_end" });

    // handle：自描述（poolKey/dbPath 相对池目录/sessionId）
    expect(handle.data.engineId).toBe("zcode");
    expect(handle.data.poolKey).toBe(`home-${PROVIDER}-m1`);
    expect(handle.data.sessionRef["dbPath"]).toBe(".zcode/cli/db/db.sqlite");
    expect(handle.data.sessionRef["sessionId"]).toBe("sess_35852a0f-1302-4e20-9e48-87f47527abe3");
    expect(handle.data.adapterVersion).toBe("1.0.0");
  });

  it("launcher 收到隔离 HOME env + XYZ_AGENT_SUBAGENT + denylist flag + 完整 prompt", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    await engine.run(
      makeTask({
        task: "TASK BODY",
        persona: { appendSystemPrompt: ["PERSONA A", "PERSONA B"] },
        denyTools: ["bash"],
        cwd: "/work/dir",
      }),
      makeCtx(),
    );
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.env["HOME"]).toBe(path.join(dataDir, "engines", "zcode", `home-${PROVIDER}-m1`));
    expect(call.env["XYZ_AGENT_SUBAGENT"]).toBe("1");
    expect(call.env["PATH"]).toBe("/usr/bin");
    expect(call.args).toContain("--cwd");
    expect(call.args[call.args.indexOf("--cwd") + 1]).toBe("/work/dir");
    expect(call.args).toContain("--disallowed-tools");
    // prompt = persona 段在前 + task 正文在后（personaInjection: 'prompt'）
    const promptIdx = call.args.indexOf("--prompt");
    expect(call.args[promptIdx + 1]).toBe("PERSONA A\n\nPERSONA B\n\nTASK BODY");
  });

  it("preparer 池 config 已落盘（无 plugins 块）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    await engine.run(makeTask(), makeCtx());
    const poolConfig = path.join(dataDir, "engines", "zcode", `home-${PROVIDER}-m1`, ".zcode/cli/config.json");
    const written = JSON.parse(fs.readFileSync(poolConfig, "utf8")) as Record<string, unknown>;
    expect(written["model"]).toEqual({ main: `${PROVIDER}/m1` });
    expect("plugins" in written).toBe(false);
  });
});

// ── D10 终止链路径①（C-ext-17 回归）：spawn 成功后同步回调 onChildSpawned ──

describe("run D10：onChildSpawned（宿主终止链记账钩子）", () => {
  it("spawn 成功 → ctx.onChildSpawned 收到 launcher 的 child 句柄，先于任何终态事件（同步口径）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    const seen: Array<{ child: ChildProcess; eventsBefore: number }> = [];
    let eventCount = 0;
    const { outcome } = await engine.run(
      makeTask(),
      makeCtx({
        onChildSpawned: (child) => seen.push({ child, eventsBefore: eventCount }),
        onEvent: () => {
          eventCount++;
        },
      }),
    );
    expect(outcome.error).toBeUndefined();
    // 回调恰好一次，句柄即 launch 返回的 child（宿主 registerSpawnedChildForRecord 数据源）
    expect(seen).toHaveLength(1);
    expect(seen[0]?.child).toBe(fake.children[0]);
    // 同步回调（port.ts 契约）：zcode coarse 事件在终态后合成，回调时事件数为 0
    expect(seen[0]?.eventsBefore).toBe(0);
  });

  it("ctx 未提供回调时静默跳过（可选钩子，run 正常完成）", async () => {
    const fake = makeFakeLaunch({ stdout: ZCODE_GOLDEN_STDOUT });
    const engine = makeEngine({ launch: fake.launch });
    const { outcome } = await engine.run(makeTask(), makeCtx());
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toBe("ok");
  });
});

describe("run schema 仿真接线（D4 emulated 侧：common/schema-emulation 公共层）", () => {
  const VERDICT_SCHEMA = {
    type: "object",
    properties: { verdict: { type: "string", enum: ["ok", "bad"] } },
    required: ["verdict"],
    additionalProperties: false,
  };

  function terminalStdout(response: string, sessionId: string): string {
    return JSON.stringify({
      sessionId,
      response,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      projection: { turnCount: 1, contextUsed: 15 },
    });
  }

  it("合法输出 → parsedOutput = ajv 校验产物；prompt 尾部拼了仿真段", async () => {
    const fake = makeFakeLaunch({ stdout: terminalStdout('{"verdict":"ok"}', "sess_s1") });
    const engine = makeEngine({ launch: fake.launch });
    const { outcome } = await engine.run(makeTask({ schema: VERDICT_SCHEMA }), makeCtx());
    expect(outcome.error).toBeUndefined();
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
    // 仿真段拼进 prompt 尾部（buildSchemaEmulationSegment 的输出特征）
    const prompt = fake.calls[0]!.args[fake.calls[0]!.args.indexOf("--prompt") + 1]!;
    expect(prompt).toContain("Structured Output Requirement");
    expect(prompt).toContain("verdict");
    expect(prompt.endsWith("the first complete JSON value is extracted.")).toBe(true);
  });

  it("markdown fence 包裹的输出也过（三级容错提取）", async () => {
    const fake = makeFakeLaunch({ stdout: terminalStdout('```json\n{"verdict":"ok"}\n```', "sess_s2") });
    const engine = makeEngine({ launch: fake.launch });
    const { outcome } = await engine.run(makeTask({ schema: VERDICT_SCHEMA }), makeCtx());
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
  });

  it("首轮校验失败 → 强化 prompt 重试一次，二次通过 → parsedOutput 产出", async () => {
    const stdouts = [terminalStdout("I think everything is fine.", "sess_r1"), terminalStdout('{"verdict":"ok"}', "sess_r2")];
    const launches: string[] = [];
    const launch = (o: { cliPath: string; args: string[]; env: NodeJS.ProcessEnv }): ZcodeLaunchedProcess => {
      const stdout = stdouts[launches.length] ?? "";
      launches.push(o.args[o.args.indexOf("--prompt") + 1]!);
      const s = new PassThrough();
      s.end(stdout);
      const e = new PassThrough();
      e.end("");
      return {
        child: fakeChild(),
        pid: 1,
        stdout: s,
        stderr: e,
        abort: async () => undefined,
        exited: Promise.resolve({ code: 0, signal: undefined }),
        killedByUs: () => false,
      };
    };
    const engine = makeEngine({ launch });
    const { outcome } = await engine.run(makeTask({ schema: VERDICT_SCHEMA }), makeCtx());
    expect(launches).toHaveLength(2);
    // 重试 prompt 带强化指令 + 首战失败原因回灌
    expect(launches[1]).toContain("Retry: Structured Output Failed");
    expect(launches[1]).toContain("could not extract JSON");
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
    expect(outcome.error).toBeUndefined();
    // sessionId 取末轮（最终响应所在 session）；usage 两轮累计
    expect(outcome.sessionId).toBe("sess_r2");
    expect(outcome.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 });
  });

  it("两轮均失败 → schema_emulation_failed（含原始输出尾部与恢复指引）", async () => {
    const fake = makeFakeLaunch({ stdout: terminalStdout("no json at all, just prose", "sess_f1") });
    const engine = makeEngine({ launch: fake.launch });
    const events: AgentEvent[] = [];
    const { outcome } = await engine.run(
      makeTask({ schema: VERDICT_SCHEMA }),
      makeCtx({ onEvent: (e) => events.push(e) }),
    );
    expect(outcome.parsedOutput).toBeUndefined();
    expect(outcome.error).toContain("schema_emulation_failed");
    expect(outcome.error).toContain("no json at all");
    expect(outcome.error).toContain("engine: pi");
    // content 保留末轮原始输出（record 可追溯）
    expect(outcome.content).toContain("no json at all");
    expect(events[0]).toEqual({ type: "error", message: outcome.error });
  });
});

describe("run ② 运行中失败：不 reject——error outcome + 正常 handle（record 收尾）", () => {
  it("非零退出：engine_run_failed 含 stdout 尾部 + exit code + 恢复指引", async () => {
    const fake = makeFakeLaunch({ stdout: "Error: cannot connect\n", exitCode: 3 });
    const engine = makeEngine({ launch: fake.launch });
    const events: AgentEvent[] = [];
    const { handle, outcome } = await engine.run(makeTask(), makeCtx({ onEvent: (e) => events.push(e) }));
    expect(outcome.error).toContain("engine_run_failed");
    expect(outcome.error).toContain("exit code: 3");
    expect(outcome.error).toContain("Error: cannot connect");
    expect(outcome.error).toContain("engine: pi");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.content).toBe("");
    expect(events).toEqual([{ type: "error", message: outcome.error }]);
    // handle 仍返回（sessionId 缺失但 dbPath/poolKey 齐备）
    expect(handle.data.sessionRef["dbPath"]).toBe(".zcode/cli/db/db.sqlite");
    expect(handle.data.sessionRef["sessionId"]).toBeUndefined();
  });

  it("exit 0 但 stdout 损坏（格式漂移）：parseReason 进错误", async () => {
    const fake = makeFakeLaunch({ stdout: "not a json" });
    const engine = makeEngine({ launch: fake.launch });
    const { outcome } = await engine.run(makeTask(), makeCtx());
    expect(outcome.error).toContain("engine_run_failed");
    expect(outcome.error).toContain("不是 JSON");
  });
});

describe("run ③ abort：杀链合成终态（exitCode=null + 杀链标记）", () => {
  it("pre-aborted signal → abort 被调、killedByUs 判定、无 engine 自身失败语义", async () => {
    const fake = makeFakeLaunch({ stdout: "", exitCode: 143 });
    const engine = makeEngine({ launch: fake.launch });
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await engine.run(makeTask(), makeCtx({ signal: controller.signal }));
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("SIGTERM");
    expect(outcome.error).toContain("5000");
  });

  it("运行中 abort（listener 触发形态）", async () => {
    let killed = false;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const launch = (): ZcodeLaunchedProcess => ({
      child: fakeChild(),
      pid: 99,
      stdout,
      stderr,
      abort: async () => {
        killed = true;
        stdout.end();
      },
      exited: new Promise((resolve) => {
        const t = setTimeout(() => {
          killed = true;
          stdout.end();
          resolve({ code: null, signal: "SIGTERM" });
        }, 50);
        void t;
      }),
      killedByUs: () => killed,
    });
    const engine = makeEngine({ launch });
    const controller = new AbortController();
    const runPromise = engine.run(makeTask(), makeCtx({ signal: controller.signal }));
    controller.abort();
    const { outcome } = await runPromise;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("杀链");
  });

  it("宿主超时 abort（reason 标记）→ engine_timeout 公共合成终态（对齐点④）", async () => {
    const fake = makeFakeLaunch({ stdout: "partial output", exitCode: 143 });
    const engine = makeEngine({ launch: fake.launch });
    const controller = new AbortController();
    controller.abort(HOST_TIMEOUT_ABORT_REASON); // mergeTimeoutSignal 超时链的 abort 形态
    const { outcome } = await engine.run(makeTask(), makeCtx({ signal: controller.signal }));
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("engine_timeout");
    expect(outcome.error).toContain("partial output"); // stdout 尾部保留（错误规格第 6 行）
    expect(outcome.error).toContain("engine: pi"); // 重跑建议
  });
});

// ── interact ──

describe("interact：A11 同步拒绝（不创建进程）", () => {
  it("engine_capability_unsupported + 可操作建议（换单次调用 / engine: pi）", async () => {
    const engine = makeEngine();
    const handle: EngineHandle = {
      data: { v: 1, engineId: "zcode", sessionRef: {}, poolKey: "p", adapterVersion: "1.0.0" },
    };
    const res = await engine.interact(handle, { kind: "message", payload: "next" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("engine_capability_unsupported");
    expect(res.message).toContain("单次");
    expect(res.message).toContain("engine: 'pi'");
  });
});

// ── read ──

describe("read：第①级 + 降级 outcome-only", () => {
  async function seedDb(poolKey: string, sessionId: string): Promise<void> {
    const dbFile = path.join(
      dataDir,
      "engines",
      "zcode",
      poolKey,
      ".zcode",
      "cli",
      "db",
      "db.sqlite",
    );
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => unknown };
    type Db = {
      exec: (s: string) => void;
      prepare: (s: string) => { run: (...a: unknown[]) => void };
      close: () => void;
    };
    const db = new DatabaseSync(dbFile) as unknown as Db;
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);" +
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);" +
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, sequence INTEGER, data TEXT);",
    );
    db.prepare("INSERT INTO session (id, time_created) VALUES (?, ?)").run(sessionId, 1);
    db
      .prepare("INSERT INTO message (id, session_id, sequence, data) VALUES (?, ?, ?, ?)")
      .run("m1", sessionId, 0, JSON.stringify({ role: "assistant" }));
    db
      .prepare("INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)")
      .run("p1", "m1", sessionId, 0, JSON.stringify({ type: "text", text: "answer" }));
    db
      .prepare("INSERT INTO part (id, message_id, session_id, sequence, data) VALUES (?, ?, ?, ?, ?)")
      .run("p2", "m1", sessionId, 1, JSON.stringify({ type: "step-finish", tokens: { input: 5, output: 2 } }));
    db.close();
  }

  function makeHandle(sessionRef: Record<string, string>, poolKey: string): EngineHandle {
    return { data: { v: 1, engineId: "zcode", sessionRef, poolKey, adapterVersion: "1.0.0" } };
  }

  it("①级：池内 db 经相对 dbPath 定位，native 视图 turns 非空", async () => {
    await seedDb("home-p-m", "sess_read1");
    const engine = makeEngine();
    const view = await engine.read(makeHandle({ sessionId: "sess_read1", dbPath: ".zcode/cli/db/db.sqlite" }, "home-p-m"));
    expect(view.source).toBe("native");
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]!.text).toBe("answer");
  });

  it("sessionId 缺失 → outcome-only（共享池 db 无法定位 session）", async () => {
    const engine = makeEngine();
    const view = await engine.read(makeHandle({ dbPath: ".zcode/cli/db/db.sqlite" }, "home-p-m"));
    expect(view.source).toBe("outcome-only");
    expect(view.turns).toEqual([]);
  });

  it("db 缺失（结构化读取失败）→ 降级 outcome-only 不 throw", async () => {
    const engine = makeEngine();
    const view = await engine.read(
      makeHandle({ sessionId: "sess_ghost", dbPath: ".zcode/cli/db/db.sqlite" }, "home-empty"),
    );
    expect(view.source).toBe("outcome-only");
  });
});
