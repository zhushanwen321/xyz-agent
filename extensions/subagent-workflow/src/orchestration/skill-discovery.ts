/**
 * Skill path discovery — resolve a skill name to its directory or SKILL.md path.
 *
 * Symmetric to execution/agent-registry.ts (which discovers agents): this module owns
 * the resource-discovery concern for skills across project / user / npm sources.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Skill path resolution (with npm dir cache) ─────────────────────

const skillCandidatesCache = new Map<string, string[]>();

/** List npm skill candidate paths — cached per npmSkillsDir. */
function getNpmSkillCandidates(npmSkillsDir: string): string[] {
  const cached = skillCandidatesCache.get(npmSkillsDir);
  if (cached) return cached;

  const candidates: string[] = [];
  try {
    for (const pkg of fs.readdirSync(npmSkillsDir)) {
      candidates.push(path.join(npmSkillsDir, pkg, "skills"));
    }
  } catch { /* npm dir not found — no npm skills available */ void undefined; }
  skillCandidatesCache.set(npmSkillsDir, candidates);
  return candidates;
}

/**
 * Resolve a skill name to its directory or SKILL.md path.
 * Search order:
 * 1. Project-level: .agents/skills/<name>/
 * 2. Global: <agentDir>/skills/<name>/（agentDir = getAgentDir()，实例隔离：
 *    PI_CODING_AGENT_DIR 场景读隔离目录，不碰 ~/.pi/agent）
 * 3. npm packages: <agentDir>/npm/node_modules/<pkg>/skills/<name>/
 * Returns the directory path if found, undefined otherwise.
 *
 * IF8(#14)：结果按 skillName 缓存（含未命中 undefined 也缓存，DM3）——调用点
 * agent-opts-resolver 每次 agent({skill}) call 一次，同 skill 名重复的逐候选
 * existsSync 全部消重。缓存生命周期 = session：index.ts 在 session_start 调
 * clearSkillPathCache 失效两级缓存（对齐同包 subagent-list-injector 的 session
 * 生命周期缓存模式）。不做进程级缓存的原因：pi 同一进程可能有多个 session
 * （TUI /new、/fork 同进程换 session），运行中安装的 skill（写入 project/user/npm
 * 任一源）需要对新 session 可见——进程级缓存会让曾 miss 的 skill 名（含缓存了
 * undefined 的未命中条目）在同进程后续 session 中永久不可见。session 内复用是
 * IF8/DM3 的主要收益（同一次 run 内同 skill 名重复调用消重），保持不变。
 */
const skillMemo = new Map<string, string | undefined>();

/**
 * 清空 resolveSkillPath 两级缓存（skillMemo 结果缓存 + npm 候选列表缓存）。
 * 两个消费点：测试隔离（beforeEach）与 index.ts session_start（session 生命周期
 * 失效——npm 源新装包产生的候选目录也要重新可见）。
 */
export function clearSkillPathCache(): void {
  skillMemo.clear();
  skillCandidatesCache.clear();
}

export function resolveSkillPath(skillName: string): string | undefined {
  // has 先行区分「缓存了未命中(undefined)」与「无条目」——未命中也缓存（DM3）
  if (skillMemo.has(skillName)) {
    return skillMemo.get(skillName);
  }

  const candidates = [
 // Project-level
    path.resolve(process.cwd(), ".agents/skills", skillName),
 // Global user skills
    path.join(getAgentDir(), "skills", skillName),
  ];

 // npm package skills (cached)
  const npmSkillsDir = path.join(getAgentDir(), "npm/node_modules");
  for (const pkgSkillsBase of getNpmSkillCandidates(npmSkillsDir)) {
    candidates.push(path.join(pkgSkillsBase, skillName));
  }

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      skillMemo.set(skillName, dir);
      return dir;
    }
  }

  // 未命中也缓存：防止不存在的 skill 名反复全候选 existsSync（DM3）
  skillMemo.set(skillName, undefined);
  return undefined;
}
