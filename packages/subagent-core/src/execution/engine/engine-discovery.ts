// src/execution/engine/engine-discovery.ts
//
// [U7] 引擎列表状态文件同步（registry → <agentDir>/subagents/engines.json）。
//
// 为什么落文件而不是 session entry：Settings 引擎选择器在无活跃 session 时也要可开
// （冷启动/全局设置），session entry 绑定会话生命周期兜不住；engines.json 是进程外
// 可读的全局状态，extension（pi 进程）为唯一写入者，runtime RPC 读——数据所有权清晰。
//
// 动态性（用户要求）：清单来自代码注册表（registerEngine 调用点），未来新增引擎
// （AcpEngine 等）零改动出现在 GUI——本文件与前端都不枚举引擎。

import * as fs from "node:fs";
import * as path from "node:path";

import { SUBAGENTS_ENGINES_FILENAME, type SubagentEnginesFile } from "@xyz-agent/extension-protocol";

import { listEngines } from "./registry.ts";
import { writeAtomicFileSync } from "../../shared/atomic-write.ts";

/** engines.json 落盘缩进（与 subagent-core 其他 JSON store 的 JSON_INDENT 约定一致）。 */
const JSON_INDENT = 2;

/** engines.json 绝对路径（与 config.json 同目录；config.ts 的 getGlobalConfigPath 同构）。 */
export function getEnginesFilePath(agentDir: string): string {
  return path.join(agentDir, "subagents", SUBAGENTS_ENGINES_FILENAME);
}

/**
 * 把注册表引擎列表同步到 engines.json（session_start 时调用）。
 *
 * 幂等：内容与现文件一致时零写入（mtime 不动——读侧无谓失效）；写入走 tmp+rename
 * 原子替换（shared/atomic-write 统一原语，U6b 迁移——与池 config 同防线）。
 * fail-safe：任何 IO 异常吞掉（可发现性降级不阻塞
 * session 启动——GUI 兜底显示 ['pi']）。
 */
export function syncEnginesFile(agentDir: string): void {
  try {
    const filePath = getEnginesFilePath(agentDir);
    const payload: SubagentEnginesFile = { v: 1, engines: listEngines(), updatedAt: Date.now() };
    const serialized = JSON.stringify(payload, null, JSON_INDENT);
    try {
      const existing = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(existing) as Partial<SubagentEnginesFile>;
      // 引擎清单未变则跳过（updatedAt 仅诊断，不参与判变）
      if (
        Array.isArray(parsed.engines) &&
        JSON.stringify(parsed.engines) === JSON.stringify(payload.engines) &&
        parsed.v === 1
      ) {
        return;
      }
    } catch (err) {
      // 现文件缺失/损坏 → 走写入
      void err;
    }
    writeAtomicFileSync(filePath, serialized);
  } catch (err) {
    // 吞掉：见文件头 fail-safe 说明
    void err;
  }
}
