// launcher.test.ts —— argv 组装 / 字节估算超限 / env 构造 / 真实子进程杀链（用 node -e
// 代替 zcode CLI，验证 SIGTERM→grace→SIGKILL 与 exited 标志机制本身）。

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { DEFAULT_ARGV_BUDGET_BYTES, estimateArgvBytes } from "../../../common/persona-router.ts";
import {
  assertZcodeArgvBudget,
  buildZcodeArgv,
  buildZcodeEnv,
  launchZcodeProcess,
} from "../launcher.ts";

describe("buildZcodeArgv", () => {
  it("基础形态：--json --cwd --mode yolo --prompt 尾置", () => {
    const args = buildZcodeArgv({ cwd: "/tmp/w", prompt: "do it" });
    expect(args).toEqual(["--json", "--cwd", "/tmp/w", "--mode", "yolo", "--prompt", "do it"]);
  });

  it("denyTools 逗号连接进 --disallowed-tools", () => {
    const args = buildZcodeArgv({ cwd: "/w", prompt: "p", denyTools: ["bash", "edit"] });
    expect(args).toContain("--disallowed-tools");
    expect(args[args.indexOf("--disallowed-tools") + 1]).toBe("bash,edit");
  });

  it("denyTools 空/空白项过滤，全空不加 flag", () => {
    expect(buildZcodeArgv({ cwd: "/w", prompt: "p", denyTools: [] })).not.toContain("--disallowed-tools");
    expect(buildZcodeArgv({ cwd: "/w", prompt: "p", denyTools: ["  ", ""] })).not.toContain("--disallowed-tools");
  });

  it("resumeSessionId 落 --resume（prompt 之前）", () => {
    const args = buildZcodeArgv({ cwd: "/w", prompt: "p", resumeSessionId: "sess_x" });
    expect(args.indexOf("--resume")).toBeLessThan(args.indexOf("--prompt"));
    expect(args[args.indexOf("--resume") + 1]).toBe("sess_x");
  });
});

describe("assertZcodeArgvBudget（对齐点②：公共 persona-router 权威预算的引擎侧消费）", () => {
  it("估算含 node 与 cliPath 前导（NUL 分隔近似），中文 prompt 按字节计", () => {
    // 公共 estimateArgvBytes 的口径回归：前导两元素计入 + 多字节按 UTF-8 字节
    const est = estimateArgvBytes(["n", "c", "--prompt", "中文"]);
    expect(est).toBe(2 + 2 + ("--prompt".length + 1) + Buffer.byteLength("中文") + 1);
  });

  it("超 128KB 阈值抛 prompt_too_large（含恢复指引；阈值 = DEFAULT_ARGV_BUDGET_BYTES）", () => {
    const bigPrompt = "x".repeat(DEFAULT_ARGV_BUDGET_BYTES);
    expect(() => assertZcodeArgvBudget("node", "/cli.cjs", ["--prompt", bigPrompt])).toThrowError(
      /prompt_too_large/,
    );
    try {
      assertZcodeArgvBudget("node", "/cli.cjs", ["--prompt", bigPrompt]);
    } catch (err) {
      // 公共 EngineError 形态：message 是 code 前缀 detail，恢复指引在 recovery 字段
      expect((err as { code: string }).code).toBe("prompt_too_large");
      expect((err as { recovery: string }).recovery).toContain("Shorten the task text");
    }
  });

  it("阈值内不抛", () => {
    expect(() => assertZcodeArgvBudget("node", "/cli.cjs", ["--prompt", "x".repeat(1024)])).not.toThrow();
  });
});

describe("buildZcodeEnv", () => {
  it("HOME 强制覆盖（同名键不许覆盖隔离值）+ 统一嵌套标记（经公共 nesting-guard）", () => {
    const env = buildZcodeEnv("/pool/home", { HOME: "/real/home", PATH: "/usr/bin" });
    expect(env["HOME"]).toBe("/pool/home");
    expect(env["XYZ_AGENT_SUBAGENT"]).toBe("1");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("剥离引擎原生嵌套标记（D8：防孙代理误判已在嵌套层）", () => {
    const env = buildZcodeEnv("/pool/home", {
      ZSW_NESTED: "1",
      CLAUDECODE: "1",
      PI_SUBAGENT_SELF_RECORD_ID: "sa-x",
      PI_SUBAGENT_DEPTH: "2",
    });
    expect(env["ZSW_NESTED"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["PI_SUBAGENT_SELF_RECORD_ID"]).toBeUndefined();
    expect(env["PI_SUBAGENT_DEPTH"]).toBeUndefined();
    expect(env["XYZ_AGENT_SUBAGENT"]).toBe("1");
  });
});

describe("launchZcodeProcess：真实子进程杀链（node -e 代替 CLI）", () => {
  // 杀链/exited 机制与 CLI 无关（对子进程发信号 + close 事件），用 `node -e <script>`
  // 验证机制本身：launchZcodeProcess 的 spawn 形态是 `node <cliPath> <args...>`，
  // 测试借 cliPath 槽位传 -e、args 传脚本内容。
  it("child 句柄暴露（D10 记账数据源）：proc.child 即 spawn 出的进程，退出码可读", async () => {
    const proc = launchZcodeProcess({
      cliPath: "-e",
      args: ["process.stdout.write('hi'); process.exit(0)"],
      env: process.env,
    });
    // 句柄与 pid 同源（宿主经 RunContext.onChildSpawned 注册进 spawnedChildren）
    expect(proc.child.pid).toBe(proc.pid);
    expect(proc.child.killed).toBe(false);
    const exited = await proc.exited;
    expect(exited.code).toBe(0);
    expect(proc.child.exitCode).toBe(0); // close 后 exitCode 可读（close 事件先于 exited resolve）
  });

  it("正常退出：exited 带退出码，stdout 可收集", async () => {
    const proc = launchZcodeProcess({
      cliPath: "-e",
      args: ["process.stdout.write('hello'); process.exit(0)"],
      env: process.env,
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exited = await proc.exited;
    expect(out).toBe("hello");
    expect(exited.code).toBe(0);
    expect(proc.killedByUs()).toBe(false);
  });

  it("abort 触发杀链：SIGTERM 后进程退出，killedByUs 标记", async () => {
    const proc = launchZcodeProcess({
      cliPath: "-e",
      args: ["setInterval(() => {}, 1000)"],
      env: process.env,
    });
    expect(proc.pid).toBeGreaterThan(0);
    // 实测 zcode 对 SIGTERM ~103ms 退出；普通 node 进程无 handler 直接终止
    const abortPromise = proc.abort(3000);
    const exited = await proc.exited;
    await abortPromise;
    expect(exited.code === null || exited.code === 143 || exited.code === 1).toBe(true);
    expect(proc.killedByUs()).toBe(true);
    // 无僵尸：进程已从系统进程表消失
    expect(() => execFileSync("ps", ["-p", String(proc.pid)])).toThrow();
  });

  it("abort 幂等：重复调用不再触发第二条杀链", async () => {
    const proc = launchZcodeProcess({
      cliPath: "-e",
      args: ["setInterval(() => {}, 1000)"],
      env: process.env,
    });
    await proc.abort(2000);
    await proc.abort(2000); // 不应抛
    await proc.exited;
  });
});
