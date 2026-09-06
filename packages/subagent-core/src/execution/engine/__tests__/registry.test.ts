// src/execution/engine/__tests__/registry.test.ts
//
// registry 专属测试（P1 验收 4）：注册/获取/listEngines/hasEngine/
// 未注册 id 报 engine_not_found（错误文案含已注册清单——错误规格表第 1 行契约）。
// [R1 D6] 追加：重注册先 dispose 旧单例（D6②）+ disposeEngines 收割遍历（D6③）。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnginePort, RunContext } from "../port.ts";
import {
  clearEngines,
  DEFAULT_ENGINE_ID,
  disposeEngines,
  EngineNotFoundError,
  getEngine,
  hasEngine,
  listEngines,
  registerEngine,
} from "../registry.ts";
import type { SessionView } from "../types.ts";
import type { AgentCallOpts } from "../../../orchestration/models/types.ts";

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
    run: (_task: AgentCallOpts, _ctx: RunContext) =>
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

  // ── [R1 D6②] 重注册同名：先 dispose 已实例化的旧单例（防常驻资源泄漏）──

  it("重注册同名：已实例化的旧单例 dispose 被调用一次，新工厂实例生效", () => {
    const dispose = vi.fn(() => Promise.resolve());
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    getEngine("fake"); // 实例化旧引擎（未实例化 = 无常驻资源可回收）
    registerEngine("fake", () => makeFakeEngine("fake-v2"));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("fake").id).toBe("fake-v2");
  });

  it("重注册同名：旧实例 dispose 同步 throw 不阻断替换（best-effort）", () => {
    const dispose = vi.fn(() => {
      throw new Error("dispose boom");
    });
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    getEngine("fake");
    expect(() => registerEngine("fake", () => makeFakeEngine("fake-v2"))).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getEngine("fake").id).toBe("fake-v2");
  });

  it("重注册同名：旧实例 dispose 异步 reject 不阻断替换、不产生 unhandledRejection", async () => {
    const dispose = vi.fn(() => Promise.reject(new Error("dispose async boom")));
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    getEngine("fake");
    expect(() => registerEngine("fake", () => makeFakeEngine("fake-v2"))).not.toThrow();
    expect(getEngine("fake").id).toBe("fake-v2");
    // flush macrotask：reject 必须已被 registry 侧 catch 吞掉——否则 vitest 以
    // unhandledRejection 判本文件失败，用例即失效
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("重注册同名：旧引擎仅注册工厂未实例化时不触发 dispose（惰性单例无资源）", () => {
    const dispose = vi.fn(() => Promise.resolve());
    registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
    // 不 getEngine——singletons 无记录
    registerEngine("fake", () => makeFakeEngine("fake-v2"));
    expect(dispose).not.toHaveBeenCalled();
  });

  it("重注册同名：旧实例未实现 dispose（可选成员）时直接替换不抛", () => {
    registerEngine("fake", () => makeFakeEngine("fake"));
    getEngine("fake");
    expect(() => registerEngine("fake", () => makeFakeEngine("fake-v2"))).not.toThrow();
  });

  // ── [R1 D6③] disposeEngines：宿主收割（killAllSpawnedChildren）前的触发遍历 ──

  describe("disposeEngines（D6③）", () => {
    it("只对已实例化的引擎触发 dispose（绝不实例化未用引擎）", () => {
      const instantiated = vi.fn(() => Promise.resolve());
      const neverInstantiated = vi.fn(() => Promise.resolve());
      registerEngine("used", () => ({ ...makeFakeEngine("used"), dispose: instantiated }));
      registerEngine("unused", () => ({ ...makeFakeEngine("unused"), dispose: neverInstantiated }));
      getEngine("used");
      disposeEngines();
      expect(instantiated).toHaveBeenCalledTimes(1);
      expect(neverInstantiated).not.toHaveBeenCalled();
    });

    it("未实现 dispose 的引擎（可选面）跳过不抛", () => {
      registerEngine("plain", () => makeFakeEngine("plain"));
      getEngine("plain");
      expect(() => disposeEngines()).not.toThrow();
    });

    it("dispose 幂等（实现承诺）：disposeEngines 重复调用不抛、逐次触发", async () => {
      const dispose = vi.fn(() => Promise.resolve());
      registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
      getEngine("fake");
      expect(() => disposeEngines()).not.toThrow();
      expect(() => disposeEngines()).not.toThrow();
      // 幂等语义由引擎实现承诺（不变量 4），本断言只验证 registry 重复触发不抛
      expect(dispose).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    it("dispose 后单例保留（run 自动重建归引擎承诺，registry 不删——不变量 4 边界）", () => {
      const dispose = vi.fn(() => Promise.resolve());
      registerEngine("fake", () => ({ ...makeFakeEngine("fake"), dispose }));
      const engine = getEngine("fake");
      disposeEngines();
      expect(getEngine("fake")).toBe(engine);
    });
  });
});
