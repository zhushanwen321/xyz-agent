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

async function dispatchDataPlane(deps: ReverseRouterDeps, method: string, params: unknown): Promise<void> {
  switch (method) {
    case "host/log": {
      const p = params as HostLogParams;
      if (deps.log !== undefined) deps.log(p);
      else logger[p.level](`[engine:${p.component}] ${p.message}`, p.data);
      break;
    }
    case "host/streamDelta": {
      const p = params as HostStreamDeltaParams;
      await deps.runRoutes.get(p.runId)?.onStreamDelta?.(p.delta);
      break;
    }
    case "host/poolResolved": {
      const p = params as HostPoolResolvedParams;
      await deps.runRoutes.get(p.runId)?.onPoolResolved?.(p.poolKey);
      break;
    }
    case "host/handleReady": {
      const p = params as HostHandleReadyParams;
      deps.setPartialHandle({ sessionRef: p.sessionRef, poolKey: p.poolKey });
      await deps.runRoutes.get(p.runId)?.onHandleReady?.({
        sessionRef: p.sessionRef,
        poolKey: p.poolKey,
      });
      break;
    }
    case "host/childSpawned": {
      const p = params as HostChildSpawnedParams;
      deps.mirror.recordSpawned(p.pid, p.recordId);
      break;
    }
    case "host/childStateChanged": {
      const p = params as HostChildStateChangedParams;
      deps.mirror.recordStateChanged({
        pid: p.pid,
        recordId: p.recordId,
        state: p.state,
        killed: p.killed,
        exitCode: p.exitCode,
        signal: p.signal,
      });
      break;
    }
    default:
      break;
  }
}
