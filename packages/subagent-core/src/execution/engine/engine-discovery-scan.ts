// src/execution/engine/engine-discovery-scan.ts
//
// [W4] 引擎发现器：manifest 解析 + 三级搜索路径 + cli descriptor 装载。
// 设计权威源：docs/design/subagent-engine-protocolization.md §3.4 发现与注册；
// 实现级规格 impl-plan §2.4。
//
// 自注册模型（G1「新引擎零改 core」）：引擎包在自己的 package.json 里声明
// `xyz-agent.subagentEngine` manifest，发现器扫描三级搜索路径命中即解析 manifest、
// 装配 cli descriptor（portFactory = W2 EngineClient + RemoteEngine）并经
// registerEngineDescriptor 装载进注册表——core 与本文件都不枚举引擎。
//
// 三级路径：
//   L1 宿主发现根 = env `XYZ_AGENT_ENGINE_ROOTS`（path.delimiter 分隔）+
//     HostServices.discoveryRoots().engines（宿主模块域，pi 壳在 pi-host.ts 提供）；
//   L2 node 解析 = 宿主进程模块解析域的 node_modules（require.resolve 候选目录链的
//     扫描化，见 deriveNodeModuleRoots）；打包态与 zsw vendor 态自然为空（规格明确
//     这两态 L2 无效）；
//   L3 显式配置 = <agentDir>/subagents/config.json 的 engines{} 段（config.ts），
//     最后装载 = 用户/开发态覆盖（A12⑤ enabled:false 不进清单）。
//
// 发现时机（§3.4）：session_start 扫描一次 + 装载（装载结果即缓存——registry
// descriptors）；hasEngine() 未命中走 ensureEngineDiscovered 同步补扫（只读 manifest
// 不握手——portFactory 惰性，扫描绝不 spawn 引擎进程）。引擎清单投影（engines.json）
// 归 engine-discovery.ts syncEnginesFile。
//
// 冲突与失败（A12）：manifest 缺必需字段/不可解析 → warn 跳过该包（不阻断其他引擎）；
// 同 id 覆盖 → debug 留痕（core logger 三值无 info 级，debug 落宿主文件日志）；bin
// 不存在/不可执行 → 标记不可用（不装载、不进清单）；protocol 不兼容 → 同不可用。

import * as fs from "node:fs";
import * as path from "node:path";

import { isProtocolVersionCompatible } from "@zhushanwen/subagent-engine-sdk";

import {
  CONSERVATIVE_CAPABILITIES,
  describeValue,
  parseCapabilities,
  parseEnvPrefixes,
  parseModelCatalog,
  resolveManifestBin,
} from "./engine-manifest.ts";

import { getLogger } from "../../core/logger.ts";
import {
  ENGINE_ROOTS_ENV,
  deriveNodeModuleRoots,
  parseEngineRootsEnv,
  scanEngineRoot,
} from "./engine-discovery-roots.ts";
import { getHostServices, type DiscoveryRoot } from "../../core/host-services.ts";
import { getEngineDataDir } from "./common/data-dir.ts";
import { readExplicitEngines } from "./config.ts";
import { EngineClient } from "./client/engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "./client/remote-engine.ts";
import { hasEngine, registerEngineDescriptor, type CliEngineDescriptor } from "./registry.ts";
import { getHostUiRequestEndpoint } from "./host/host-ui-endpoint.ts";
import type { EngineCapabilities } from "./types.ts";

const logger = getLogger("subagents");

export { ENGINE_ROOTS_ENV, parseEngineRootsEnv, deriveNodeModuleRoots };

/** 单个引擎包的检查产物。 */
export type PackageInspection =
  | { status: "ok"; entry: DiscoveredEngine }
  | { status: "skip"; reason: string }
  | { status: "unusable"; id: string | undefined; reason: string };

