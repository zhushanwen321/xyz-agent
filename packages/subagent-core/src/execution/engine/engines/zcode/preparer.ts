// src/execution/engine/engines/zcode/preparer.ts
//
// ZcodeEngine preparer（P3）：spawn 前唯一副作用模块（设计 §3.3.7）——隔离 HOME 池化
// + 池内 config.json 引导（凭据 + model.main）。TS 重写自 zsub 的
// bootstrapIsolatedHome / model-router.js（真机验证过的机制），差异点：
//   - **凭据源 = v2 config 单源（2026-08-25 用户拍板）**：只读 `~/.zcode/v2/config.json`
//     （ZCode 桌面登录态落点，GUI 管理面）。曾泛化过「v2 + cli config 双源合并」，
//     但 `~/.zcode/cli/config.json` 不在 GUI 管理面、可能残留历史验证配置
//     （8/24 zsub 开发残留把默认模型劫持到失效 router 端点的 401 事故），撤掉依赖；
//   - 池目录必须经 resolvePoolDir（paths.ts SSOT，禁自拼——池布局要与 journal/refs
//     共享同一形状，设计 §3.3.9）；
//   - 凭据缺失/模型不可解析抛结构化 ZcodePrepareError（错误码对齐设计 §3.3.3：
//     engine_credential_missing / model_not_available），一律先于进程创建。
//
// 为什么池按 provider+model 隔离（与设计 §3.3.9「agent 名池」不同）：并发 run 指向
// 同一 HOME 但模型不同时，config.json 的 model.main 会出现「后写覆盖先写」的串池——
// zsub 的 per-model HOME 池正是防这个；本引擎以 provider+model 为隔离粒度，agent 维度
// 的池化留给宿主 refs.json（W3 对齐点）。
//
// [R4 D7] app-server 常驻 HOME 语义（锁/派生/pidfile 孤儿回收/allProviders 引导/
// 凭据内容 hash 刷新）拆至同目录 appserver-home.ts——单一关注点分立。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolvePoolDir } from "../../paths.ts";
import {
  ZCODE_FALLBACK_DEFAULT_MODEL,
  ZCODE_POOL_CONFIG_SUFFIX,
  ZCODE_V2_CONFIG_PATH_SUFFIX,
} from "./constants.ts";

// ============================================================
// 结构化错误（prepare 期——进程创建前 reject 的载体）
// ============================================================

export type ZcodePrepareErrorCode =
  | "engine_credential_missing"
  | "model_not_available"
  | "engine_capability_unsupported";

/** prepare 期错误：code 对齐设计 §3.3.3 错误规格表，message 自带恢复指引。 */
export class ZcodePrepareError extends Error {
  readonly code: ZcodePrepareErrorCode;

  constructor(code: ZcodePrepareErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ZcodePrepareError";
    this.code = code;
  }
}

// ============================================================
// 源 config 读取（运行时 guard，禁 any）
// ============================================================

/** provider 注册表条目的最小消费面（凭据 + 模型清单校验）。 */
export interface ZcodeProviderEntry {
  options?: { apiKey?: unknown };
  models?: Record<string, unknown>;
  [k: string]: unknown;
}

interface SourceConfig {
  /** provider 注册表（来自 v2 config，逐条运行时 guard）。 */
  providers: Map<string, ZcodeProviderEntry>;
  /** 源文件 mtime（池 config 免重写的比对基准；不可读 = 0）。 */
  mtimeMs: number;
}

/** unknown 的 Record 窄化 guard（替代 as 全可选断言——taste/no-unsafe-cast）。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** provider 条目一律按 ZcodeProviderEntry 消费（索引签名形态，无需逐键校验）。 */
export function isProviderEntry(v: unknown): v is ZcodeProviderEntry {
  return isRecord(v);
}

