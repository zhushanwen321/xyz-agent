// model-prompt.test.ts —— [U7] 引擎模型段注入的开关语义（defaultEngine）与段格式。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnginePort } from "../port.ts";
import { clearEngines, registerEngine } from "../registry.ts";
import { buildEngineModelsPromptAppend } from "../model-prompt.ts";

/** 最小 fake 引擎：仅 id + 可选 listModels（其余面 run/read 走不到，测试只触碰注入链）。 */
function fakeEngine(id: string, models: Array<{ id: string; name?: string }> | null): EnginePort {
  return {
    id,
    capabilities: () => ({ conversation: "unsupported", steer: "unsupported", sandbox: "none" }),
    probe: async () => ({ ok: true, engineVersion: "test" }),
    run: async () => {
      throw new Error("not used in this test");
    },
    interact: async () => {
      throw new Error("not used in this test");
    },
    read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
    ...(models !== null ? { listModels: () => models } : {}),
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-prompt-"));
  clearEngines();
});

afterEach(() => {
  clearEngines();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("buildEngineModelsPromptAppend（defaultEngine 开关语义）", () => {
  it("defaultEngine 缺省 / 'pi' → 不注入（pi 段由核心提供）", () => {
    registerEngine("zcode", () => fakeEngine("zcode", [{ id: "p/m1" }]));
    expect(buildEngineModelsPromptAppend(undefined)).toBe("");
    expect(buildEngineModelsPromptAppend("pi")).toBe("");
    expect(buildEngineModelsPromptAppend("  ")).toBe("");
  });

  it("defaultEngine=zcode 且引擎实现 listModels → 注入段（含分界说明与模型 id）", () => {
    registerEngine("zcode", () =>
      fakeEngine("zcode", [
        { id: "builtin:bigmodel-coding-plan/GLM-5.3", name: "Z.ai - Coding Plan · GLM-5.3" },
        { id: "e512/mimo-v2.5-pro" },
      ]),
    );
    const append = buildEngineModelsPromptAppend("zcode");
    expect(append).toContain("<available_zcode_models>");
    expect(append).toContain("</available_zcode_models>");
    expect(append).toContain("<id>builtin:bigmodel-coding-plan/GLM-5.3</id>");
    expect(append).toContain("<name>Z.ai - Coding Plan · GLM-5.3</name>");
    expect(append).toContain("<id>e512/mimo-v2.5-pro</id>");
    // 分界语义：pi 段的 id 不适用于本引擎
    expect(append).toContain("do NOT apply to engine 'zcode'");
  });

  it("引擎未实现 listModels / 清单为空 / 未注册引擎 → 不注入（可发现性降级）", () => {
    registerEngine("bare", () => fakeEngine("bare", null));
    expect(buildEngineModelsPromptAppend("bare")).toBe("");
    registerEngine("empty", () => fakeEngine("empty", []));
    expect(buildEngineModelsPromptAppend("empty")).toBe("");
    expect(buildEngineModelsPromptAppend("ghost")).toBe("");
  });

  it("listModels 抛异常 → fail-safe 不注入", () => {
    const throwing: EnginePort = {
      ...fakeEngine("boom", null),
      listModels: () => {
        throw new Error("v2 config broken");
      },
    };
    registerEngine("boom", () => throwing);
    expect(buildEngineModelsPromptAppend("boom")).toBe("");
  });
});
