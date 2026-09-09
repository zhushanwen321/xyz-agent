// src/execution/engine/host/spawned-children.ts
//
// core 侧 spawnedChildren 状态镜像 + inproc 过渡桥（W6，impl-plan §2.6 首条 /
// 设计 §3.8 D2 表第 2 行）。
//
// 归属裁定（设计 §3.8 D2）：spawnedChildren Map + 子进程收割的**持有方 = 引擎进程**，
// core 只持状态镜像。本文件是 core 侧的公共消费面：
//   - subagent-service / subprocess-agent-runner 的注册与杀链调用改经本模块，
//     不再深路径 import engines/pi/session-runner（R3 S-C / R1 MF-5 改线落点）；
//   - lifecycle-predicates（hasLiveProcessHandle / isResumable）改读本模块读点，
//     不再 import engines/pi 内部（impl-plan §2.6 第 3 条）。
//
// 过渡桥（[W11 主 agent 裁决] chat 域 inproc 保留面，临时豁免）：chat 续聊链路
// 仍在 core 进程内跑 PiEngine（v1 协议载荷面缺口，协议 v1.x 扩展后收口）——
// session-runner 的 spawnedChildren Map 仍是 chat 域收割权威（dispose killAll /
// busy 投递热路径定位都消费它）。故本模块的公共 API 在写镜像的同时委托 inproc
// 实现（行为零变化）；读点 = 镜像 ∪ inproc 权威 map 并读（runSpawn 内部注册只落
// inproc map，不经过本模块注册 API——并读保证谓词不漏判）。cli 形态引擎经
// host/childSpawned / childStateChanged 反向通道上报，镜像成为该部分唯一数据源
// （与 client/mirror.ts 的失效语义同构）。chat 协议化收口时移除 inproc 委托。

import type { ChildProcess } from "node:child_process";

// inproc 过渡委托（W7 迁 pi 包 / W11 删本 import）
import {
  getChildByRecord as getInprocChildByRecord,
  killAllSpawnedChildren as killAllInprocSpawnedChildren,
  killRecordChildWithEscalation as killInprocRecordChildWithEscalation,
  registerSpawnedChildForRecord as registerInprocSpawnedChild,
} from "../engines/pi/session-runner.ts";

/** 镜像项（inproc 桥形态：recordId 键 + killed 判据，与 client/mirror.ts 载荷契约同构）。 */
export interface SpawnedChildMirrorEntry {
  /** 引擎侧一次性子进程 pid（诊断面；recordId 才是镜像 key）。 */
  pid?: number;
  /** 必含判据（`child !== undefined && !child.killed` 同构）：true = 已被杀/已终止。 */
  killed: boolean;
  /** 最近一次状态变更的墙钟时间戳（诊断面）。 */
  updatedAt: number;
}

/**
 * core 侧 spawnedChildren 状态镜像（进程级单例，globalThis[Symbol.for] 持有防 jiti
 * 双路径加载分裂——registry.ts 同款惯例）。镜像只是状态投影：不发信号、不杀进程
 * （收割 = 引擎进程组级；inproc 过渡期的实际杀链在 session-runner 委托里）。
 */
class CoreSpawnedChildrenMirror {
  private readonly entries = new Map<string, SpawnedChildMirrorEntry>();

  /** 落项 / 覆盖（同 recordId 重 spawn = 覆盖旧句柄，与 inproc Map 同语义）。 */
  register(recordId: string, child: { pid?: number; killed: boolean }): void {
    this.entries.set(recordId, {
      pid: child.pid,
      killed: child.killed,
      updatedAt: Date.now(),
    });
  }

  /** 单项置死（杀链入口：killRecordChildWithEscalation 途经）。 */
  markKilled(recordId: string): void {
    const entry = this.entries.get(recordId);
    if (entry !== undefined) {
      entry.killed = true;
      entry.updatedAt = Date.now();
    }
  }

  /** 整体置死 + 清空（失效语义 2+3：引擎 exit / 重建 / dispose / killAll）。 */
  killAll(): void {
    this.entries.clear();
  }

  getChildByRecord(recordId: string): SpawnedChildMirrorEntry | undefined {
    return this.entries.get(recordId);
  }

  /** 句柄存活谓词（镜像面；判据与 inproc `!child.killed` 同构）。 */
  hasLiveProcessHandle(recordId: string): boolean {
    const entry = this.entries.get(recordId);
    return entry !== undefined && !entry.killed;
  }

  /** 快照（诊断/测试）。 */
  snapshot(): SpawnedChildMirrorEntry[] {
    return [...this.entries.entries()].map(([recordId, entry]) => ({ recordId, ...entry }));
  }

  /** 测试隔离专用（生产禁用——进程级全局状态）。 */
  clear(): void {
    this.entries.clear();
  }
}

const MIRROR_SLOT_KEY = Symbol.for(
  "@zhushanwen/pi-subagent-workflow.coreSpawnedChildrenMirror",
);

function coreMirrorSlot(): CoreSpawnedChildrenMirror {
  let slot = Reflect.get(globalThis, MIRROR_SLOT_KEY) as CoreSpawnedChildrenMirror | undefined;
  if (!slot) {
    slot = new CoreSpawnedChildrenMirror();
    Reflect.set(globalThis, MIRROR_SLOT_KEY, slot);
  }
  return slot;
}

/** core 侧镜像访问点（诊断/测试；生产读点走下方公共 API）。 */
export function coreSpawnedChildrenMirror(): CoreSpawnedChildrenMirror {
  return coreMirrorSlot();
}

// ── 公共面 API（subagent-service / SAR 消费；签名与 session-runner 同名函数一致） ──

/**
 * 子进程注册（宿主记账回调 RunContext.onChildSpawned 的落点）：写镜像 + inproc 过渡
 * 委托（dispose killAll 收割兜底对 workflow 域引擎任务生效的现状行为保持）。
 */
export function registerSpawnedChildForRecord(recordId: string, child: ChildProcess): void {
  coreMirrorSlot().register(recordId, { pid: child.pid, killed: child.killed });
  registerInprocSpawnedChild(recordId, child);
}

/** 单 record 杀链升级（SIGTERM → 宽限 → SIGKILL）：镜像置死 + inproc 委托。 */
export function killRecordChildWithEscalation(recordId: string, source: string): void {
  coreMirrorSlot().markKilled(recordId);
  killInprocRecordChildWithEscalation(recordId, source);
}

/** 全量收割（dispose / parent-shutdown）：inproc 杀链 + 镜像整体置死。 */
export function killAllSpawnedChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  const killed = killAllInprocSpawnedChildren(signal);
  coreMirrorSlot().killAll();
  return killed;
}

/**
 * 句柄存活读点（lifecycle-predicates 的 hasLiveProcessHandle / isResumable 消费）。
 * 过渡期并读：镜像 ∪ inproc 权威 map——runSpawn 内部注册只落 inproc map（不经注册
 * API），并读保证与改线前行为逐点一致；任一面活即活。
 */
export function hasLiveProcessHandleCore(recordId: string): boolean {
  if (coreMirrorSlot().hasLiveProcessHandle(recordId)) return true;
  const inproc = getInprocChildByRecord(recordId);
  return inproc !== undefined && !inproc.killed;
}

/** 测试隔离：清镜像（inproc map 的清理由测试自行处理，与改线前同构）。 */
export function _resetCoreSpawnedChildrenMirrorForTest(): void {
  coreMirrorSlot().clear();
}
