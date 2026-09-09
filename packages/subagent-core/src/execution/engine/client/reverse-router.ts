// src/execution/engine/client/reverse-router.ts
//
// 反向请求（帧④）路由器（EngineClient 的内部模块，从 engine-client.ts 拆出——
// max-lines 纪律 + 职责域独立：超时域二分（R9-2/R9-2b）的全部 core 侧语义都
// 落在本文件）。
//
// 超时域划分（impl-plan §2.2 / 设计 §3.3 帧④注释）：
//   - 快答数据面（host/log / host/streamDelta / host/poolResolved / host/handleReady /
//     host/childSpawned / host/childStateChanged）：分发 + 回 {ok:true}，10s 应答守卫
//     ——10s 未答 = 引擎故障 → 杀进程 + 在途 run 失败（REVERSE_REQUEST_TIMEOUT_MS）；
//   - 人机交互面（host/askUser / host/permission）：ack 两阶段——收即回 {ack:true}，
//     handler 结果异步补帧②，**不计时**（R9-2：已 ack 的等待不参与任何 in-flight
//     超时，ADR-0047 静默 ≠ 卡死）；未注入 handler → {unsupported:true}；
//   - 未知 host/* 通道 → {unsupported:true}（引擎自行降级，不重试）。

import {
  getLogger,
  REVERSE_CHANNEL_TIMEOUT_CLASS,
  REVERSE_REQUEST_TIMEOUT_MS,
  type HostAskUserParams,
  type HostChildSpawnedParams,
  type HostChildStateChangedParams,
  type HostHandleReadyParams,
  type HostLogParams,
  type HostPermissionParams,
  type HostPoolResolvedParams,
  type HostRoundLifecycleParams,
  type HostStreamDeltaParams,
  type UiRequest,
} from "@zhushanwen/subagent-engine-sdk";

import type { SpawnedChildrenMirror } from "./mirror.ts";
import type { RunRoute } from "./engine-client.ts";

const logger = getLogger("subagents");

/** 路由器依赖面（EngineClient 注入；全部单向引用，无回环持有）。 */
export interface ReverseRouterDeps {
  engineId: string;
  /** host/askUser 应答端（[D4-④] subagent-service init.uiRequestHandler 注入点）。 */
  uiRequestHandler?: (req: UiRequest) => Promise<unknown>;
  /** host/permission 应答端（v1 骨架注入点）。 */
  permissionHandler?: (params: HostPermissionParams) => Promise<unknown>;
  /** host/log 落宿主日志（缺省 SDK logger facade）。 */
  log?: (params: HostLogParams) => void;
  /** run 作用域通知路由表（EngineClient 持有，EngineClient 生命周期内同一引用）。 */
  runRoutes: Map<string, RunRoute>;
  /** [W3 v1.x] chat 轮次路由表（recordId 键；EngineClient 持有，同上）。 */
  recordRoutes: Map<string, RunRoute>;
  /** childSpawned/childStateChanged 的镜像落点。 */
  mirror: SpawnedChildrenMirror;
  /** handleReady 的 partial handle 回填（崩溃合成 handle 数据源）。 */
  setPartialHandle: (partial: { sessionRef: Record<string, string>; poolKey: string }) => void;
  /** 帧②应答出口。 */
  sendResponse: (id: string, result: unknown) => boolean;
  /** 引擎故障拉起杀链（killAll）。 */
  failEngine: (reason: string) => Promise<void>;
  /** 客户端是否已停机（停机后不再写帧）。 */
  isDisposed: () => boolean;
}

/** 帧④入口（EngineClient.handleLine 委托）。 */
export function routeReverseRequest(deps: ReverseRouterDeps, frame: { id: string; method: string; params: unknown }): void {
  if (frame.method === "host/askUser") {
    handleInteractionRequest(deps, frame, deps.uiRequestHandler, (params) => (params as HostAskUserParams).request as UiRequest);
    return;
  }
  if (frame.method === "host/permission") {
    handleInteractionRequest(deps, frame, deps.permissionHandler, (params) => params as HostPermissionParams);
    return;
  }
  const timeoutClass = (REVERSE_CHANNEL_TIMEOUT_CLASS as Record<string, string | undefined>)[frame.method];
  if (timeoutClass === "data-plane") {
    handleDataPlaneRequest(deps, frame);
    return;
  }
  deps.sendResponse(frame.id, { unsupported: true });
}

