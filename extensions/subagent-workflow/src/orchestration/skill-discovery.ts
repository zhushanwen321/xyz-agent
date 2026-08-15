/**
 * Skill path discovery — resolve a skill name to its directory or SKILL.md path.
 *
 * Symmetric to execution/agent-registry.ts (which discovers agents): this module owns
 * the resource-discovery concern for skills across project / user / npm sources.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
 * 2. Global: ~/.pi/agent/skills/<name>/
 * 3. npm packages: ~/.pi/agent/npm/node_modules/<pkg>/skills/<name>/
 * Returns the directory path if found, undefined otherwise.
 *
 * IF8(#14)：结果按 skillName 缓存（含未命中 undefined 也缓存，DM3）——调用点
 * agent-opts-resolver 每次 agent({skill}) call 一次，同 skill 名重复的逐候选
 * existsSync 全部消重。失效语义与同文件 skillCandidatesCache 先例一致：进程
 * 生命周期内不失效（pi 进程 per-session，skill 安装发生在 session 间）。
 */
const skillMemo = new Map<string, string | undefined>();

/** 清空 resolveSkillPath 结果缓存（仅测试隔离用；生产无清理点，对齐先例）。 */
export function clearSkillPathCache(): void {
  skillMemo.clear();
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
    path.join(os.homedir(), ".pi/agent/skills", skillName),
  ];

 // npm package skills (cached)
  const npmSkillsDir = path.join(os.homedir(), ".pi/agent/npm/node_modules");
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