export function readSourceConfig(absPath: string): SourceConfig {
  const empty: SourceConfig = { providers: new Map(), mtimeMs: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  const conf: SourceConfig = { providers: new Map(), mtimeMs: 0 };
  const provider = parsed["provider"];
  if (isRecord(provider)) {
    for (const [id, entry] of Object.entries(provider)) {
      if (isProviderEntry(entry)) conf.providers.set(id, entry);
    }
  }
  try {
    conf.mtimeMs = fs.statSync(absPath).mtimeMs;
  } catch {
    // 源被并发删除等场景：mtime 取 0（比对恒不触发重写，池内完好配置继续用）
    conf.mtimeMs = 0;
  }
  return conf;
}

// ============================================================
// 模型解析（v2 单源，zsub resolve 同构）
// ============================================================

function modelShort(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function providerOf(ref: string): string {
  return ref.slice(0, ref.lastIndexOf("/"));
}

/** [R4] 规范化全名 provider/model → create 参数的 per-session model 拆分（A.2 ① strict 对象）。 */
export function splitZcodeModelRef(modelRef: string): { providerId: string; modelId: string } {
  return { providerId: providerOf(modelRef), modelId: modelShort(modelRef) };
}

export function hasApiKey(entry: ZcodeProviderEntry): boolean {
  const key = entry.options?.apiKey;
  return typeof key === "string" && key !== "";
}

export interface ZcodeSourcePaths {
  /** 桌面登录态 config（唯一凭据源）。缺省 ~/.zcode/v2/config.json。 */
  v2ConfigPath?: string;
}

export function defaultV2ConfigPath(): string {
  return path.join(os.homedir(), ...ZCODE_V2_CONFIG_PATH_SUFFIX);
}

/** 短名（无 provider 前缀）解析的默认 provider（zsub DEFAULT_PROVIDER_ID 同构）。 */
const DEFAULT_PROVIDER_ID = "builtin:bigmodel-coding-plan";

/**
 * 短名模型（如 "GLM-5.3"）的默认 provider 决策。让位条件（对齐点⑦）：显式默认引擎
 * 模型配置引入时（config.json 出现 per-engine model 映射 / engineRouting 级模型缺省），
 * 本函数的「内置常量优先」须让位为「配置值优先」——引擎路由层（engine/routing.ts 的
 * taskModel 判定处）是引入该配置时应同步调整的决策点，避免出现「路由按配置模型选了
 * 引擎、prepare 却按内置常量落池」的分裂。首期无该配置，常量即权威。
 */
function defaultProviderForShortName(
  merged: Map<string, ZcodeProviderEntry>,
  withKey: Array<[string, ZcodeProviderEntry]>,
): string {
  if (merged.has(DEFAULT_PROVIDER_ID)) return DEFAULT_PROVIDER_ID;
  return withKey[0]![0];
}

/**
 * 解析并校验模型引用 → 规范化全名 `provider/model`。
 *
 * 解析链（requested > 默认链）：
 *   1. 显式 requested（task.model）；
 *   2. ZCODE_FALLBACK_DEFAULT_MODEL（zsub 同构兜底）。
 *
 * 校验对「带 apiKey 的 provider 注册表」做（没配凭据的 provider 写进池也跑不起来，
 * resolve 期报错比运行时挂掉可诊断——zsub 经验）。provider 存在但无 apiKey →
 * engine_credential_missing；provider/模型不存在 → model_not_available（列可用清单）。
 */
export function resolveZcodeModelRef(requested: string | undefined, sources?: ZcodeSourcePaths): string {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  const merged = v2.providers;
  const withKey = [...merged.entries()].filter(([, e]) => hasApiKey(e));
  const wanted = requested?.trim() || undefined;
  const target = wanted ?? ZCODE_FALLBACK_DEFAULT_MODEL;

  if (withKey.length === 0) {
    const hint = wanted
      ? `model="${wanted}" 不能校验`
      : `默认模型 "${target}" 不能校验`;
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `zcode 引擎找不到任何带 apiKey 的 provider（${hint}）。已读源：${sources?.v2ConfigPath ?? defaultV2ConfigPath()}。` +
        `恢复指引：先在 ZCode 桌面端登录并配置 provider（v2 config 内存在含 apiKey 的条目）后重试；` +
        `凭据配置说明见 docs/research/agent-engine-zcode.md。`,
    );
  }

  const provider = target.includes("/")
    ? providerOf(target)
    : defaultProviderForShortName(merged, withKey);
  const short = modelShort(target);
  const entry = merged.get(provider);
  if (!entry) {
    const known = withKey.map(([id]) => id).join(", ");
    throw new ZcodePrepareError(
      "model_not_available",
      `未知 provider "${provider}"（带凭据的 provider: ${known}）。` +
        `恢复指引：改用上述 provider 之一（全名 provider/model），或先在 ZCode 桌面端配置该 provider 后重试。`,
    );
  }
  if (!hasApiKey(entry)) {
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" 存在但未配置 apiKey。` +
        `恢复指引：在 ZCode 桌面端为该 provider 登录配置凭据，或改用已配凭据的 provider（${withKey.map(([id]) => id).join(", ")}）后重试。`,
    );
  }
  const models = Object.keys(entry.models ?? {});
  if (models.length > 0 && !models.includes(short)) {
    throw new ZcodePrepareError(
      "model_not_available",
      `未知模型 "${short}"（provider ${provider} 下可用: ${models.join(", ")}）。` +
        `恢复指引：改用该 provider 下的模型，或先在 ZCode 桌面端启用目标模型后重试。`,
    );
  }
  return `${provider}/${short}`;
}

