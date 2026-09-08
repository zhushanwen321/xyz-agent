// src/__tests__/spawn-self-destruct.test.ts
//
// spawnEngineChild 形态断言（R9-4②：子进程 stdin 恒为自有 pipe，绝不继承引擎
// stdin fd）+ armEngineSelfDestruct 判据矩阵（主判据 stdio EOF / 辅助判据未 ack
// 计时超时 / 排除面 = 已 ack 与已终结请求）。自灭执行一律注入 killSelf fake，
// 绝不触达缺省的 process.kill（测试红线）。

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildEngineChildEnv } from "../env.ts";
import {
  armEngineSelfDestruct,
  DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS,
  ENGINE_HOST_REQUEST_TIMEOUT_ENV,
  spawnEngineChild,
} from "../spawn.ts";

/** fake stdin：EventEmitter 代 ReadableStream（once/removeAllListeners 面足够）。 */
function fakeStdin(): NodeJS.ReadableStream {
  return new EventEmitter() as unknown as NodeJS.ReadableStream;
}

describe("spawnEngineChild", () => {
  it("形态键（detached/stdio/stdin/windowsHide）出现即抛错——不暴露硬编码契约面", () => {
    const env = buildEngineChildEnv({}, { dataDir: "/d" });
    expect(() => spawnEngineChild({ command: "x", args: [], env, detached: true } as never))
      .toThrow(/detached/);
    expect(() => spawnEngineChild({ command: "x", args: [], env, stdio: "ignore" } as never))
      .toThrow(/stdio/);
    expect(() => spawnEngineChild({ command: "x", args: [], env, stdin: "inherit" } as never))
      .toThrow(/stdin/);
  });

  it("子进程 stdin 是自有 pipe 而非引擎 stdin fd（R9-4②）", async () => {
    const env = buildEngineChildEnv({}, { dataDir: "/d" });
    const child = spawnEngineChild({
      command: process.execPath,
      args: ["-e", "process.stdin.once('data', (d) => process.stdout.write(d.toString().trim().toUpperCase()))"],
      env,
    });
    expect(child.stdin).toBeDefined();
    // fd 不等：继承形态下子进程 stdin 会复用父 fd（0）；自有 pipe 是新 fd。
    const childStdinFd = (child.stdin as unknown as { fd: number }).fd;
    expect(childStdinFd).not.toBe(process.stdin.fd);
    expect(child.stdio[0]).not.toBe(process.stdin);

    const echoed = new Promise<string>((resolve) => {
      let out = "";
      child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
      child.stdout!.on("end", () => resolve(out.trim()));
    });
    child.stdin!.end("ping\n");
    expect(await echoed).toBe("PING");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }, 15_000);
});

describe("armEngineSelfDestruct", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("主判据：stdin EOF（end）→ 立即自灭", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    expect(kill).not.toHaveBeenCalled();
    stdin.emit("end");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("主判据：stdin close → 自灭；EOF 后重复事件幂等", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    stdin.emit("close");
    stdin.emit("end");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("辅助判据：未 ack 反向请求超时 → 自灭（缺省 30s）", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("req-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("排除面：已 ack 的 host/askUser / executeAndAwait 不计时（R9-2）", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("askUser-1");
    clock.acked("askUser-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 10);
    expect(kill).not.toHaveBeenCalled();
  });

  it("排除面：已终结（settled）请求不计时", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("req-1");
    clock.settled("req-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 10);
    expect(kill).not.toHaveBeenCalled();
  });

  it("混合面：未 ack 请求与已 ack 请求并存时，仅未 ack 触发", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("acked-early");
    clock.acked("acked-early");
    clock.started("pending-1");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS + 2_000);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("env 覆盖：XYZ_ENGINE_HOST_REQUEST_TIMEOUT_MS 生效；非法值回落缺省", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({
      stdin,
      killSelf: kill,
      timeoutEnv: { [ENGINE_HOST_REQUEST_TIMEOUT_ENV]: "1000" },
    });
    clock.started("req-1");
    vi.advanceTimersByTime(2_500);
    expect(kill).toHaveBeenCalledTimes(1);

    const stdin2 = fakeStdin();
    const kill2 = vi.fn();
    const clock2 = armEngineSelfDestruct({
      stdin: stdin2,
      killSelf: kill2,
      timeoutEnv: { [ENGINE_HOST_REQUEST_TIMEOUT_ENV]: "not-a-number" },
    });
    clock2.started("req-1");
    vi.advanceTimersByTime(1_000);
    expect(kill2).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS);
    expect(kill2).toHaveBeenCalledTimes(1);
  });

  it("dispose：正常 shutdown 卸载守卫（EOF 与计时均不再触发）", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    clock.started("req-1");
    clock.dispose();
    stdin.emit("end");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 2);
    expect(kill).not.toHaveBeenCalled();
    // dispose 幂等
    clock.dispose();
  });

  it("自灭后 started 不再进入计时面", () => {
    const stdin = fakeStdin();
    const kill = vi.fn();
    const clock = armEngineSelfDestruct({ stdin, killSelf: kill, timeoutEnv: {} });
    stdin.emit("end");
    clock.started("late-req");
    vi.advanceTimersByTime(DEFAULT_ENGINE_HOST_REQUEST_TIMEOUT_MS * 2);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