/** 发现成功的引擎条目（装载序；同 id 后者覆盖前者）。 */
export interface DiscoveredEngine {
  id: string;
  /** 发现源标签（env 名 / 宿主根 source / node-modules / config.json）。 */
  source: string;
  /** L3 显式 config（initialize.engineConfig 透传；L1/L2 manifest 发现无此项）。 */
  engineConfig?: Record<string, string>;
  descriptor: CliEngineDescriptor;
}

/** 扫描结果（诊断面：skip/unusable 逐包留痕原因，对应 A12 负面场景）。 */
export interface DiscoveryScanResult {
  discovered: DiscoveredEngine[];
  skipped: Array<{ pkgDir: string; reason: string }>;
  unusable: Array<{ pkgDir: string; id: string | undefined; reason: string }>;
}

export interface DiscoverEnginesOptions {
  /** 宿主种类（EngineClient pidfile 实例维度命名段：pi 壳 'pi'、runtime 'runtime'）。 */
  hostKind: string;
  /** L3 显式配置目录（<dir>/subagents/config.json 的 engines 段）。缺省 = 无 L3。 */
  agentDir?: string;
  /** 引擎数据根（EngineClient dataDir；缺省 portFactory 执行期 getEngineDataDir 解析）。 */
  dataDir?: string;
  /** env 覆盖（L1 根读取；缺省 process.env——测试注入隔离宿主 env）。 */
  env?: NodeJS.ProcessEnv;
  /** L2 覆盖（测试注入；缺省 = 宿主入口上溯 node_modules 链）。 */
  nodeModuleRoots?: string[];
  /** 附加发现根（调用方/测试追加的 L1 根，语义同 HostServices.engines）。 */
  extraRoots?: DiscoveryRoot[];
}

/**
 * 检查单个候选包目录（读 package.json → manifest 字段级解析 → bin 可执行验证）。
 * 三态：ok（装载）/ skip（必需字段缺失/不可解析——warn 跳过该包）/ unusable
 * （protocol 不兼容、bin 不可执行——标记不可用，不进清单）。
 */
