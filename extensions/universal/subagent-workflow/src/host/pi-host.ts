// src/host/pi-host.ts
//
// pi 壳宿主实现（subagent-core 包抽离 u0-wire）。设计权威源：
// docs/design/subagent-core-package-extraction.md §3.3 D2（含计划期契约细化 3 条）。
//
// 本文件属壳侧（shell），不进 core 切面——对 pi SDK 与 pi 宿主协作件
// （@earendil-works/pi-coding-agent / @zhushanwen/pi-extension-logger /
// @zhushanwen/pi-pending-notifications / @xyz-agent/session-delivery）的运行时
// import 收敛在此层，core 闭包（D9 守卫对象）不得出现这些包。
//
// 端口语义：
//   - dataRoot / discoveryRoots 每次调用现取 getAgentDir()，禁止模块级缓存：
//     getAgentDir 尊重 PI_CODING_AGENT_DIR 实例隔离（xyz-agent 按 session dir
//     隔离 pi 实例），缓存会把后续切换实例的进程钉死在首个 agentDir。
//   - discoveryRoots 的根清单/顺序/source 标签与 shared/resource-discovery.ts
//     buildScanTargets、orchestration/skill-discovery.ts resolveSkillPath 的现推导
//     逐项一致（user-pi / npm / npm-dev 字面即现 ResourceSource 标签）。
//     project/workspace 根不在壳侧提供——core 消费方按 workspaceRoot 自行推导
//     （u0-data-discovery 波次接注入消费）。
//   - countActiveFromEntries 适配：pi 侧真函数返回 CountActiveResult 对象，core
//     端口契约是 number（core 消费面只读 .count，notify-ports.ts 契约注释）——
//     foundation 单元登记给本单元的适配责任。
//   - createDelivery 透传：@xyz-agent/session-delivery 的 createDelivery 与 core
//     的 Delivery* 结构化类型逐字段结构兼容（DeliveryHandle 的 sendChecked/depth
//     是结构超集成员，多不碍兼容）——结构兼容由本注入点 typecheck 守护，上游签名
//     漂移即红（notify-ports.ts「闭包红线」段）。

import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { countActiveFromEntries } from "@zhushanwen/pi-pending-notifications";
import { createDelivery } from "@xyz-agent/session-delivery";

import type { DiscoveryRoot, HostServices } from "../core/host-services.ts";
import type { LogLevel } from "../core/logger.ts";
import type { NotifyDomainPorts } from "../core/notify-ports.ts";

/** agents/workflows 共享的 agentDir 派生根（末级目录名由 kind 决定）。
 *  顺序与 source 标签逐项对齐 resource-discovery.ts buildScanTargets 的
 *  user-pi → npm → npm-dev 段（根列表按优先级低→高排列，D2 语义边界）。 */
function agentDirKindRoots(kind: "agents" | "workflows"): DiscoveryRoot[] {
  const agentDir = getAgentDir();
  return [
    // 1. user .pi/agent/<kind>/
    { dir: join(agentDir, kind), source: "user-pi" },
    // 2. npm global: agentDir/npm/node_modules/*/<pkg>/
    { dir: join(agentDir, "npm", "node_modules"), source: "npm" },
    // 3. npm dev symlink: agentDir/extensions/*/<pkg>/
    { dir: join(agentDir, "extensions"), source: "npm-dev" },
  ];
}

/** skills 的 agentDir 派生根。对齐 skill-discovery.ts resolveSkillPath 的两处
 *  推导（<agentDir>/skills + <agentDir>/npm/node_modules）——现状无 npm-dev 根，
 *  刻意不补（避免静默引入新发现源）。 */
function skillRoots(): DiscoveryRoot[] {
  const agentDir = getAgentDir();
  return [
    { dir: join(agentDir, "skills"), source: "user-pi" },
    { dir: join(agentDir, "npm", "node_modules"), source: "npm" },
  ];
}

/** pi 宿主 HostServices 实现（扩展初始化最早处经 configureCore 注入）。 */
export function createPiHostServices(): HostServices {
  return {
    // 每次现取 getAgentDir（实例隔离，见文件头）；env 覆盖段与 warn-once 留 core
    // data-dir.ts，壳只返回数据根本身（D2 计划期细化③分段归属）。
    dataRoot(): string {
      return getAgentDir();
    },

    // 桥接到 pi-extension-logger：component 即 extName（复用其 loggerCache 单例
    // 与 appendEntry/文件日志通路），按 level 分派方法，(message, data) 透传。
    log(level: LogLevel, component: string, message: string, data?: unknown): void {
      const logger = getLogger(component);
      if (level === "error") logger.error(message, data);
      else if (level === "warn") logger.warn(message, data);
      else logger.debug(message, data);
    },

    discoveryRoots(): {
      agents?: DiscoveryRoot[];
      skills?: DiscoveryRoot[];
      workflows?: DiscoveryRoot[];
    } {
      return {
        agents: agentDirKindRoots("agents"),
        skills: skillRoots(),
        workflows: agentDirKindRoots("workflows"),
      };
    },
  };
}

/** pi 侧通知域窄端口实现（configureNotifyDomain 注入）。zsw 壳不注入本端口
 *  （其完成通知走 HostServices.notify，P2 落地）。 */
export function createPiNotifyDomainPorts(): NotifyDomainPorts {
  return {
    // pi 真函数返回 CountActiveResult，core 契约只读 .count——壳侧拆数值。
    countActiveFromEntries(entries: unknown[]): number {
      return countActiveFromEntries(entries).count;
    },

    // 投递内核工厂直传本体（结构兼容论证见文件头）；不经包装避免多一层间接面。
    createDelivery,
  };
}