// ============================================================
// 模型清单（U7 可发现性——v2 单源聚合，与 resolveZcodeModelRef 的凭据校验同判据）
// ============================================================

/**
 * 列出当前环境 zcode 引擎实际可用的模型（v2 config 内带 apiKey 的 provider × 其
 * models 清单）。消费方：EnginePort.listModels（system prompt 引擎段 / GUI）。
 * 失败安全：v2 config 不可读 → 空清单（可发现性降级不阻塞主流程）。
 */
export function listZcodeModels(sources?: ZcodeSourcePaths): Array<{ id: string; name?: string }> {
  const v2 = readSourceConfig(sources?.v2ConfigPath ?? defaultV2ConfigPath());
  const out: Array<{ id: string; name?: string }> = [];
  for (const [pid, entry] of v2.providers) {
    if (!hasApiKey(entry)) continue;
    const providerName =
      typeof entry["name"] === "string" && entry["name"].trim() !== "" ? entry["name"].trim() : undefined;
    const models = Object.keys(entry.models ?? {});
    for (const model of models) {
      out.push({
        id: `${pid}/${model}`,
        ...(providerName !== undefined ? { name: `${providerName} · ${model}` } : {}),
      });
    }
  }
  return out;
}

// ============================================================
// 池 key 与目录
// ============================================================