export function inspectEnginePackage(
  pkgDir: string,
  source: string,
  hostKind: string,
  env: NodeJS.ProcessEnv,
): PackageInspection {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
  } catch (err) {
    return { status: "skip", reason: `package.json unreadable: ${errorMessage(err)}` };
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    return { status: "skip", reason: `package.json is not valid JSON: ${errorMessage(err)}` };
  }
  if (typeof pkg !== "object" || pkg === null) {
    return { status: "skip", reason: "package.json is not an object" };
  }
  // 无 manifest 段 = 不是引擎包：扫描常态（node_modules 大量无关包），静默跳过不 warn。
  const agentNs = (pkg as Record<string, unknown>)["xyz-agent"];
  if (typeof agentNs !== "object" || agentNs === null) {
    return { status: "skip", reason: "no xyz-agent.subagentEngine manifest (not an engine package)" };
  }
  const manifest = (agentNs as Record<string, unknown>)["subagentEngine"];
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { status: "skip", reason: "xyz-agent.subagentEngine is not an object" };
  }
  const m = manifest as Record<string, unknown>;

  // ── 必需字段：id / bin / protocol（缺失或形态坏 → warn 跳过该包）──
  const id = m["id"];
  if (typeof id !== "string" || id.trim() === "") {
    return { status: "skip", reason: "manifest id is required (non-empty string)" };
  }
  const manifestBin = m["bin"];
  if (typeof manifestBin !== "string" || manifestBin.trim() === "") {
    return { status: "skip", reason: `engine '${id}': manifest bin is required (non-empty string)` };
  }
  const protocol = m["protocol"];
  if (typeof protocol !== "number" || !Number.isInteger(protocol)) {
    return {
      status: "skip",
      reason: `engine '${id}': manifest protocol is required (integer; got ${describeValue(protocol)})`,
    };
  }
  if (!isProtocolVersionCompatible(protocol)) {
    return {
      status: "unusable",
      id,
      reason:
        `engine '${id}': manifest protocol ${protocol} is not compatible ` +
        `(core supports >=1 <2) — upgrade the engine package or the host core`,
    };
  }

  // ── bin 解析：manifest bin = package.json npm bin 的 key（设计 §3.4 示例形态）；
  //    package.json bin 为字符串时直接作相对路径。解析不出真实入口 = bin 缺失面。
  const binPath = resolveManifestBin(pkgDir, pkg as Record<string, unknown>, manifestBin);
  if (binPath === undefined) {
    return {
      status: "skip",
      reason: `engine '${id}': manifest bin '${manifestBin}' does not resolve via package.json bin`,
    };
  }
  if (!canExecute(binPath)) {
    return {
      status: "unusable",
      id,
      reason: `engine '${id}': bin not found or not executable: ${binPath}`,
    };
  }

  // ── capabilities（必需；缺键取最保守值 + warn；未知键忽略 + warn）──
  const caps = parseCapabilities(id, m["capabilities"]);

  // ── envPrefixes（可选，缺省 []；非法条目丢弃该前缀 + warn，包仍可用——A12②）──
  const envPrefixes = parseEnvPrefixes(id, m["envPrefixes"]);

  // ── modelCatalog（可选；缺省 = 不注入保持 undefined——解析器不得把省略填成
  //    models: []，否则「无枚举面」语义不可达，RemoteEngine.listModels 会说谎）──
  const modelCatalog = parseModelCatalog(id, m["modelCatalog"]);

  // ── displayName / description（可选；displayName 缺省 = id 由消费面兜底
  //    （listEnginesByDisplayName 的 `?? id`），快照只存显式值防「缺省填充」被误读；
  //    description 当前无消费面，仅做形态校验）──
  let displayName: string | undefined;
  const rawDisplayName = m["displayName"];
  if (rawDisplayName !== undefined) {
    if (typeof rawDisplayName === "string" && rawDisplayName.trim() !== "") {
      displayName = rawDisplayName;
    } else {
      logger.warn(`[engine-discovery] engine '${id}': displayName must be a non-empty string — ignoring`);
    }
  }
  const rawDescription = m["description"];
  if (rawDescription !== undefined && typeof rawDescription !== "string") {
    logger.warn(`[engine-discovery] engine '${id}': description must be a string — ignoring`);
  }

  const manifestSnapshot: RemoteEngineManifestSnapshot = {
    capabilities: caps,
    ...(modelCatalog !== undefined ? { modelCatalog } : {}),
  };

  const descriptor: CliEngineDescriptor = {
    kind: "cli",
    command: binPath,
    args: [],
    capabilities: caps,
    portFactory: () => {
      // 惰性求值：portFactory 在 getEngine 首次取用时才执行（registry 惰性单例），
      // 那时宿主已 configureCore（或宿主进程 env 已带数据根）——扫描期可能早于
      // configureCore，直接调 getEngineDataDir 会触 core_host_not_configured。
      const dataDir = getEngineDataDir(env);
      const client = new EngineClient({
        engineId: id,
        command: binPath,
        args: [],
        hostKind,
        dataDir,
        envPrefixes,
        // [W6 R3 MF-A] host/askUser 应答端：壳侧登记处在 portFactory 惰性执行期取值
        //（晚于 session_start 注册，未注册 → undefined → 引擎收 {unsupported:true}）。
        uiRequestHandler: getHostUiRequestEndpoint(),
        manifestDiagnostics: {
          capabilities: caps,
          models: modelCatalog === undefined || modelCatalog === null ? null : modelCatalog.models,
        },
      });
      return new RemoteEngine({
        engineId: id,
        client,
        manifest: manifestSnapshot,
        dataDir,
        hostKind,
      });
    },
    manifest: {
      ...(modelCatalog !== undefined ? { modelCatalog } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    },
  };
  return { status: "ok", entry: { id, source, descriptor } };
}

// ============================================================
// 扫描与装载
// ============================================================

