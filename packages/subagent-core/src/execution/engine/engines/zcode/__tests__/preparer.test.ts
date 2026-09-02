// preparer.test.ts —— 池目录 SSOT / 原子写 / mtime 免重写 / 无 plugins 块 / 凭据与模型
// 前置错误（验收 3）。凭据源 = v2 config 单源（2026-08-25 拍板：不读
// ~/.zcode/cli/config.json——GUI 不管理该文件，可能残留历史验证配置）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { resolvePoolDir } from "../../../paths.ts";
import {
  ZcodePrepareError,
  computeZcodePoolKey,
  listZcodeModels,
  prepareZcodeHome,
  resolveZcodeModelRef,
} from "../preparer.ts";

let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

const PROVIDER_A = "builtin:bigmodel-coding-plan";
const PROVIDER_B = "e512d53e-test-provider";

function seedSources(): void {
  writeJson(v2Path, {
    provider: {
      [PROVIDER_A]: { options: { apiKey: "key-a", baseURL: "https://a.example" }, models: { "GLM-5.3": {}, "GLM-5.2": {} } },
      [PROVIDER_B]: { name: "test-router", options: { apiKey: "key-b", baseURL: "https://b.example" }, models: { "mimo-v2.5-pro": {} } },
      "no-key-provider": { options: { baseURL: "https://x.example" }, models: { "M1": {} } },
    },
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-preparer-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2-config.json");
  seedSources();
});

describe("resolveZcodeModelRef（v2 单源）", () => {
  it("显式全名解析 + 规范化", () => {
    expect(resolveZcodeModelRef(`${PROVIDER_B}/mimo-v2.5-pro`, { v2ConfigPath: v2Path })).toBe(
      `${PROVIDER_B}/mimo-v2.5-pro`,
    );
  });

  it("短名按默认 provider（builtin:bigmodel-coding-plan）解析", () => {
    expect(resolveZcodeModelRef("GLM-5.3", { v2ConfigPath: v2Path })).toBe(
      `${PROVIDER_A}/GLM-5.3`,
    );
  });

  it("未指定时落官方兜底（不受任何本机 CLI 配置影响）", () => {
    expect(resolveZcodeModelRef(undefined, { v2ConfigPath: v2Path })).toBe(
      `${PROVIDER_A}/GLM-5.3`,
    );
  });

  it("未知模型 → model_not_available（列该 provider 可用模型）", () => {
    try {
      resolveZcodeModelRef(`${PROVIDER_A}/nope`, { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZcodePrepareError);
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("model_not_available");
      expect(e.message).toContain("GLM-5.3, GLM-5.2");
    }
  });

  it("未知 provider → model_not_available（列带凭据 provider）", () => {
    try {
      resolveZcodeModelRef("ghost/m", { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("model_not_available");
      expect((err as ZcodePrepareError).message).toContain(PROVIDER_A);
      expect((err as ZcodePrepareError).message).toContain(PROVIDER_B);
    }
  });

  it("provider 存在但无 apiKey → engine_credential_missing", () => {
    try {
      resolveZcodeModelRef("no-key-provider/M1", { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("engine_credential_missing");
    }
  });

  it("v2 无任何带 apiKey 的 provider → engine_credential_missing（指向配置说明）", () => {
    writeJson(v2Path, { provider: {} });
    try {
      resolveZcodeModelRef(undefined, { v2ConfigPath: v2Path });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as ZcodePrepareError;
      expect(e.code).toBe("engine_credential_missing");
      expect(e.message).toContain("ZCode 桌面端");
      expect(e.message).toContain("docs/research/agent-engine-zcode.md");
    }
  });
});

describe("listZcodeModels（U7 可发现性）", () => {
  it("聚合 v2 带凭据 provider × models（含 name 拼接），无凭据/空清单过滤", () => {
    const models = listZcodeModels({ v2ConfigPath: v2Path });
    const ids = models.map((m) => m.id);
    expect(ids).toContain(`${PROVIDER_A}/GLM-5.3`);
    expect(ids).toContain(`${PROVIDER_A}/GLM-5.2`);
    expect(ids).toContain(`${PROVIDER_B}/mimo-v2.5-pro`);
    // 无凭据 provider 不进清单
    expect(ids.some((id) => id.startsWith("no-key-provider/"))).toBe(false);
    // name = "<provider.name> · <model>"（v2 有 name 字段时）
    const withName = models.find((m) => m.id === `${PROVIDER_B}/mimo-v2.5-pro`);
    expect(withName?.name).toBe("test-router · mimo-v2.5-pro");
  });

  it("v2 不可读 → 空清单（fail-safe）", () => {
    expect(listZcodeModels({ v2ConfigPath: path.join(tmpRoot, "absent.json") })).toEqual([]);
  });
});

describe("computeZcodePoolKey", () => {
  it("provider 特殊字符安全化 + model 短名保留点号（zsub homePoolDir 同构）", () => {
    expect(computeZcodePoolKey("builtin:bigmodel-coding-plan/GLM-5.3")).toBe(
      "home-builtin-bigmodel-coding-plan-GLM-5.3",
    );
    expect(computeZcodePoolKey("router/mimo-v2.5-pro")).toBe("home-router-mimo-v2.5-pro");
  });
});

describe("prepareZcodeHome（验收 3）", () => {
  it("池目录 = resolvePoolDir SSOT，config.json 原子写且无 plugins 块", () => {
    const prepared = prepareZcodeHome({
      engineDataDir: dataDir,
      modelRef: `${PROVIDER_A}/GLM-5.3`,
      taskId: "bg-1",
      sources: { v2ConfigPath: v2Path },
    });
    expect(prepared.wroteConfig).toBe(true);
    // 池目录必须与 paths.ts SSOT 同源（禁自拼）
    expect(prepared.homeDir).toBe(resolvePoolDir(dataDir, "zcode", prepared.poolKey));
    expect(prepared.poolKey).toBe("home-builtin-bigmodel-coding-plan-GLM-5.3");

    const written = JSON.parse(fs.readFileSync(prepared.configPath, "utf8")) as Record<string, unknown>;
    expect(written["model"]).toEqual({ main: `${PROVIDER_A}/GLM-5.3` });
    expect(Object.keys(written["provider"] as Record<string, unknown>)).toEqual([PROVIDER_A]);
    // 第二重门禁：刻意不写 plugins 块（防递归 + 不加载宿主插件）
    expect("plugins" in written).toBe(false);
    // 原子写：无 tmp 残留
    const leftovers = fs.readdirSync(path.dirname(prepared.configPath)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    // 只写目标 provider（每池单 provider 单模型，凭据落盘面最小）
    const providerEntry = (written["provider"] as Record<string, { options?: { apiKey?: string } }>)[PROVIDER_A]!;
    expect(providerEntry.options?.apiKey).toBe("key-a");
  });

  it("mtime 比对免重写：源未变时第二次 prepare 零写入", () => {
    const opts = {
      engineDataDir: dataDir,
      modelRef: `${PROVIDER_A}/GLM-5.3`,
      taskId: "bg-2",
      sources: { v2ConfigPath: v2Path },
    };
    const first = prepareZcodeHome(opts);
    expect(first.wroteConfig).toBe(true);
    const statAfterFirst = fs.statSync(first.configPath);
    const second = prepareZcodeHome(opts);
    expect(second.wroteConfig).toBe(false);
    expect(fs.statSync(second.configPath).mtimeMs).toBe(statAfterFirst.mtimeMs);
  });

  it("源 config 变新（mtime 推进）触发重写（凭据刷新传播）", async () => {
    const opts = {
      engineDataDir: dataDir,
      modelRef: `${PROVIDER_A}/GLM-5.3`,
      taskId: "bg-3",
      sources: { v2ConfigPath: v2Path },
    };
    prepareZcodeHome(opts);
    // 源 mtime 推到未来（模拟桌面端刷新 apiKey）
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(v2Path, future, future);
    const again = prepareZcodeHome(opts);
    expect(again.wroteConfig).toBe(true);
  });

  it("池 config 损坏（torn write 形态）时重建", () => {
    const opts = {
      engineDataDir: dataDir,
      modelRef: `${PROVIDER_A}/GLM-5.3`,
      taskId: "bg-4",
      sources: { v2ConfigPath: v2Path },
    };
    const first = prepareZcodeHome(opts);
    fs.writeFileSync(first.configPath, "{ torn", "utf8");
    const again = prepareZcodeHome(opts);
    expect(again.wroteConfig).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(again.configPath, "utf8"))).not.toThrow();
  });

  it("v2 注册表内非默认 provider（如自定义 UUID provider）也能建池", () => {
    const prepared = prepareZcodeHome({
      engineDataDir: dataDir,
      modelRef: `${PROVIDER_B}/mimo-v2.5-pro`,
      taskId: "bg-5",
      sources: { v2ConfigPath: v2Path },
    });
    const written = JSON.parse(fs.readFileSync(prepared.configPath, "utf8")) as {
      provider: Record<string, { options?: { apiKey?: string } }>;
    };
    expect(written.provider[PROVIDER_B]!.options?.apiKey).toBe("key-b");
  });

  it("模型引用在 v2 不存在 → model_not_available", () => {
    try {
      prepareZcodeHome({ engineDataDir: dataDir, modelRef: "ghost/m", taskId: "bg-6", sources: { v2ConfigPath: v2Path } });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("model_not_available");
    }
  });
});

describe("prepareZcodeHome 池引用接线（D8）", () => {
  it("建池经 acquirePool：refs.json 落盘登记 taskId（幂等刷新）", () => {
    const opts = {
      engineDataDir: dataDir,
      modelRef: `${PROVIDER_A}/GLM-5.3`,
      taskId: "bg-7-pool",
      sources: { v2ConfigPath: v2Path },
    };
    const first = prepareZcodeHome(opts);
    const refsPath = path.join(first.homeDir, "refs.json");
    expect(fs.existsSync(refsPath)).toBe(true);
    const refs1 = JSON.parse(fs.readFileSync(refsPath, "utf8")) as {
      v: number;
      refs: Record<string, { taskId: string; ts: number }>;
    };
    expect(refs1.v).toBe(1);
    expect(Object.keys(refs1.refs)).toEqual(["bg-7-pool"]);

    // 幂等：同 taskId 重复 acquire（chatMode 续轮）不新增条目
    prepareZcodeHome(opts);
    const refs2 = JSON.parse(fs.readFileSync(refsPath, "utf8")) as {
      refs: Record<string, { taskId: string; ts: number }>;
    };
    expect(Object.keys(refs2.refs)).toEqual(["bg-7-pool"]);

    // 不同 taskId（同池并发）登记为独立引用
    prepareZcodeHome({ ...opts, taskId: "bg-8-pool" });
    const refs3 = JSON.parse(fs.readFileSync(refsPath, "utf8")) as {
      refs: Record<string, { taskId: string; ts: number }>;
    };
    expect(Object.keys(refs3.refs).sort()).toEqual(["bg-7-pool", "bg-8-pool"]);
  });
});
