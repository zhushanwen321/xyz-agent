/**
 * subagent-workflow Extension — Factory（extension 装配点）
 *
 * 合并 @zhushanwen/pi-subagents + @zhushanwen/pi-workflow 为统一包。
 * 注册项：3 tool（subagent + workflow + workflow-script）+ 2 command（subagents + workflows）
 * + messageRenderer（subagent-bg-notify）+ pi.__workflowRun + session 事件。
 *
 * 三层架构：
 *   interface/ → 注册胶水（tools/commands/tui）
 *   orchestration/ → workflow engine（launcher/lifecycle/error-recovery）
 *   execution/ → subagents 执行运行时（SubagentService/session-runner/concurrency-pool）
 *
 * 设计基线：D-004（旧包不动）/ ADR-025（进程内执行）/ D-8（pi.__workflowRun 签名）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";

// ═══ core 宿主端口接线（subagent-core 包抽离 u0-wire；实现见 src/host/pi-host.ts） ═══
import { configureCore } from "@zhushanwen/subagent-core/core/host-services.ts";
import { configureNotifyDomain } from "@zhushanwen/subagent-core/core/notify-ports.ts";
import { createPiHostServices, createPiNotifyDomainPorts } from "./host/pi-host.ts";

import { bestEffort } from "@zhushanwen/subagent-core/execution/best-effort.ts";
// ═══ execution/ 层（subagents 核心 + 运行时） ═══
import { getOrCreateChannelRegistry } from "@zhushanwen/subagent-core/execution/channel-registry-access.ts";
import { DialogGlobalQueue } from "@zhushanwen/subagent-core/execution/dialog-queue.ts";
// [engine-awareness U3] 全局 config 三态读取（检测 poll 与 session_start 基线共用）
import { readGlobalConfig } from "@zhushanwen/subagent-core/execution/config.ts";
// [U7] 引擎列表状态文件（registry → engines.json，GUI 引擎选择器数据源）
import { syncEnginesFile } from "@zhushanwen/subagent-core/execution/engine/engine-discovery.ts";
// [U7] 引擎模型段注入（defaultEngine 非 pi 时 system prompt 补 <available_<engine>_models>）
// [engine-awareness U3] 补恒在状态段 <current_subagent_engine>（D6，pi 引擎也声明）
import { buildEngineModelsPromptAppend, buildSubagentEngineSection } from "@zhushanwen/subagent-core/execution/engine/model-prompt.ts";
// [P1 引擎接线] 组合根登记 'pi' 引擎进 registry（引擎获取统一经 getEngine，缺省 id 'pi'）
import { registerPiEngine } from "@zhushanwen/subagent-core/execution/engine/engines/pi/registration.ts";
// [P3 引擎接线] 组合根登记 'zcode' 引擎（spawn 单轮模式；engineDataDir 默认走
// common/data-dir SSOT，见 engines/zcode/registration.ts）
import { registerZcodeEngine } from "@zhushanwen/subagent-core/execution/engine/engines/zcode/registration.ts";
import { createUiRequestHandlerForMode } from "@zhushanwen/subagent-core/execution/ui-request-handler-factory.ts";
import {
  getModelConfigService,
  ModelConfigService,
  setModelConfigService,
} from "@zhushanwen/subagent-core/execution/model-config-service.ts";
import { bindNotifyLedgerHost, getBoundNotifyLedger, type NotifyLedgerHost } from "@zhushanwen/subagent-core/execution/notify-ledger.ts";
import { IDENTITY_CUSTOM_TYPE, type SubagentIdentityData } from "@zhushanwen/subagent-core/execution/session-reconstructor.ts";
import type { ExecutionMode } from "@zhushanwen/subagent-core/execution/types.ts";
import { maybeCleanupExpiredSessionFiles } from "@zhushanwen/subagent-core/execution/session-file-gc.ts";
import {
  getSubagentService,
  setSubagentService,
  SubagentService,
} from "@zhushanwen/subagent-core/execution/subagent-service.ts";
import { killAllSpawnedChildren } from "@zhushanwen/subagent-core/execution/session-runner.ts";
import { SubprocessAgentRunner } from "@zhushanwen/subagent-core/execution/subprocess-agent-runner.ts";
import { WorktreeManager } from "@zhushanwen/subagent-core/execution/worktree-manager.ts";
// [engine-awareness U3] per-turn 引擎检测编排（D1/D1b/D2/D3/D5）；normalizeEngineId
// 单一权威源在 core registry（原经 engine-awareness 再导出，导入面已折叠直连）
import { normalizeEngineId } from "@zhushanwen/subagent-core/execution/engine/registry.ts";
import { runEngineAwarenessTurn } from "./injectors/engine-awareness.ts";
import { setupModelListInjector } from "./injectors/model-list-injector.ts";
import { setupSubagentListInjector } from "./injectors/subagent-list-injector.ts";
import { setupWorkflowListInjector } from "./injectors/workflow-list-injector.ts";
import { renderBgNotifyMessage } from "./interface/bg-notify-render.ts";
import { registerWorkflowsCommand } from "./interface/commands.ts";
import { toGuiCtx } from "./interface/gui-mappers.ts";
import { notifyDone, trackNotifiedRunId } from "./interface/helpers.ts";
import { registerSubagentTool } from "./interface/subagent-tool.ts";
// ═══ interface/ 层（tools/commands/tui 合并） ═══
import { registerSubagentsCommand } from "./interface/subagents.ts";
import { registerWorkflowTool } from "./interface/tool-workflow.ts";
import { registerWorkflowScriptTool } from "./interface/tool-workflow-script.ts";
import { JsonlRunStore } from "./jsonl-run-store.ts";
import { clearSkillPathCache } from "@zhushanwen/subagent-core/orchestration/skill-discovery.ts";
// ═══ orchestration/ 层（workflow engine + infra） ═══
import type { LauncherDeps } from "@zhushanwen/subagent-core/orchestration/launcher.ts";
import { executeNestedWorkflow, runAndWait, type WorkflowRunResult } from "@zhushanwen/subagent-core/orchestration/launcher.ts";
import {
  evictDoneRunsBeyondCap,
  MAX_RETAINED_DONE_RUNS,
  scheduleTimeBudget,
  terminateRunningRuns,
} from "@zhushanwen/subagent-core/orchestration/lifecycle.ts";
import type { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { WorkerHostImpl } from "@zhushanwen/subagent-core/orchestration/worker-host.ts";
import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core/orchestration/workflow-script-registry-impl.ts";

// ── pi.__workflowRun 类型扩展（D-8 签名） ─────────────────

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    __workflowRun?: (
      workflowName: string,
      workflowArgs: Record<string, unknown>,
      workflowSignal?: AbortSignal,
      workflowTimeoutMs?: number,
    ) => Promise<WorkflowRunResult>;
  }
}

// ── Factory ──────────────────────────────────────────────────

// 模块级 logger（setPiHandle 注入后自动走 appendEntry）
const logger = getLogger("subagents");

// ═══ [V2 决策 7 防线 i] process 级 shutdown hook ═══
//
// session_shutdown 是 pi 的 async hook，进程被 SIGTERM/SIGINT 强杀或崩溃时来不及
// 触发；sync 子进程（controller 为 undefined，abortRunningControllers 跳过它们）会
// 泄漏为孤儿。process.on 兜底显式 killAllSpawnedChildren 收割全部活子进程。
// guard 防多信号叠加（如 SIGINT 后又 beforeExit）重复 kill。
let processShutdownHookFired = false;

function reapSpawnedChildrenOnShutdown(): void {
  if (processShutdownHookFired) return;
  processShutdownHookFired = true;
  try {
    killAllSpawnedChildren("SIGTERM");
  } catch (err) {
    // best-effort：收割失败不阻断退出流程——debug 留痕（孤儿子进程排查线索），
    // 不静默吞错，对齐「错误必须可操作」。
    logger.debug(
      "[subagents] process shutdown reap best-effort failed (killAllSpawnedChildren SIGTERM)",
      { reason: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * 测试钩子：重置 module 级 shutdown guard。
 *
 * 对齐 lifecycle-manager._resetLifecycleState 模式——processShutdownHookFired 是
 * module 级单例状态，跨 test 持久，单测需显式重置以验证 idempotent 行为。
 */