/** 纯扫描（不装载注册表）。装载序 = L1 env → L1 宿主/附加根 → L2 → L3（后者覆盖前者）。 */
export function scanEngines(opts: DiscoverEnginesOptions): DiscoveryScanResult {
  const env = opts.env ?? process.env;
  const result: DiscoveryScanResult = { discovered: [], skipped: [], unusable: [] };
  const present = (entry: DiscoveredEngine): void => {
    const idx = result.discovered.findIndex((d) => d.id === entry.id);
    if (idx >= 0) {
      logger.debug(
        `[engine-discovery] engine id '${entry.id}' from '${entry.source}' overrides earlier ` +
          `discovery from '${result.discovered[idx].source}' — same-id override`,
      );
      result.discovered[idx] = entry;
      return;
    }
    result.discovered.push(entry);
  };

  const visitManifestPackage = (pkgDir: string, source: string): void => {
    const inspection = inspectEnginePackage(pkgDir, source, opts.hostKind, env);
    if (inspection.status === "skip") {
      // 非引擎包（无 manifest 段）的静默 skip 不留痕——扫描常态；其余 skip warn。
      if (!inspection.reason.includes("not an engine package")) {
        logger.warn(`[engine-discovery] skipping ${pkgDir} (${source}): ${inspection.reason}`);
        result.skipped.push({ pkgDir, reason: inspection.reason });
      }
      return;
    }
    if (inspection.status === "unusable") {
      logger.warn(`[engine-discovery] engine unavailable: ${inspection.reason}`);
      result.unusable.push({ pkgDir, id: inspection.id, reason: inspection.reason });
      return;
    }
    present(inspection.entry);
  };

  // L1：env 宿主发现根（打包态主通道，W9 注入）
  for (const dir of parseEngineRootsEnv(env)) {
    scanEngineRoot(dir, (pkgDir) => visitManifestPackage(pkgDir, ENGINE_ROOTS_ENV));
  }
  // L1：宿主发现根第二通道（HostServices.engines）+ 调用方附加根
  const hostRoots = [
    ...(getHostServices().discoveryRoots?.().engines ?? []),
    ...(opts.extraRoots ?? []),
  ];
  for (const root of hostRoots) {
    scanEngineRoot(root.dir, (pkgDir) => visitManifestPackage(pkgDir, root.source));
  }
  // L2：宿主 node_modules（node 解析域；opts.nodeModuleRoots 测试覆盖）
  const nodeRoots = opts.nodeModuleRoots ?? deriveNodeModuleRoots();
  for (const dir of nodeRoots) {
    scanEngineRoot(dir, (pkgDir) => visitManifestPackage(pkgDir, "node-modules"));
  }
  // L3：显式配置（最后装载 = 用户/开发态覆盖）
  if (opts.agentDir !== undefined) {
    for (const [id, entry] of Object.entries(readExplicitEngines(opts.agentDir))) {
      const command = resolveExplicitCommand(entry.command, env);
      if (command === undefined) {
        const reason =
          `engine '${id}' (config.json engines.${id}): command '${entry.command}' not found or not executable`;
        logger.warn(`[engine-discovery] ${reason} — not registering`);
        result.unusable.push({ pkgDir: `config.json engines.${id}`, id, reason });
        continue;
      }
      present(buildExplicitDescriptor(id, command, entry, opts));
    }
  }
  return result;
}

/**
 * 历史发现装载的引擎 id 集（模块级；供 syncEnginesFile 投影时从注册表快照剔除
 * 历史装载——投影逻辑与装载逻辑同 bundle 闭包，无跨模块实例副本问题）。
 */
const loadedDiscoveryIdSet = new Set<string>();

/**
 * 扫描 + 装载：descriptor 经 registerEngineDescriptor 进注册表（幂等覆盖——重复扫描
 * 安全）。装载覆盖既有注册（含过渡期 inproc pi/zcode——auto 模式下 cli descriptor
 * 胜出即设计 D3 语义）时 debug 留痕。
 */