/**
 * 人机交互面 ack 两阶段（R9-2）：先回 {ack:true}，handler 结果异步补帧②。
 * **不计时**——已 ack 的等待属人机交互异步等待，不参与任何 in-flight 超时；
 * handler 永不 resolve（用户不答）也不判引擎故障。handler 抛错兜底
 * {cancelled:true}（dialog-queue 应答链同款语义）。
 */
function handleInteractionRequest<P>(
  deps: ReverseRouterDeps,
  frame: { id: string; method: string; params: unknown },
  handler: ((input: P) => Promise<unknown>) | undefined,
  extract: (params: unknown) => P,
): void {
  if (handler === undefined) {
    deps.sendResponse(frame.id, { unsupported: true });
    return;
  }
  deps.sendResponse(frame.id, { ack: true });
  let input: P;
  try {
    input = extract(frame.params);
  } catch {
    deps.sendResponse(frame.id, { cancelled: true });
    return;
  }
  void (async () => {
    try {
      const result = await handler(input);
      if (!deps.isDisposed()) deps.sendResponse(frame.id, result);
    } catch (err) {
      logger.warn(
        `[engine-client:${deps.engineId}] ${frame.method} handler failed, answering cancelled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (!deps.isDisposed()) deps.sendResponse(frame.id, { cancelled: true });
    }
  })();
}

/**
 * 快答数据面（R9-2 二分）：分发 + 回 {ok:true}，全程受 10s 应答守卫——10s 未答 =
 * 引擎故障 → 杀进程 + 在途 run 失败。当前各通道分发都是快操作；守卫覆盖的是
 * 「handler 返回的 promise 挂住」的演化面（挂起 = 宿主消费方死锁，须 fail-fast
 * 拉起杀链，防止 core 被单通道拖死）。分发抛错不判引擎故障（宿主回调 bug 不该
 * 杀引擎），仍回 {ok:true} + warn 留痕。
 */
function handleDataPlaneRequest(deps: ReverseRouterDeps, frame: { id: string; method: string; params: unknown }): void {
  let settled = false;
  const guardTimer = setTimeout(() => {
    if (settled) return;
    logger.error(
      `[engine-client:${deps.engineId}] data-plane reverse request ${frame.method} `
        + `unanswered for ${REVERSE_REQUEST_TIMEOUT_MS}ms — treating as engine fault`,
    );
    void deps.failEngine(
      `data-plane reverse request ${frame.method} unanswered for ${REVERSE_REQUEST_TIMEOUT_MS}ms (engine fault)`,
    );
  }, REVERSE_REQUEST_TIMEOUT_MS);
  void Promise.resolve()
    .then(() => dispatchDataPlane(deps, frame.method, frame.params))
    .then(
      () => {
        settled = true;
        clearTimeout(guardTimer);
        deps.sendResponse(frame.id, { ok: true });
      },
      (err: unknown) => {
        settled = true;
        clearTimeout(guardTimer);
        logger.warn(
          `[engine-client:${deps.engineId}] ${frame.method} dispatch failed (answering ok, host-side bug): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        deps.sendResponse(frame.id, { ok: true });
      },
    );
}

/** 数据面单通道分发器（params 形态自证——发帧前引擎侧自检，分发层只做强转）。 */
type DataPlaneHandler = (deps: ReverseRouterDeps, params: unknown) => Promise<void> | void;

/** method → 分发器表（表外 method = 无操作；路由面准入已由 REVERSE_CHANNEL_TIMEOUT_CLASS 收敛为 data-plane）。 */
const DATA_PLANE_HANDLERS: Record<string, DataPlaneHandler> = {
  "host/log": (deps, params) => dispatchLog(deps, params as HostLogParams),
  "host/streamDelta": (deps, params) => dispatchStreamDelta(deps, params as HostStreamDeltaParams),
  "host/roundLifecycle": (deps, params) => dispatchRoundLifecycle(deps, params as HostRoundLifecycleParams),
  "host/poolResolved": (deps, params) => dispatchPoolResolved(deps, params as HostPoolResolvedParams),
  "host/handleReady": (deps, params) => dispatchHandleReady(deps, params as HostHandleReadyParams),
  "host/childSpawned": (deps, params) => dispatchChildSpawned(deps, params as HostChildSpawnedParams),
  "host/childStateChanged": (deps, params) => dispatchChildStateChanged(deps, params as HostChildStateChangedParams),
};

async function dispatchDataPlane(deps: ReverseRouterDeps, method: string, params: unknown): Promise<void> {
  await DATA_PLANE_HANDLERS[method]?.(deps, params);
}

function dispatchLog(deps: ReverseRouterDeps, p: HostLogParams): void {
  if (deps.log !== undefined) deps.log(p);
  else logger[p.level](`[engine:${p.component}] ${p.message}`, p.data);
}

async function dispatchStreamDelta(deps: ReverseRouterDeps, p: HostStreamDeltaParams): Promise<void> {
  // [W3 v1.x 接线（W1 偏差 #1 的替换落地）] 关联键分路（D1-A）：
  //   - recordId 键 = chat 续聊轮 delta（interact 发起，无独立 runId）→ recordRoutes；
  //   - runId 键 = run 域轮（含 run 会话形态首轮）→ runRoutes（v1 现状不变）。
  // 无注册路由 = 该轮宿主消费面未挂（诊断形态）——静默丢弃（数据面已 ack，
  // 引擎侧不重发；路由缺席非引擎故障）。
  if (p.recordId !== undefined) {
    await deps.recordRoutes.get(p.recordId)?.onStreamDelta?.(p.delta);
    return;
  }
  await deps.runRoutes.get(p.runId)?.onStreamDelta?.(p.delta);
}

async function dispatchRoundLifecycle(deps: ReverseRouterDeps, p: HostRoundLifecycleParams): Promise<void> {
  // [W3 v1.x] 第 9 反向通道消费（settled/idle/failed 三相位 × runId|recordId 键）。
  // 相位语义（arm/disarm/交棒/失败分诊）归宿主编排层——本路由只做键分发，
  // 消费方 = RunContext.onRoundLifecycle（首轮 runId 键）与 registerChatRoundRoute
  // 路由（续聊轮 recordId 键）。载荷形状自证（isHostRoundLifecycleParams）归
  // 引擎侧发帧前自检 + 消费方，分发层不重复判别（与 streamDelta 一致的薄分发）。
  if (p.recordId !== undefined) {
    await deps.recordRoutes.get(p.recordId)?.onRoundLifecycle?.(p);
    return;
  }
  await deps.runRoutes.get(p.runId)?.onRoundLifecycle?.(p);
}

async function dispatchPoolResolved(deps: ReverseRouterDeps, p: HostPoolResolvedParams): Promise<void> {
  await deps.runRoutes.get(p.runId)?.onPoolResolved?.(p.poolKey);
}

async function dispatchHandleReady(deps: ReverseRouterDeps, p: HostHandleReadyParams): Promise<void> {
  deps.setPartialHandle({ sessionRef: p.sessionRef, poolKey: p.poolKey });
  await deps.runRoutes.get(p.runId)?.onHandleReady?.({
    sessionRef: p.sessionRef,
    poolKey: p.poolKey,
  });
}

function dispatchChildSpawned(deps: ReverseRouterDeps, p: HostChildSpawnedParams): void {
  deps.mirror.recordSpawned(p.pid, p.recordId);
  // POSIX 运行时组探测（W10 / A3 前提②）：任务子进程应与引擎同组（收割 =
  // 引擎进程组级 kill(-enginePid)）。kill(-pid, 0) 成功 ⟺ 该 pid 自成进程组
  // （setsid/detached 后代）⟺ 不在引擎收割组内 → 告警留痕（不判 fail——
  // detached 后代是设计 §3.9 已接受代价）。Windows 无外部判据（无 kill(-pid,0)
  // 等价物），仅 SDK 层 spawnEngineChild 形态保证，真机面挂 A3 手动门。
  if (process.platform !== "win32" && typeof p.pid === "number") {
    try {
      process.kill(-p.pid, 0);
      logger.warn(
        `[engine-client:${deps.engineId}] childSpawned pid ${p.pid} leads its own process group `
          + `(not in the engine harvest group — one-generation children + in-group descendants `
          + `only; engine-detached descendants are an accepted cost per design §3.9)`,
      );
    } catch (err) {
      // ESRCH = pid 非组长 = 在引擎组内（预期形态）；其余 errno 同按预期形态
      // debug 留痕（组探测异常排查时的最低可见性，不判 fail）。
      logger.debug(
        `[engine-client:${deps.engineId}] childSpawned pid ${p.pid} group probe settled ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

function dispatchChildStateChanged(deps: ReverseRouterDeps, p: HostChildStateChangedParams): void {
  deps.mirror.recordStateChanged({
    pid: p.pid,
    recordId: p.recordId,
    state: p.state,
    killed: p.killed,
    exitCode: p.exitCode,
    signal: p.signal,
  });
}
