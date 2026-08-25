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
      [PROVIDER_B]: { options: { apiKey: "key-b", baseURL: "https://b.example" }, models: { "mimo-v2.5-pro": {} } },
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
      sources: { v2ConfigPath: v2Path },
    });
    const written = JSON.parse(fs.readFileSync(prepared.configPath, "utf8")) as {
      provider: Record<string, { options?: { apiKey?: string } }>;
    };
    expect(written.provider[PROVIDER_B]!.options?.apiKey).toBe("key-b");
  });

  it("模型引用在 v2 不存在 → model_not_available", () => {
    try {
      prepareZcodeHome({ engineDataDir: dataDir, modelRef: "ghost/m", sources: { v2ConfigPath: v2Path } });
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ZcodePrepareError).code).toBe("model_not_available");
    }
  });
});