export function discoverAndRegisterEngines(opts: DiscoverEnginesOptions): DiscoveryScanResult {
  const result = scanEngines(opts);
  for (const entry of result.discovered) {
    const existed = hasEngine(entry.id);
    registerEngineDescriptor(entry.id, entry.descriptor);
    loadedDiscoveryIdSet.add(entry.id);
    if (existed) {
      logger.debug(
        `[engine-discovery] engine '${entry.id}' descriptor overwritten in registry ` +
          `(source '${entry.source}') — same-id override`,
      );
    }
  }
  return result;
}

/**
 * 历史发现装载的引擎 id 快照（投影源计算消费面，见 engine-discovery.ts）。
 */
export function loadedDiscoveryIds(): string[] {
  return [...loadedDiscoveryIdSet];
}

/**
 * hasEngine 的补扫面（§3.4 发现时机：快照未命中触发一次同步补扫，只读 manifest
 * 不握手）。消费方 = agent 解析期/路由期的存在性校验接线（宿主侧注入 hasEngineFn
 * 时用本函数替代裸 hasEngine）——「装了包 → 下次解析即可用」。
 */
export function ensureEngineDiscovered(id: string, opts: DiscoverEnginesOptions): boolean {
  if (hasEngine(id)) return true;
  discoverAndRegisterEngines(opts);
  return hasEngine(id);
}

/** L3 显式命令解析：含路径分隔符 → 按路径验证；裸命令名 → PATH 查找。失败 = 不可用。 */
function resolveExplicitCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    const p = path.isAbsolute(command) ? command : path.resolve(command);
    return canExecute(p) ? p : undefined;
  }
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === "") continue;
    const p = path.join(dir, command);
    if (canExecute(p)) return p;
  }
  return undefined;
}

/**
 * L3 显式配置的 descriptor：无 manifest 面（用户手工配置 command）→ capabilities 取
 * 全保守值 + warn（gate 同步拦生成，运行期不踩未声明能力）；无 modelCatalog / 无
 * displayName（= id）。engineConfig 经 initialize.engineConfig 透传。
 */
function buildExplicitDescriptor(
  id: string,
  command: string,
  entry: { args: string[]; config?: Record<string, string>; cwd?: string },
  opts: DiscoverEnginesOptions,
): DiscoveredEngine {
  const env = opts.env ?? process.env;
  logger.debug(
    `[engine-discovery] engine '${id}' registered from config.json engines section with conservative capabilities (no manifest)`,
  );
  const caps: EngineCapabilities = { ...CONSERVATIVE_CAPABILITIES };
  const descriptor: CliEngineDescriptor = {
    kind: "cli",
    command,
    args: entry.args,
    capabilities: caps,
    portFactory: () => {
      // 惰性求值理由同 manifest descriptor portFactory（扫描期早于 configureCore）。
      const dataDir = opts.dataDir ?? getEngineDataDir(env);
      const client = new EngineClient({
        engineId: id,
        command,
        args: entry.args,
        ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
        hostKind: opts.hostKind,
        dataDir,
        envPrefixes: [],
        // [W6 R3 MF-A] 同上：host/askUser 应答端经壳侧登记处接线。
        uiRequestHandler: getHostUiRequestEndpoint(),
        ...(entry.config !== undefined ? { engineConfig: entry.config } : {}),
        manifestDiagnostics: { capabilities: caps, models: null },
      });
      return new RemoteEngine({
        engineId: id,
        client,
        manifest: { capabilities: caps },
        dataDir,
        hostKind: opts.hostKind,
        ...(entry.config !== undefined ? { engineConfig: entry.config } : {}),
      });
    },
  };
  return {
    id,
    source: "config.json",
    ...(entry.config !== undefined ? { engineConfig: entry.config } : {}),
    descriptor,
  };
}

/** 可执行探测（X_OK；ENOENT/EACCES/平台不支持 → false）。 */
function canExecute(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
