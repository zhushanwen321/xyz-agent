#!/usr/bin/env node
/**
 * render-constraints.mjs — 从 docs/constraints.json（SSOT）生成 docs/constraints.md（人读视图）
 *
 * 用法：
 *   node scripts/render-constraints.mjs          # 结构校验 + 生成/覆写 docs/constraints.md
 *   node scripts/render-constraints.mjs --check  # 结构校验 + 比对 md 是否与 json 同步（pre-commit 用）
 *
 * 结构校验（两种模式都跑，约束登记自身的护栏）：
 *   - id 唯一且格式 C-<topic>-<两位序号>
 *   - scope 非空：["global"] 或路径 glob（<prefix>/** 或精确路径）
 *   - authority 非空且文件存在（剥离 #锚点后按相对 docs/ 解析，../ 前缀相对仓库根）
 *   - enforcement：machine 项 hook 须存在于 .githooks/ / scripts/ / 仓库根（含 "§" 的内联段特例跳过）；
 *     review 项 agent 须存在于 .agents/skills/pr-cr-fix/agents/<agent>.md
 *
 * 退出码：0 成功 / 2 校验失败或（--check 模式）md 与 json 不同步
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const JSON_PATH = join(DOCS_DIR, "constraints.json");
const MD_PATH = join(DOCS_DIR, "constraints.md");

const TOPIC_NAMES = {
  pi: "pi 关系（外部依赖边界）",
  data: "数据治理（单一数据拥有者体系）",
  comm: "进程与通信架构",
  state: "renderer 状态与包拓扑",
  ext: "extension 体系",
  build: "打包与分发",
  proc: "工程流程",
  sw: "subagent-workflow（单写者不变量）",
};

const errors = [];
function fail(msg) {
  errors.push(msg);
}

// ---------- 结构校验 ----------

function validateHookExists(hook) {
  if (hook.includes("§")) return true; // install-hooks.sh §2c 类内联段，无独立脚本
  return (
    existsSync(join(REPO_ROOT, ".githooks", hook)) ||
    existsSync(join(REPO_ROOT, "scripts", hook)) ||
    existsSync(join(REPO_ROOT, hook))
  );
}

function validateAuthorityPath(ref) {
  const path = ref.split("#")[0];
  if (!path) return true; // 纯锚点不查
  const abs = path.startsWith("../") ? join(REPO_ROOT, path.slice(3)) : join(DOCS_DIR, path);
  if (!existsSync(abs)) fail(`authority 文件不存在: ${ref}`);
}

function validate(data) {
  const constraints = data.constraints;
  if (!Array.isArray(constraints) || constraints.length === 0) fail("constraints 为空数组");

  const seenIds = new Set();
  const idRe = /^C-(pi|data|comm|state|ext|build|proc|sw)-\d{2}$/;
  for (const c of constraints) {
    const at = c.id || "(missing id)";
    if (!c.id || !idRe.test(c.id)) fail(`id 格式非法: ${at}`);
    if (seenIds.has(c.id)) fail(`id 重复: ${c.id}`);
    seenIds.add(c.id);

    if (!Array.isArray(c.scope) || c.scope.length === 0) fail(`${at}: scope 为空`);
    else
      for (const s of c.scope) {
        if (s === "global") continue;
        if (!/^[\w./-]+(\/\*\*)?$/.test(s)) fail(`${at}: scope 非法 glob "${s}"（只支持 <prefix>/** 或精确路径）`);
      }

    if (!Array.isArray(c.authority) || c.authority.length === 0) fail(`${at}: authority 为空`);
    else for (const a of c.authority) validateAuthorityPath(a);

    if (!Array.isArray(c.enforcement) || c.enforcement.length === 0) fail(`${at}: enforcement 为空`);
    else
      for (const e of c.enforcement) {
        if (e.type === "machine") {
          if (!e.hook) fail(`${at}: machine enforcement 缺 hook`);
          else if (!validateHookExists(e.hook)) fail(`${at}: hook 不存在于 .githooks/ / scripts/ / 根: ${e.hook}`);
        } else if (e.type === "review") {
          if (!e.agent) fail(`${at}: review enforcement 缺 agent`);
          else if (!existsSync(join(REPO_ROOT, ".agents/skills/pr-cr-fix/agents", `${e.agent}.md`)))
            fail(`${at}: review agent 不存在: ${e.agent}`);
        } else if (e.type !== "none") {
          fail(`${at}: enforcement.type 非法: ${e.type}`);
        }
      }

    if (c.dimensions !== undefined && !Array.isArray(c.dimensions)) fail(`${at}: dimensions 须为数组`);
  }
}

// ---------- markdown 生成 ----------

function mdEscape(s) {
  return s.replaceAll("|", "\\|");
}

function linkFor(ref) {
  const path = ref.split("#")[0];
  const label = path === "../AGENTS.md" ? "AGENTS.md" : path.replace(/\.md$/, "").split("/").pop();
  const anchor = ref.includes("#") ? `#${ref.split("#")[1]}` : "";
  // md 位于 docs/ 下；ref 已相对 docs/（或 ../ 相对仓库根），直接可用
  return `[${label}](${path}${anchor})`;
}

function renderEnforcement(enforcement) {
  const parts = enforcement.map((e) => {
    if (e.type === "machine") return `hook: \`${e.hook}\``;
    if (e.type === "review") return `review: ${e.agent}`;
    return "—";
  });
  return parts.join(" + ") || "—";
}

function render(data) {
  const lines = [];
  lines.push("# xyz-agent 架构约束登记表（人读视图）");
  lines.push("");
  lines.push("> **机器权威 = [constraints.json](./constraints.json)**，本文件由 `node scripts/render-constraints.mjs` 生成，**勿手改**——改约束请改 json 后重跑渲染。");
  lines.push("> 「约束（摘要）」列仅导航，非权威表述；约束内容的唯一权威源 = 「权威源」列指向的文档。");
  lines.push("> scope 为 `global` 的条目每次 CR 必载；其余按改动路径前缀命中（`node scripts/select-constraints.mjs --base main`）。");
  lines.push("");
  lines.push(`共 ${data.constraints.length} 条（生成于 ${new Date().toISOString().slice(0, 10)}）。`);
  lines.push("");

  const byTopic = new Map();
  for (const c of data.constraints) {
    const topic = c.id.split("-")[1];
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(c);
  }

  for (const [topic, list] of byTopic) {
    lines.push(`## ${TOPIC_NAMES[topic] || topic}`);
    lines.push("");
    lines.push("| ID | 约束（摘要） | scope | 权威源 | 执行 |");
    lines.push("|---|---|---|---|---|");
    for (const c of list) {
      lines.push(
        `| ${c.id} | ${mdEscape(c.summary)} | ${mdEscape(c.scope.join("、"))} | ${c.authority.map(linkFor).join(" · ")} | ${renderEnforcement(c.enforcement)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------- main ----------

const checkMode = process.argv.includes("--check");
const data = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
validate(data);

if (errors.length > 0) {
  console.error(`[render-constraints] 结构校验失败（${errors.length} 处）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(2);
}

const rendered = render(data) + "\n";
if (checkMode) {
  if (!existsSync(MD_PATH)) {
    console.error("[render-constraints] docs/constraints.md 不存在，先运行 node scripts/render-constraints.mjs 生成");
    process.exit(2);
  }
  const current = readFileSync(MD_PATH, "utf-8");
  if (current !== rendered) {
    console.error("[render-constraints] docs/constraints.md 与 constraints.json 不同步——请运行 node scripts/render-constraints.mjs 后重新提交");
    process.exit(2);
  }
  console.log(`[render-constraints] OK：${data.constraints.length} 条约束，结构校验通过，md 同步`);
} else {
  writeFileSync(MD_PATH, rendered);
  console.log(`[render-constraints] 已生成 ${MD_PATH}（${data.constraints.length} 条）`);
}