/** provider id 安全化（builtin:bigmodel → builtin-bigmodel；zsub providerDirName 同构）。 */
function sanitizeProviderDirName(p: string): string {
  return p.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * 池 key：`home-<provider>-<modelShort>`（zsub homePoolDir 同构——provider+model 维度
 * 隔离防并发串池，见文件头注释）。model 短名只清洗路径敌对字符（分隔符/空白），
 * 保留点号（GLM-5.3 / mimo-v2.5-pro 原样——zsub 同判）；进入文件系统时由
 * resolvePoolDir 的 sanitizeSeg 再做一层统一编码。
 */
export function computeZcodePoolKey(modelRef: string): string {
  const provider = providerOf(modelRef);
  const short = modelShort(modelRef).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `home-${sanitizeProviderDirName(provider)}-${short.length > 0 ? short : "default"}`;
}

// ============================================================
// 隔离 HOME 引导（bootstrapIsolatedHome TS 重写）
// ============================================================

export interface ZcodePreparedHome {
  /** 规范化模型全名 provider/model。 */
  modelRef: string;
  /** 池 key（handle.poolKey 数据源）。 */
  poolKey: string;
  /** 池目录绝对路径 = 隔离 HOME。 */
  homeDir: string;
  /** 池内 config.json 绝对路径。 */
  configPath: string;
  /** 本次是否实际重写了 config（mtime 免重写命中时 false——resume/复用轮零开销）。 */
  wroteConfig: boolean;
}

/**
 * 池 config 是否需要重写（zsub homeNeedsBootstrap 同构）：
 *   1. 池目录或池内 config.json 不存在（首次建池）；
 *   2. 池内 config.json 损坏（torn write 防线：mtime 看似新但内容不完整）；
 *   3. 任一「实际被用到的」源 config 的 mtime 比池内 config 新（凭据/模型清单刷新过）。
 * 源不可读但池配置完好：保留池现状——没有更好依据时不破坏可用状态。
 */
function homeNeedsBootstrap(configPath: string, sourceMtimeMs: number): boolean {
  if (!fs.existsSync(configPath)) return true;
  let poolMtimeMs = 0;
  try {
    JSON.parse(fs.readFileSync(configPath, "utf8"));
    poolMtimeMs = fs.statSync(configPath).mtimeMs;
  } catch {
    return true;
  }
  return sourceMtimeMs > poolMtimeMs;
}

/** 池 config.json 缩进（人读友好——与 zsub 产出的文件形态一致）。 */
export const CONFIG_INDENT_SPACES = 2;

/**
 * 引导隔离 HOME 的 provider 配置（spawn 前调用）。
 *
 * - 只写 {model, provider}，刻意不含 plugins 块：第二重门禁——subagent 进程在隔离
 *   HOME 下不加载宿主插件（含 subagent-workflow 自身），物理隔断递归派发。
 * - tmp+rename 原子写：跨进程并发 bootstrap 下读者永远看到完整文件。进程内无需
 *   zsub 的互斥链——本实现全同步 fs（无 await 让出点），单线程事件循环天然不交错。
 * - 只写目标 provider 一个条目（spawn 池每池单 provider 单模型，凭据落盘面最小）。
 */
export function prepareZcodeHome(opts: {
  engineDataDir: string;
  modelRef: string;
  sources?: ZcodeSourcePaths;
}): ZcodePreparedHome {
  const { engineDataDir, modelRef } = opts;
  const poolKey = computeZcodePoolKey(modelRef);
  const homeDir = resolvePoolDir(engineDataDir, "zcode", poolKey);
  const configPath = path.join(homeDir, ...ZCODE_POOL_CONFIG_SUFFIX);

  const v2Path = opts.sources?.v2ConfigPath ?? defaultV2ConfigPath();
  const v2 = readSourceConfig(v2Path);
  const provider = providerOf(modelRef);
  const entry = v2.providers.get(provider);
  if (entry === undefined) {
    // provider 不在 v2 注册表：模型引用不可解释（resolve 期漏网或直接调用）
    throw new ZcodePrepareError(
      "model_not_available",
      `未知 provider "${provider}"（v2 config 无该条目：${v2Path}）。` +
        `恢复指引：先经 resolveZcodeModelRef 校验模型引用，或先在 ZCode 桌面端配置该 provider 后重试。`,
    );
  }
  if (!hasApiKey(entry)) {
    // provider 存在但无凭据：resolve 与 bootstrap 之间凭据被撤（并发改动）
    throw new ZcodePrepareError(
      "engine_credential_missing",
      `provider "${provider}" 存在但未配置 apiKey（${v2Path} 重读无凭据）。` +
        `恢复指引：确认 ZCode 桌面端登录态有效后重试；凭据配置说明见 docs/research/agent-engine-zcode.md。`,
    );
  }

  const hitSourceMtime = v2.mtimeMs;
  let wroteConfig = false;
  if (homeNeedsBootstrap(configPath, hitSourceMtime)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const payload = JSON.stringify({ model: { main: modelRef }, provider: { [provider]: entry } }, null, CONFIG_INDENT_SPACES);
    const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, configPath);
    } finally {
      // rename 成功后 tmp 已不存在；失败时清残留，避免污染 HOME 目录
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (err) {
        // rename 失败路径的残留清理是 best-effort——记录后继续（tmp 文件不参与读取）
        void err;
      }
    }
    wroteConfig = true;
  }
  return { modelRef, poolKey, homeDir, configPath, wroteConfig };
}

