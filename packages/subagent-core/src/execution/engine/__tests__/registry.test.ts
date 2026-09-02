// src/execution/engine/__tests__/registry.test.ts
//
// registry 专属测试（P1 验收 4）：注册/获取/listEngines/hasEngine/
// 未注册 id 报 engine_not_found（错误文案含已注册清单——错误规格表第 1 行契约）。

import { beforeEach, describe, expect, it } from "vitest";

import type { EnginePort, RunContext } from "../port.ts";
import {
  clearEngines,
  DEFAULT_ENGINE_ID,
  EngineNotFoundError,
  getEngine,
  hasEngine,
  listEngines,
  registerEngine,
} from "../registry.ts";
import type { AgentTaskSpec, SessionView } from "../types.ts";

/** 最小可运行假引擎（完整实现 EnginePort 五面——不 cast，防接口漂移失检）。 */
function makeFakeEngine(id: string): EnginePort {
  return {
    id,
    capabilities: () => ({
      schemaEnforcement: "native",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "none",
      sessionRead: "outcome-only",
      resume: "unsupported",
      interrupt: "kill-only",
      permissionMode: "fixed",
      maxTurns: false,
    }),
    probe: () =>
      Promise.resolve({ ok: true, engineVersion: "0.0.0-test", checks: [{ name: "stub", ok: true }] }),
    run: (_task: AgentTaskSpec, _ctx: RunContext) =>
      Promise.reject(new Error("fake engine: run not implemented")),
    interact: () => Promise.resolve({ ok: false, code: "engine_capability_unsupported", message: "stub" }),
    read: (_handle: Parameters<EnginePort["read"]>[0]): Promise<SessionView> =>
      Promise.resolve({ engineId: id, turns: [], source: "outcome-only" }),
  };
}

describe("engine registry", () => {
  beforeEach(() => {
    // 测试隔离：registry 是进程级全局状态，防用例间工厂/单例泄漏串扰
    clearEngines();
  });

  it("registerEngine + getEngine：按 id 取回引擎实例", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    const engine = getEngine("fake");
    expect(engine.id).toBe("fake");
  });

  it("getEngine 惰性单例：同一 id 重复获取返回同一实例（§3.3.1 registry 持 per-engine 单例）", () => {
    let created = 0;
    registerEngine("fake", () => {
      created++;
      return makeFakeEngine("fake");
    });
    const a = getEngine("fake");
    const b = getEngine("fake");
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  it("registerEngine 覆盖同 id：丢弃旧单例，下次 getEngine 用新工厂重建（幂等重注册）", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    const first = getEngine("fake");
    registerEngine("fake", () => makeFakeEngine("fake-v2"));
    const second = getEngine("fake");
    expect(second).not.toBe(first);
    expect(second.id).toBe("fake-v2");
  });

  it("listEngines 返回注册序清单，hasEngine 判注册态（不触发工厂副作用）", () => {
    let created = 0;
    registerEngine("alpha", () => {
      created++;
      return makeFakeEngine("alpha");
    });
    registerEngine("beta", () => makeFakeEngine("beta"));
    expect(listEngines()).toEqual(["alpha", "beta"]);
    expect(hasEngine("alpha")).toBe(true);
    expect(hasEngine("gamma")).toBe(false);
    // hasEngine 不取实例——工厂未执行
    expect(created).toBe(0);
  });

  it("未注册 id → EngineNotFoundError（code=engine_not_found，文案含已注册清单）", () => {
    registerEngine("pi", () => makeFakeEngine("pi"));
    let caught: unknown;
    try {
      getEngine("zcode");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineNotFoundError);
    if (!(caught instanceof EngineNotFoundError)) throw new Error("unreachable");
    expect(caught.code).toBe("engine_not_found");
    expect(caught.engineId).toBe("zcode");
    // 错误规格表第 1 行契约：指向注册表清单 + 配置文件路径
    expect(caught.message).toContain("engine_not_found");
    expect(caught.message).toContain("'zcode'");
    expect(caught.message).toContain("pi");
    expect(caught.message).toContain("frontmatter");
  });

  it("空注册表时未注册 id 错误不崩（清单为 none）", () => {
    expect(() => getEngine("anything")).toThrow(EngineNotFoundError);
    expect(() => getEngine("anything")).toThrow(/\(none\)/);
  });

  it("DEFAULT_ENGINE_ID 缺省为 'pi'（D9：回填期零风险默认）", () => {
    expect(DEFAULT_ENGINE_ID).toBe("pi");
  });
});