export function _resetProcessShutdownGuardForTest(): void {
  processShutdownHookFired = false;
}

export default function subagentsWorkflowExtension(pi: ExtensionAPI): void {
  // 注入 pi handle 给全局 extension-logger，让深层代码（best-effort / error-recovery）
  // 的 getLogger("subagents") 也能走 appendEntry。
  setPiHandle(pi);

  // [u0-wire] core 宿主端口接线：本波端口尚无 core 消费方（消费切换在 u0-log /
  // u0-data-discovery / u0-notify 波次），接线本身零行为变化。紧随 setPiHandle——
  // core log 桥接走 pi-extension-logger，其 pi handle 先注入则配置完成即桥接链路
  // 完整；且先于任何可能消费 core 端口的初始化逻辑（引擎登记等）。缺省态若被消费，
  // dataRoot 抛 core_host_not_configured（§3.4），接线后不再可达。
  configureCore(createPiHostServices());
  configureNotifyDomain(createPiNotifyDomainPorts());

  // [P1 引擎接线] 组合根登记缺省引擎：进程级 SubagentService 单例（session_start 注入）
  // 经 registry 以 'pi' 暴露——引擎获取从此统一走 getEngine(DEFAULT_ENGINE_ID)，上层
  // 不再硬编码「spawn pi」。幂等（registerEngine 覆盖语义），工厂惰性解析服务单例。
  // P4 配置路由（agent frontmatter engine 字段 + 三层优先级）在本登记之上消费。
  registerPiEngine();

  // [P3 引擎接线] 登记 'zcode'（幂等同上）。惰性工厂：不触发 CLI/凭据探测，引擎被
  // 实际选用（P4 路由或显式 getEngine('zcode')）才解析 deps。
  registerZcodeEngine();

  // [U7b] 引擎列表在 extension 模块加载时即同步 engines.json（不等 session_start——
  // 用户体验拍板 2026-08-25：xyz-agent 打开后激活任意 session 的第一时间（含 TUI 等价
  // 场景）GUI 引擎选择器就该有数据；session_start 处保留幂等重写兜底 jiti 双路径/
  // 模块重载场景的刷新）。
  syncEnginesFile(getAgentDir());

  // ════════════════════════════════════════════════════════════
  //  subagents 域：tool + command + messageRenderer
  // ════════════════════════════════════════════════════════════
  registerSubagentTool(pi);
  registerSubagentsCommand(pi);
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  // ════════════════════════════════════════════════════════════
  //  injectors：before_agent_start 注入 <available_subagents> + <available_workflows>
  //  + <available_provider_models>（模型列表供派发时指定 model 参数；与 subagent/workflow 清单对称）
  //
  //  归位自 unified-hooks（subagent-list-injector）+ 新增 workflow-list-injector。
  //  injector 是 subagent-workflow 的内聚功能（让 LLM 知道有哪些 agent/workflow
  //  可用），与同包 resource-discovery 同包后直接 import，消除跨包依赖（ADR-031）。
  //  pi 串联多 before_agent_start handler：各自返回 systemPrompt 链式叠加。
  // ════════════════════════════════════════════════════════════
  setupSubagentListInjector(pi);
  setupWorkflowListInjector(pi);
  setupModelListInjector(pi);

  // 模块级缓存：主 session 的 sessionFile（fork source 解析用）。
  let cachedMainSessionFile: string | undefined;
  function getCachedMainSessionFile(): string | undefined {
    return cachedMainSessionFile;
  }

  /**
   * 按 sessionId 解析主 session 文件路径（文件名约定 `<ISO 时间戳>_<sessionId>.jsonl`）。
   * [E2E 实测] attach 场景下 ctx.sessionManager.getSessionFile() 会返回前一 session 的
   * 文件（session_start(root=01a01bf5) 时仍返回刚新建 session 的路径）——恢复逻辑
   * 读错文件会整段漏判。此处按 id 从 sessions 目录解析为准；新 session 文件未 flush
   * 时（AGENTS.md 规则 6：首条 assistant 消息前可能不存在）返回 undefined，调用方
   * （fork 解析 / 孤儿恢复）对该场景本就无 entry 可读。
   */
  function resolveMainSessionFileById(sessionId: string): string | undefined {
    const sessionsDir = path.join(getAgentDir(), "..", "sessions");
    try {
      const match = fs.readdirSync(sessionsDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
      return match === undefined ? undefined : path.join(sessionsDir, match);
    } catch {
      return undefined;
    }
  }

  // resources_discover：不再注册 handler（v4 决策：不再注入额外 skill 目录，
  // ADR-031 废弃 discovery.json）。pi 核心 auto-discovery 已覆盖 .agents/skills
  // 等标准目录，子 session 的 --skill 由 agent({skill}) 调用方显式传入，无需
  // extension 额外补充。

  // ════════════════════════════════════════════════════════════
  //  workflow 域：tools + command + pi.__workflowRun + state
  // ════════════════════════════════════════════════════════════
  const lsRef = { lastSessionId: "" };
  const notifiedRunIds = new Set<string>();
  const guard = { isProcessing: false };

  // Infra 实例（per-factory 单例，跨 session 复用）
  const workerHost = new WorkerHostImpl();
  const registry = new WorkflowScriptRegistryImpl();

  // SAR 改为 per-session 构造（需要 ctxModel 填底 D-008 + subagentService 委托目标）
  // old: const runner = new SubprocessAgentRunner();
  // new: per-session session_start 时创建，见下方 makeDeps 前的 runner 创建

  // per-session 状态（session_start 时重建）
  const sessionState = new Map<
    string,
    {
      store: JsonlRunStore;
      runs: Map<string, WorkflowRun>;
      sessionDir: string;
      /** D-008 per-session SAR（需要 ctxModel + subagentService） */
      runner: SubprocessAgentRunner;
      /** session 上下文（notifyDone 需要 GuiContext） */
      ctx?: ExtensionContext;
      /** MF-1: store 健康度。session_start 时 store.loadAll 失败则置 false，
       *  workflow 域启动时 fail-fast，避免后续 store.save 再次失败导致 run 状态不落地。
       *  subagent 域不依赖 store，不受此标志影响。 */
      storeHealthy: boolean;
      /** [engine-awareness D1b] 上一次已知默认引擎（session_start 初始化，per-turn 检测
       *  diff 基准）。undefined = 初始化时 config 读失败——首 turn 检测遇 undefined
       *  静默基线化，不算变更、不发通知（防首 turn 伪通知）。 */
      lastEngine?: string;
    }
  >();

  function log(
    level: "debug" | "info" | "warn" | "error",
    component: string,
    message: string,
    data?: unknown,
  ): void {
    try {
      pi.appendEntry("workflow:log", {
        timestamp: Date.now(),
        level,
        component,
        message,
        data,
      });
    } catch (err) {
      void err;
    }
  }

  function resolveSessionDir(): string {
    const defaultDir = getAgentDir();
    const sessionSlug = `--${process.cwd().replace(/^\//, "").replace(/\//g, "-")}--`;
    // F2：根改 getAgentDir() 派生（实例隔离）；保留 sessionScopedDir 存在则用之的探测语义
    const sessionScopedDir = path.join(getAgentDir(), "sessions", sessionSlug);
    return fs.existsSync(sessionScopedDir) ? sessionScopedDir : defaultDir;
  }

  function makeDeps(
    state: {
      store: JsonlRunStore;
      runs: Map<string, WorkflowRun>;
      sessionDir: string;
      runner: SubprocessAgentRunner;
    },
    sessionCtx?: ExtensionContext,
  ) {
    const deps: LauncherDeps = {
      store: state.store,
      workerHost,
      runner: state.runner,
      runs: state.runs,
      registry,
      // onRunDone 是全部 done 路径的单点汇聚（abortRun + error-recovery），顺序固化为
      // notify → track → evict：notifyDone 先发完整聚合通知（淘汰后聚合根仍在闭包参数
      // run 引用上不受影响），trackNotifiedRunId 有界化去重窗口，最后裁剪 done run 内存。
      // 本轮 run 的 completedAt 在 transition("done") 时同步设为当前时刻=全局最新，
      // 恒在保留端——结构性保证其不被自身触发的裁剪淘汰，无需 protectRunId。
      onRunDone: (run: WorkflowRun) => {
        notifyDone(pi, run.runId, run, notifiedRunIds, toGuiCtx(sessionCtx));
        trackNotifiedRunId(notifiedRunIds, run.runId);
        const evicted = evictDoneRunsBeyondCap(state.runs, MAX_RETAINED_DONE_RUNS);
        if (evicted > 0) {
          logger.debug("[subagent-workflow] evicted done runs beyond cap", {
            evicted,
            keep: MAX_RETAINED_DONE_RUNS,
            sessionId: lsRef.lastSessionId,
          });
        }
      },
      eventBus: pi.events,
      scheduleTimeBudget: (runId: string, budgetTimeMs: number) =>
        scheduleTimeBudget(runId, deps, budgetTimeMs),
      onWorkflowCall: (name: string, args: Record<string, unknown>, parentRun: WorkflowRun) =>
        executeNestedWorkflow(name, args, parentRun, deps),
      streamSink: getSubagentService()?.getStreamSink() ?? undefined,
      log,
    };
    return deps;
  }

  function isScriptRunning(name: string): boolean {
    for (const state of sessionState.values()) {
      for (const run of state.runs.values()) {
        if (run.spec.scriptName === name && run.state.status === "running") return true;
      }
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════
  //  session_start：初始化 subagents + workflow 两域
  // ════════════════════════════════════════════════════════════
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    const agentDir = getAgentDir();
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

    // [U7] 引擎列表同步 engines.json（幂等零写 + fail-safe；组合根注册已在
    // extension 工厂体完成，此处 registry 已含全部引擎）
    syncEnginesFile(agentDir);

    // skill 路径两级缓存 session 级失效：pi 同进程可能有多个 session（TUI /new、/fork），
    // 运行中安装的 skill 需对新 session 可见（含曾 miss 缓存的 undefined 条目与 npm 新装
    // 包的候选目录）。session 内复用收益不变（IF8/DM3 消重发生在同 session 的重复调用）。
    clearSkillPathCache();

    // ── [M4] identity 子进程写入（V2 决策 5）──
    // 子进程经 env（PI_SUBAGENT_*）接收自己的 identity，在 session_start 用 pi.appendEntry
    // 写 subagent-identity custom entry。pi 自动生成 id/parentId → message tree 连续。
    // 旧实现父进程 fs.appendFileSync 补写的 custom entry 缺 id/parentId → 污染 _buildIndex
    // leafId 指针 → message tree 断成两棵 → 多轮对话丢上下文（bug 根因）。
    // 主/子进程判定：PI_SUBAGENT_SELF_RECORD_ID 仅 session-runner spawn 子进程时注入，
    // 主进程无此 env → 跳过（identity 只在子进程写一次）。
    const selfRecordId = process.env.PI_SUBAGENT_SELF_RECORD_ID;
    if (selfRecordId) {
      try {
        const modeEnv = process.env.PI_SUBAGENT_MODE;
        // ExecutionMode 联合窄化：父进程经 env 注入（record.mode 恒为 "background"），
        // 运行时校验合法值，非法兜底 background（避免裸 cast，符合 taste/no-unsafe-cast）。
        const mode: ExecutionMode = modeEnv === "background" ? modeEnv : "background";
        const identity: SubagentIdentityData = {
          id: selfRecordId,
          agent: process.env.PI_SUBAGENT_AGENT ?? "",
          mode,
          task: process.env.PI_SUBAGENT_TASK ?? "",
          slug: process.env.PI_SUBAGENT_SLUG,
          startedAt: Number(process.env.PI_SUBAGENT_STARTED_AT ?? Date.now()),
          rootSessionId: process.env.PI_SUBAGENT_ROOT_SESSION_ID,
          parentRecordId: process.env.PI_SUBAGENT_PARENT_RECORD_ID,
          depth:
            process.env.PI_SUBAGENT_DEPTH !== undefined
              ? Number(process.env.PI_SUBAGENT_DEPTH)
              : undefined,
          forkDepth:
            process.env.PI_SUBAGENT_FORK_DEPTH !== undefined
              ? Number(process.env.PI_SUBAGENT_FORK_DEPTH)
              : undefined,
          chatMode: process.env.PI_SUBAGENT_CHAT_MODE === "true",
          // [review round2] worktree 隔离标志（session-runner 注入）：跨重启重建路径据此
          // 拒绝续聊（handle 不可序列化，reattach 不可行）。
          worktree: process.env.PI_SUBAGENT_WORKTREE === "true",
        };
        pi.appendEntry(IDENTITY_CUSTOM_TYPE, identity);
      } catch (err) {
        logger.warn("[subagents] identity appendEntry failed in session_start", {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── [U2] 通知账本装配 + 重启恢复（设计 D4：存在性 / 可达性分离）──
    // bind 先于 service.initSession（notifier.revive 在其内——notify() 经
    // getBoundNotifyLedger 消费账本）。recoverFromSession 扫 ledger/ack 两列 entry
    // 差集：未销账号重放投递（已销账零重发，notifyId 幂等）；fork 继承未销账
    // pending 属可接受语义（D4 归属规则——扫描域 = 单 session 文件，幂等键作用域
    // 随文件域隔离）。compaction 存活情况归 session_compact handler 的条件降级（P-B4
    // 探针阶段 5 实测，见 notify-ledger.ts compactionCheck）。
    try {
      const ledgerHost: NotifyLedgerHost = {
        appendLedgerEntry: (customType, data) => {
          pi.appendEntry(customType, data);
        },
        readSessionEntries: () => ctx.sessionManager.getEntries(),
        isIdle: () => ctx.isIdle(),
        onAgentSettled: (handler) => {
          pi.on("agent_settled", handler);
        },
        sendDelivery: (message) => {
          // D5 单通道：唯一发送形态 = sendCustomMessage({triggerTurn:true})，
          // courier 已在发送前二次复查 isIdle，多通道投递选项已删（D5）。
          pi.sendMessage(message, { triggerTurn: true });
        },
      };
      // U4：重放观测已内聚到 ledger 分桶日志（recoveryReplays 桶经 extensionLogger
      // 通道落盘），此处不再重复打日志。
      bindNotifyLedgerHost(ledgerHost).recoverFromSession();
    } catch (err) {
      // 账本装配失败不阻断 session_start（通知退回 notifier 的内核路径）
      logger.warn("[subagents] notify ledger bind failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    // ── subagents 域：双 Service 装配 ──
    const existingService = getSubagentService();
    const existingModelService = getModelConfigService();
    const modelService = existingModelService ?? new ModelConfigService({ agentDir, cwd });
    const service = existingService ?? new SubagentService({ cwd, modelService, getMainSessionFile: getCachedMainSessionFile });

    modelService.initModel({
      modelRegistry: ctx.modelRegistry,
      sessionId: ctx.sessionManager.getSessionId(),
      ctxModel: ctx.model ?? undefined,
    });

    // ── W3: handler 注入链路接通 ──
    // 进程级单例：channel registry + dialog queue 跨 session 复用
    //（与 SubagentService 单例模式一致，globalThis Symbol 持有避免 jiti 多实例分裂）。
    const channelRegistry = getOrCreateChannelRegistry();
    const dialogQueue = getOrCreateDialogQueue();
    const uiRequestHandler = createUiRequestHandlerForMode(ctx, channelRegistry, dialogQueue);
    // SR-3: 无论 new 还是 existing（/resume /fork 复用），session_start 都必须注入 handler
    service.setUiRequestHandler(uiRequestHandler);

    // 主 session 文件：按 sessionId 解析（getSessionFile() 在 attach 场景会返回前一
    // session 的文件，E2E 实测），未 flush 的新 session 回退 getSessionFile()。
    // 值直传 initSession——jiti 多实例分裂下闭包缓存（cachedMainSessionFile）不跨
    // 实例共享，恢复逻辑经缓存读会拿到滞后一个事件的值（E2E 实测 ENOENT 漏判）；
    // 缓存本身保留给既有 getter 消费者（fork source 解析）。
    cachedMainSessionFile =
      resolveMainSessionFileById(ctx.sessionManager.getSessionId()) ??
      ctx.sessionManager.getSessionFile() ??
      undefined;

    service.initSession({
      pi,
      sessionId: ctx.sessionManager.getSessionId(),
      mainSessionFile: cachedMainSessionFile,
      // 注入 ctx.ui.setWidget 作为 streaming sink（只绑方法，不持有整个 ctx）。
      // background subagent 执行期间，text_delta 经 SubagentStream 合并后由此通道转发。
      // [W1 修复] ctx.mode === 'rpc' 守卫：TUI/json/print 下 streamSink = undefined（无 widget 噪音），
      // rpc mode（GUI/xyz-agent）下保持原行为（ctx.ui.setWidget → sidecar → chatStore）。
      // streamSink API 不变（SubagentStream.onDelta 仍可调，只是 TUI 下 stream 不会被创建）。
      streamSink: ctx.mode === "rpc"
        ? { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) }
        : undefined,
      // [#24] uiRequestHandler 单一注入入口：上方 setUiRequestHandler 已注入（SR-3 语义，
      // new/existing service 均覆盖）。此处不再重复传 initSession.uiRequestHandler，避免
      // 同一 handler 双路径注入造成的语义混淆与“哪一个是 source of truth”歧义。
      // mode 仍需 session 级注入（uiObservability.setMode 依赖它，与 handler 无关）。
      mode: ctx.mode,
      // SR-4：注入 L2 dialog 队列——session-runner child close 时调 rejectChildDialogs
      // 清理该 child 在 L2 的 pending dialog，防全局死锁（C1 修复：清理路径接通）。
      dialogQueue,
      // [竞态修复] 注入 ctx.isIdle：notifier flush 在主 agent busy 时退避，idle 后再
      // sendMessage(triggerTurn)，规避 agent_end→finishRun 窗口里走 steer 分支丢失通知。
      isIdle: () => ctx.isIdle(),
    });

    if (!existingService) {
      setModelConfigService(modelService);
      setSubagentService(service);
    }

    // S-2: 启动 idle record GC 定时器（30 天 TTL，每小时检查一次）
    service.startGcTimer();

    try {
      maybeCleanupExpiredSessionFiles(agentDir, cwd);
    } catch (err) {
      logger.warn("[subagents] expired session file cleanup failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    // ADR-035 启动恢复：扫描 manifest tmp 残留（崩溃打断的 writeManifest 留下），
    // 每次 session_start 都调（与上方 maybeCleanupExpiredSessionFiles 一致）。
    try {
      const recovered = await service.recoverManifestTmpFiles();
      if (recovered.recovered > 0 || recovered.deleted > 0) {
        logger.warn(`[subagents] manifest tmp recovery: ${recovered.recovered} promoted, ${recovered.deleted} deleted`);
      }
    } catch (err) {
      logger.warn("[subagents] manifest tmp recovery failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const wtm = new WorktreeManager(agentDir);
      await wtm.scan();
    } catch (err) {
      logger.warn("[subagents] worktree reaper scan failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    // ── workflow 域：per-session store + runs ──
    const sessionDir = resolveSessionDir();
    const store = new JsonlRunStore({
      sessionDir,
      pi,
      ctx,
    });
    const runs = new Map<string, WorkflowRun>();

    // F-4/D-003: agent 发现走 shared/resource-discovery（ADR-031），modelService
    // 自持 AgentRegistry（subagents/workflow 两域共用同一发现结果）。
    // M2 修正：workflow 域 resolveAgentOpts 不再消费 agentRegistry（agent ref 交
    // resolveIdentity），无需经 state 透传——modelService 是唯一 registry 源。

    // MF-1: store 健康度跟踪。loadAll 失败 → storeHealthy=false，workflow 域启动时 fail-fast。
    let storeHealthy = true;
    try {
      const loaded = await store.loadAll();
      for (const run of loaded) {
        if (run.state.status === "running") {
          run.state.error = "Process killed (kill-9 or crash recovery)";
          run.transition("done", "failed");
          pi.events.emit("pending:unregister", {
            id: run.runId,
            reason: "failed",
          });
          // 恢复终态必须落盘：save 走冷路径（done 绕过去抖）同步写 state 文件 +
          // append 终态 workflow-record entry——entry_appended 事件驱动 runtime 派生
          // 缓存失效重拉（无 triggerTurn 副作用）。不 save 则 entry/state 双双停留
          // running，侧栏永久卡 running。失败仅记日志不阻断其余 run 的恢复（下次
          // session_start 重开重试，恢复循环天然幂等）。
          try {
            await store.save(run);
          } catch (err) {
            logger.error("[subagent-workflow] kill-9 recovery store.save failed", {
              runId: run.runId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        runs.set(run.runId, run);
      }
      // done run 内存有界性：loadAll 全量重水合后立即裁剪到 K。kill-9 恢复（上方
      // running → transition("done","failed")）的 run completedAt 为 transition 时刻
      // （当前时间=全局最新）参与排序且必在保留端；多条恢复 run 同 ms completedAt →
      // tie 稳定排序。淘汰只 delete runs Map 条目——磁盘 state 文件与
      // workflow-state-link 指针条目均不动（历史审计保留）；下次 session_start loadAll
      // 从指针全量重水合后再次裁剪，该循环每次 session 启动重复且可接受：内存峰值只在
      // 启动期，常驻 O(K + 活跃 run)。消除启动峰值需指针 compaction，属 append+replay
      // 长期方案问题域，非本范围。
      const evicted = evictDoneRunsBeyondCap(runs, MAX_RETAINED_DONE_RUNS);
      if (evicted > 0) {
        logger.debug("[subagent-workflow] evicted done runs beyond cap after loadAll", {
          evicted,
          keep: MAX_RETAINED_DONE_RUNS,
          sessionId,
        });
      }
    } catch (err) {
      // QMF-4 fix: store.loadAll 失败是关键路径错误，workflow 域将未初始化
      logger.error("[subagent-workflow] store.loadAll failed, workflow domain uninitialized", {
        reason: err instanceof Error ? err.message : String(err),
      });
      storeHealthy = false;
    }

    // D-008: per-session SAR（需要 ctxModel 填底 + subagentService 委托目标）。
    // old: const runner = new SubprocessAgentRunner()（module-level singleton，无 deps）
    // new: per-session session_start 时创建，通过 sessionState 传给 makeDeps。
    const runner = new SubprocessAgentRunner({
      subagentService: service,
      ctxModel: ctx.model ?? undefined,
    });

    // [engine-awareness D1b] lastEngine 初始化：构造性同源——单次 reloadGlobalConfig
    // 读取同时刷新 Service 路由缓存与 lastEngine 基准，消灭 initModel 与本处两次独立
    // 读取间的分叉窗口（两读值不一致时检测走 unchanged 分支不 reload，状态段/路由
    // 永停旧值且永不通知）。ok/absent → 归一后的当前引擎；failed → undefined（首 turn
    // 检测静默基线化兜底，此时缓存亦保持不动）。/resume、/fork 同样走 session_start
    // （SR-3），基线天然覆盖。
    const engineRead = modelService.reloadGlobalConfig();
    sessionState.set(sessionId, {
      store,
      runs,
      sessionDir,
      runner,
      ctx,
      storeHealthy,
      lastEngine:
        engineRead.status === "failed" ? undefined : normalizeEngineId(engineRead.config.defaultEngine),
    });
  });

  // ════════════════════════════════════════════════════════════
  //  [U2 P-B4 降级] session_compact：compaction 对 custom entry 保留行为实装未
  //  验证——检测 ledger/ack entry 被 compaction 清除时按内存态补写（notify-ledger
  //  compactionCheck；未清除则 no-op）。内存态在 compaction 后仍活着，作为补写源；
  //  重启后的权威仍是两列 entry 差集（内存不承担销账职责）。
  // ═══════════════════════════════════════════════════════
  pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
    try {
      const rewritten = getBoundNotifyLedger()?.compactionCheck() ?? 0;
      if (rewritten > 0) {
        logger.warn(`[subagents] notify ledger entries lost to compaction; rewrote ${rewritten} from memory`);
      }
    } catch (err) {
      logger.warn("[subagents] notify ledger compactionCheck failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ════════════════════════════════════════════════════════════
  //  [U7 + engine-awareness U3] before_agent_start：引擎感知注入（链尾注册，D7——
  //  段内容变化只断 system prompt 尾部 cache 前缀）。
  //  ① per-turn 检测编排（§2.3 数据流）：三态 poll config → lastEngine diff →
  //     变更时读取结果先行提交缓存（D2，applyGlobalConfig 纯赋值，本 turn 路由生效）
  //     → sendMessage 通知
  //     （D3，不设 triggerTurn——P1 探针已证此形态消息进入本 turn LLM 上下文，
  //     证据：真机 pi rpc payload dump + 0.84.4 dist sendMessage→_appendCustomMessage
  //     →agent.state.messages.push→createContextSnapshot 调用链）→ 更新 lastEngine。
  //  ② 恒在状态段 <current_subagent_engine>（D6）+ 引擎清单段 <available_<engine>_models>。
  //     apply 后 getGlobalConfig() 即新值——通知、状态段、路由三处同 turn 对齐（G2）。
  //  段序：状态段在前（文案声明 "listed ... below"），清单段在后；provider models 段
  //  由更早注册的 handler 注入、位于上方。fail-safe 任何异常不注入不阻塞 agent loop。
  // ════════════════════════════════════════════════════════════
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      const service = getModelConfigService();
      if (service === null || typeof event.systemPrompt !== "string") return undefined;
      const sid = ctx.sessionManager.getSessionId();
      runEngineAwarenessTurn({
        readConfig: () => readGlobalConfig(getAgentDir()),
        applyRead: (read) => service.applyGlobalConfig(read),
        sendMessage: (message) => {
          // D3：不设 triggerTurn——切换是用户主动行为，无需唤醒 AI 立即行动
          pi.sendMessage(message, {});
        },
        getLastEngine: () => sessionState.get(sid)?.lastEngine,
        setLastEngine: (engine) => {
          const state = sessionState.get(sid);
          if (state) state.lastEngine = engine;
        },
      });
      const defaultEngine = service.getGlobalConfig().defaultEngine;
      const append = [buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]
        .filter((part) => part !== "")
        .join("\n\n");
      return { systemPrompt: `${event.systemPrompt}\n\n${append}` };
    } catch {
      return undefined;
    }
  });

  // ════════════════════════════════════════════════════════════
  //  model_select：用户切换 model 时刷新缓存
  // ════════════════════════════════════════════════════════════
  pi.on("model_select", (event, ctx: ExtensionContext) => {
    const service = getModelConfigService();
    if (service && typeof service.setCtxModel === "function") {
      service.setCtxModel(event.model);
    }
    // H1: 同步刷新所有 session 的 SAR ctxModel（旧实现只在 session_start 固化）
    const sid = ctx.sessionManager.getSessionId();
    const state = sessionState.get(sid);
    if (state) {
      state.runner.updateCtxModel(event.model);
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_tree：切分支前终止所有 running run（一次性生命周期——切走即作废）
  // ════════════════════════════════════════════════════════════
  pi.on("session_tree", async (_event: SessionTreeEvent, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lsRef.lastSessionId = sessionId;

    const state = sessionState.get(sessionId);
    if (state) {
      // 一次性生命周期（D-2）：running run 转 done,failed 落盘（helper 内部自过滤
      // running，单 run 失败不中断其余）。此处不再挂起待恢复。
      try {
        await terminateRunningRuns(makeDeps(state, ctx), "Session switched: run terminated");
      } catch (err) {
        bestEffort(err, "terminateRunningRuns (session_tree handler)");
      }
    }
  });

  // ════════════════════════════════════════════════════════════
  //  SP-4: session_before_fork（/fork）/ session_before_switch（/new）级联关闭
  // ════════════════════════════════════════════════════════════
  //  主 session /fork 或 /new 时，清理旧 record（disposeAllRecords：CAS 转终态 +
  //  archive + worktree 清理）。before 事件在 session 替换前触发，确保旧 session 的
  //  subagent 在新 session 创建前被清理（随后的 session_shutdown → dispose 收割子进程）。
  //
  //  [M2 修复] 旧实现把 /new 级联挂在 session_before_tree 上——SDK 中该事件只由
  //  AgentSession.navigateTree()（/tree 同 session 分支切换）触发，/new 走
  //  session_before_switch(reason:"new") + session_shutdown(reason:"new")，从不触发
  //  before_tree。后果双向：/new 级联是死代码；普通 /tree 分支导航反而误杀全部活跃
  //  subagent。现 /new 改挂 session_before_switch(reason==="new")，before_tree handler
  //  移除（/tree 是同 session 内导航，record/子进程归属不变，无级联关闭诉求）。
  pi.on("session_before_fork", (_event, _ctx) => {
    const service = getSubagentService();
    if (service) {
      const count = service.onParentFork();
      if (count > 0) {
        logger.warn(`[subagents] /fork 级联关闭 ${count} 个 subagent`);
      }
    }
  });

  pi.on("session_before_switch", (event, _ctx) => {
    // /new（reason:"new"）创建全新 session → 级联关闭旧 record。
    // reason:"resume"（/resume /import 回到已有 session）不级联：record 按 rootSessionId
    // 归属隔离，跨 session 读写由 store 过滤守卫，无需销毁。
    if (event.reason !== "new") return;
    const service = getSubagentService();
    if (service) {
      const count = service.onParentNew();
      if (count > 0) {
        logger.warn(`[subagents] /new 级联关闭 ${count} 个 subagent`);
      }
    }
  });

  // ════════════════════════════════════════════════════════════
  //  session_shutdown：dispose subagents + terminate workflows + store 收尾 + cleanup
  //
  //  store 收尾：每 session 的 JsonlRunStore 在 terminateRunningRuns 之后 dispose（刷
  //  pending 去抖批 + await in-flight 链，见 W2C5）。R3 声明：SIGTERM/SIGINT 走下方
  //  process handler 不触发本路径，pending 去抖丢失等价崩溃链（重启后 kill-9 恢复
  //  收编 running 残留——终态/创建均冷路径已落盘，丢的只有 ≤saveDebounceMs 的
  //  running 尾巴，ES1 已接受）；不做 best-effort SIGTERM dispose（需同步 IO 改造，
  //  超出 wave 边界）。
  // ════════════════════════════════════════════════════════════
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    // ── subagents 域：dispose SubagentService ──
    getSubagentService()?.dispose();

    // ── workflow 域：terminate 所有 running run + store 收尾 + 清理 temp files ──
    // H-5: 遍历所有 sessionState 条目清理（而不只 lastSessionId——
    // 防御 session 切换但 session_tree 未先触发导致 lastSessionId 指向已删除 session 的情况）。
    for (const [sessionId, state] of sessionState) {
      // 编排顺序（W2C5）：terminate（await，failed 落盘——重启后 kill-9 恢复不误判）
      // → store.dispose（await，刷 pending 去抖批 + await in-flight 链，关「shutdown
      // 时刻 pending 去抖写丢失」窗口）→ delete。terminate 的 running 过滤在 helper
      // 内部（单 run 失败不中断其余）；外层 try/catch 兜底防单 session 异常中断后续
      // session 条目的 dispose + delete（对齐原 allSettled 的不中断语义）。
      try {
        await terminateRunningRuns(makeDeps(state, _ctx), "Session shutdown: run terminated");
      } catch (err) {
        bestEffort(err, "terminateRunningRuns (session_shutdown handler)");
      }
      // dispose 自身恒 resolve，catch 兜底防御——handler 内抛错会中断后续 session
      // 条目清理。不留静默吞错（错误必须可操作）：debug 留痕带 sessionId/sessionDir，
      // 排查「shutdown 后 run 状态不落盘」类问题时有迹可循。
      await state.store.dispose().catch((err: unknown) => {
        logger.debug(
          `[subagent-workflow] session_shutdown store.dispose failed (sessionId=${sessionId}, sessionDir=${state.sessionDir})`,
          { reason: err instanceof Error ? err.message : String(err) },
        );
      });
      sessionState.delete(sessionId);
    }

    // M2: 清理 dialog queue 运行时状态（queue/current/processing）。
    // [#10] rejectAll() settle 所有 pending dialog Promise（防闭包泄漏：未 settle 的
    // Promise 持有 resolve/reject 闭包及 handler 上下文，session 退出后仍挂在全球队列上），
    // 并内部重置 queue/current/processing（原子操作，无 footgun）。
    // 单 session 假设（M-2，同 lastSessionId）：rejectAll() 清空进程级单例的所有 pending，
    // 依赖 Pi 单进程单 session 串行保证——不会误清其他 session。多 session 并发的迁移策略
    // 见 DialogGlobalQueue 类注释（rejectAllForSession）。
    // channel registry 不清：跨 session 持久是有意设计（ask-user 扩展注册的 channel handler
    // 在 /new /resume /fork 时不丢失注册）。
    const dialogQueue = getOrCreateDialogQueue();
    dialogQueue.rejectAll();
  });

  // ════════════════════════════════════════════════════════════
  //  [V2 决策 7 防线 i] process 级 shutdown hook（显式收割三道防线之一）
  //
  //  上方 session_shutdown（pi async hook）在进程被 SIGTERM/SIGINT 强杀或崩溃时
  //  不触发，此处 process.on 兜底确保 sync 子进程被收割（防线 i：shutdown 时显式
  //  SIGTERM 全部 activation）。
  //
  //  - SIGTERM：pi 各 mode（rpc/interactive/print）自带 SIGTERM handler 负责退出编排，
  //    本 extension 的 handler 只做收割 + 设 exitCode（不 re-raise、不抢 pi 的退出语义；
  //    xyz-agent 桌面 supervisor 用 SIGTERM 杀 pi 走这条路）。
  //  - SIGINT：pi 本体不注册常规 SIGINT handler（interactive/print/rpc 均 SIGTERM only），
  //    依赖 Node 默认终止。本 extension 注册 listener 即取消默认终止——若只设 exitCode，
  //    本地 pi CLI 的 Ctrl-C 杀不死进程（TUI/stdin/agent loop 仍在事件循环）。故收割
  //    完成后 re-raise 恢复默认终止，见下方 sigintHandler。
  //  - beforeExit 是退出前最后事件，不 exit（自然退出）。
  //  - idempotent guard（reapSpawnedChildrenOnShutdown 内）防多信号叠加重复 kill。
  //
  //  防线 iii（activate 互斥）已接入：subagent-service.ts 冷路径 resume 调
  //  acquireActivateLock（含 30s 超时兜底，见 lifecycle-manager.ts ACTIVATE_LOCK_TIMEOUT_MS）。
  //  防线 ii（启动 scanOrphanProcesses）骨架就位，启动时接入待实现。
  // ════════════════════════════════════════════════════════════
  process.on("SIGTERM", () => {
    reapSpawnedChildrenOnShutdown();
    // S-3: 改用 process.exitCode 而非 process.exit(0)，让子进程 cleanup 完成后再自然退出。
    // process.exit(0) 会立即终止，可能在 reapSpawnedChildrenOnShutdown 完成前截断。
    // 退出编排归 pi 自身的 SIGTERM handler（rpc-mode 会主动退出）。
    process.exitCode = 0;
  });
  // [review 修复] SIGINT re-raise：收割同步完成后，先移除自身 listener 再向自身重发
  // SIGINT，恢复 Node 默认终止。不 removeListener 直接 kill(process.pid) 会再次进入
  // 本 handler 递归；移除后无其他 SIGINT listener（pi 不注册）→ 默认行为终止进程。
  const sigintHandler = (): void => {
    reapSpawnedChildrenOnShutdown();
    process.removeListener("SIGINT", sigintHandler);
    process.kill(process.pid, "SIGINT");
  };
  process.on("SIGINT", sigintHandler);
  process.on("beforeExit", reapSpawnedChildrenOnShutdown);

  // ════════════════════════════════════════════════════════════
  //  pi.__workflowRun（D-8 签名）
  // ════════════════════════════════════════════════════════════
  pi.__workflowRun = async (
    workflowName: string,
    workflowArgs: Record<string, unknown>,
    workflowSignal?: AbortSignal,
    workflowTimeoutMs?: number,
  ): Promise<WorkflowRunResult> => {
    // 注意：lastSessionId 是单值假设——Pi 当前保证单 session 串行（一次只一个活跃 session）。
    // 若未来 Pi 支持多 session 并发，此处需改为从 ctx.sessionManager.getSessionId() 显式传入。
    // M-2 已记录此假设。
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) {
      return {
        status: "done",
        reason: "failed",
        error: "Session not initialized",
        runId: "",
      };
    }
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      return {
        status: "done",
        reason: "failed",
        error: "Workflow store unavailable (loadAll failed in session_start)",
        runId: "",
      };
    }
    return runAndWait(
      workflowName,
      workflowArgs,
      makeDeps(state, state.ctx),
      workflowSignal,
      workflowTimeoutMs,
    );
  };

  // ════════════════════════════════════════════════════════════
  //  Tools（3 个）—— lazy deps 注入
  // ════════════════════════════════════════════════════════════
  const getDeps = () => {
    // 注意：lastSessionId 是单值假设——Pi 当前保证单 session 串行（一次只一个活跃 session）。
    // 若未来 Pi 支持多 session 并发，此处需改为从 ctx.sessionManager.getSessionId() 显式传入。
    // M-2 已记录此假设。
    const state = sessionState.get(lsRef.lastSessionId);
    if (!state) throw new Error("Session not initialized");
    // MF-1: store 不健康时 fail-fast，避免 store.save 再次失败导致 run 状态不落地。
    if (!state.storeHealthy) {
      throw new Error("Workflow store unavailable (loadAll failed in session_start)");
    }
    return makeDeps(state, state.ctx);
  };

  const lazyDeps: LauncherDeps = {
    get store() {
      return getDeps().store;
    },
    workerHost,
    get runner() {
      return getDeps().runner;
    },
    get runs() {
      return getDeps().runs;
    },
    registry,
    get onRunDone() {
      return getDeps().onRunDone;
    },
    get eventBus() {
      return getDeps().eventBus;
    },
    get scheduleTimeBudget() {
      return getDeps().scheduleTimeBudget;
    },
    get onWorkflowCall() {
      return getDeps().onWorkflowCall;
    },
    get log() {
      return getDeps().log;
    },
  };

  registerWorkflowTool(pi, lazyDeps, guard);
  registerWorkflowScriptTool(pi, registry, isScriptRunning);

  // ════════════════════════════════════════════════════════════
  //  Commands（2 个）
  // ════════════════════════════════════════════════════════════
  registerWorkflowsCommand(
    pi,
    () => {
      const state = sessionState.get(lsRef.lastSessionId);
      return state?.runs ?? new Map();
    },
    lazyDeps,
  );
}

// ============================================================
// 进程级单例（channel registry + dialog queue）
// ============================================================

// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API）。
// dialog queue 仍为本模块私有——无外部消费者。
const DIALOG_QUEUE_KEY = Symbol.for("@zhushanwen/pi-subagents.dialogQueue");

/** 获取或创建进程级 dialog queue 单例。
 *  L2 跨子进程串行队列——所有子进程的 dialog 类请求共享同一队列实例。 */
function getOrCreateDialogQueue(): DialogGlobalQueue {
  let queue = Reflect.get(globalThis, DIALOG_QUEUE_KEY) as DialogGlobalQueue | undefined;
  if (!queue) {
    queue = new DialogGlobalQueue();
    Reflect.set(globalThis, DIALOG_QUEUE_KEY, queue);
  }
  return queue;
}

// 跨扩展 channel handler 注册入口已收口到 core 深路径
// `@zhushanwen/subagent-core/execution/channel-registry-access.ts`
// （getOrCreateChannelRegistry / UiChannelRegistry / ChannelHandler）。
// 历史上的包根 re-export 已删：ask-user 等跨扩展消费者经 globalThis 握手
// （DIALOG_QUEUE_KEY 同款进程级单例），不再经包根 import 消费本模块。
