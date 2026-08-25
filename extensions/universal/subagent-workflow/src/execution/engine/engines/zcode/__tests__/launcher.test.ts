// launcher.test.ts —— argv 组装 / 字节估算超限 / env 构造 / 真实子进程杀链（用 node -e
// 代替 zcode CLI，验证 SIGTERM→grace→SIGKILL 与 exited 标志机制本身）。

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ZCODE_ARGV_LIMIT_BYTES } from "../constants.ts";
import {
  assertArgvWithinLimit,
  buildZcodeArgv,
  buildZcodeEnv,
  estimateArgvBytes,
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

describe("estimateArgvBytes / assertArgvWithinLimit", () => {
  it("估算 = Σ(byteLength + 1)（NUL 分隔近似），含 node 与 cliPath 前导", () => {
    const est = estimateArgvBytes("node", "/cli.cjs", ["--json"]);
    expect(est).toBe("node".length + 1 + "/cli.cjs".length + 1 + "--json".length + 1);
  });

  it("中文 prompt 按字节计（非字符数）", () => {
    const est = estimateArgvBytes("n", "c", ["--prompt", "中文"]);
    expect(est).toBe(2 + 2 + ("--prompt".length + 1) + Buffer.byteLength("中文") + 1);
  });

  it("超 128KB 阈值抛 prompt_too_large（含恢复指引）", () => {
    const bigPrompt = "x".repeat(ZCODE_ARGV_LIMIT_BYTES);
    expect(() => assertArgvWithinLimit("node", "/cli.cjs", ["--prompt", bigPrompt])).toThrowError(
      /prompt_too_large/,
    );
    try {
      assertArgvWithinLimit("node", "/cli.cjs", ["--prompt", bigPrompt]);
    } catch (err) {
      expect((err as { code: string }).code).toBe("prompt_too_large");
      expect((err as Error).message).toContain("engine: pi");
    }
  });

  it("阈值内不抛", () => {
    expect(() => assertArgvWithinLimit("node", "/cli.cjs", ["--prompt", "x".repeat(1024)])).not.toThrow();
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
