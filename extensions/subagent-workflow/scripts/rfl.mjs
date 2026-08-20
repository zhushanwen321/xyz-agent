#!/usr/bin/env node
// rfl.mjs — review-fix-loop run 数据查询 CLI（tier-1 §7.4，零依赖 node 脚本）
//
// 读取 ~/.review-fix-loop/<repo-slug>/<runId>/state.json（workflow 脚本落盘），
// 派生指标现算不落盘。M0 数据结构（calls/batches[].rounds[].phaseTimings）为全集，
// M1/M2 字段（issues[].origin/dormant/scores）缺省容错显示。
//
// 用法：
//   node rfl.mjs list [repoSlug]            run 清单（runId/时间/终止原因/轮数）
//   node rfl.mjs stats <runId|latest>       单 run 全景（token/缓存/per-role/轮次时间线）
//   node rfl.mjs trends [repoSlug]          跨 run 趋势表
//   node rfl.mjs clean --older-than 30d [--yes]   清理（默认干跑）
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), ".review-fix-loop");

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function listRuns(repoSlug) {
  if (!isDir(ROOT)) return [];
  const repos = repoSlug ? [repoSlug] : readdirSync(ROOT).filter((d) => isDir(join(ROOT, d)));
  const runs = [];
  for (const repo of repos) {
    const repoDir = join(ROOT, repo);
    if (!isDir(repoDir)) continue;
    for (const runId of readdirSync(repoDir)) {
      const stateFile = join(repoDir, runId, "state.json");
      if (!existsSync(stateFile)) continue;
      try {
        runs.push({ repo, runId, state: JSON.parse(readFileSync(stateFile, "utf8")), stateFile });
      } catch { /* 损坏 state 跳过（半写入 run） */ }
    }
  }
  return runs.sort((a, b) => String(a.state?.meta?.startedAt ?? "").localeCompare(String(b.state?.meta?.startedAt ?? "")));
}

function fmtTokens(n) {
  if (n == null) return "-";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

function fmtMs(ms) {
  if (ms == null) return "-";
  if (ms >= 60_000) return Math.floor(ms / 60_000) + "m" + Math.round((ms % 60_000) / 1000) + "s";
  if (ms >= 1_000) return Math.round(ms / 1000) + "s";
  return Math.round(ms) + "ms";
}

function fmtCost(c) {
  if (c == null) return "-";
  return "$" + (c >= 0.01 ? c.toFixed(2) : c.toFixed(4));
}

/** 聚合 calls[]：token 四分量/cost/命中率/per-role。 */
function summarizeCalls(calls) {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const byRole = {};
  for (const c of calls || []) {
    const u = c.usage;
    if (u) {
      sum.input += u.input || 0;
      sum.output += u.output || 0;
      sum.cacheRead += u.cacheRead || 0;
      sum.cacheWrite += u.cacheWrite || 0;
      sum.cost += u.cost || 0;
    }
    const key = c.role || "unknown";
    byRole[key] = byRole[key] || { count: 0, input: 0, cacheRead: 0 };
    byRole[key].count++;
    byRole[key].input += (u && u.input) || 0;
    byRole[key].cacheRead += (u && u.cacheRead) || 0;
  }
  const denom = sum.input + sum.cacheRead;
  const cachePct = denom > 0 ? Math.round((sum.cacheRead / denom) * 100) : null;
  return { sum, byRole, cachePct };
}

function roundCount(state) {
  return (state.batches || []).reduce((a, b) => a + (b.rounds || []).length, 0);
}

function wallMs(state) {
  let min = null;
  let max = null;
  for (const b of state.batches || []) {
    for (const r of b.rounds || []) {
      const pt = r.phaseTimings || {};
      for (const [, pair] of Object.entries(pt)) {
        if (Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number") {
          if (min == null || pair[0] < min) min = pair[0];
          if (max == null || pair[1] > max) max = pair[1];
        }
      }
    }
  }
  return min != null && max != null ? max - min : null;
}

function cmdList(repoSlug) {
  const runs = listRuns(repoSlug);
  if (runs.length === 0) {
    console.log("no runs found" + (repoSlug ? " for repo " + repoSlug : "") + " (root: " + ROOT + ")");
    return 0;
  }
  for (const r of runs) {
    const started = (r.state.meta && r.state.meta.startedAt) || "?";
    const term = (r.state.meta && r.state.meta.terminated) || "?";
    console.log(
      r.runId.padEnd(28) + "  " + String(started).padEnd(25) +
      "  " + String(term).padEnd(18) +
      "  rounds: " + roundCount(r.state) +
      (r.state.calls ? "  calls: " + r.state.calls.length : ""),
    );
  }
  return 0;
}

function cmdStats(runIdOrLatest, repoSlug) {
  const runs = listRuns(repoSlug);
  if (runs.length === 0) { console.log("no runs found (root: " + ROOT + ")"); return 1; }
  const run = runIdOrLatest === "latest" ? runs[runs.length - 1] : runs.find((r) => r.runId === runIdOrLatest);
  if (!run) { console.log("run not found: " + runIdOrLatest); return 1; }
  const s = run.state;
  const { sum, byRole, cachePct } = summarizeCalls(s.calls);
  console.log("run " + run.runId + " (repo: " + run.repo + ")");
  console.log("  terminated: " + ((s.meta && s.meta.terminated) || "?") + "  rounds: " + roundCount(s) + "  started: " + (s.meta && s.meta.startedAt));
  console.log(
    "  tokens: input " + fmtTokens(sum.input) +
    " (cacheRead " + (cachePct == null ? "-" : cachePct + "%") + ")" +
    "  output " + fmtTokens(sum.output) +
    "  cost " + fmtCost(sum.cost) +
    "  wall " + fmtMs(wallMs(s)),
  );
  const roleParts = Object.entries(byRole).map(([role, v]) =>
    role + " ×" + v.count + " " + fmtTokens(v.input + v.cacheRead));
  console.log("  per-role: " + (roleParts.join(" │ ") || "(no calls)"));
  // issues 概览（M1 origin/dormant 字段缺省容错）
  const issues = s.issues ? Object.values(s.issues) : [];
  const fixed = issues.filter((i) => i.status === "fixed").length;
  const regressed = issues.filter((i) => (i.history || []).some((h) => h.status === "regressed")).length;
  const origins = {};
  for (const i of issues) origins[i.origin || "-"] = (origins[i.origin || "-"] || 0) + 1;
  console.log("  issues: total " + issues.length + " → fixed " + fixed +
    "  regressed-ever " + regressed +
    "  origins " + (issues.length ? Object.entries(origins).map(([k, v]) => k + " " + v).join("/") : "-") +
    "  dormant " + ((s.dormant || []).length));
  // scores 表（M2 字段缺省容错）
  if (Array.isArray(s.scores) && s.scores.length > 0) {
    for (const sc of s.scores) {
      const dims = sc.dimensions ? Object.entries(sc.dimensions).map(([k, v]) => k + " " + v).join(" ") : "";
      console.log("  score R" + (sc.round ?? "?") + " " + (sc.targetKind || "?") + "/" + (sc.targetName || "?") +
        ": " + (sc.total != null ? sc.total + "/10" : "(no total)") + "  [" + dims + "]");
    }
  } else {
    console.log("  scores: (none)");
  }
  // 轮次时间线
  for (const b of s.batches || []) {
    for (const r of b.rounds || []) {
      const pt = r.phaseTimings || {};
      const seg = (k) => (Array.isArray(pt[k]) ? k + " " + fmtMs(pt[k][1] - pt[k][0]) : k + " -");
      console.log("  R" + r.round + " (batch " + b.index + "): " + seg("review") + " │ " + seg("aggregate") + " │ " + seg("fix") +
        "  mustFix " + (r.mustFix ?? "-"));
    }
  }
  return 0;
}

function cmdTrends(repoSlug) {
  const runs = listRuns(repoSlug);
  if (runs.length === 0) { console.log("no runs found (root: " + ROOT + ")"); return 0; }
  const header = "runId".padEnd(28) + "  " + "started".padEnd(20) + "  " + "rounds".padEnd(6) + "  " + "tokens".padEnd(8) + "  " + "cache%".padEnd(6) + "  " + "regressed";
  console.log(header);
  for (const r of runs) {
    const { sum, cachePct } = summarizeCalls(r.state.calls);
    const issues = r.state.issues ? Object.values(r.state.issues) : [];
    const regressed = issues.filter((i) => (i.history || []).some((h) => h.status === "regressed")).length;
    console.log(
      r.runId.padEnd(28) + "  " + String((r.state.meta && r.state.meta.startedAt) || "?").padEnd(20) + "  " +
      String(roundCount(r.state)).padEnd(6) + "  " +
      fmtTokens(sum.input + sum.cacheRead + sum.output).padEnd(8) + "  " +
      String(cachePct == null ? "-" : cachePct + "%").padEnd(6) + "  " + regressed,
    );
  }
  return 0;
}

function parseOlderThan(spec) {
  const m = /^(\d+)([dh])$/.exec(String(spec || ""));
  if (!m) return null;
  return Date.now() - parseInt(m[1], 10) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

function cmdClean(spec, yes) {
  const cutoff = parseOlderThan(spec);
  if (cutoff == null) {
    console.log("invalid --older-than (expect <N>d or <N>h, e.g. 30d)");
    return 1;
  }
  const runs = listRuns();
  const expired = runs.filter((r) => {
    const t = r.stateFile ? statSync(r.stateFile).mtimeMs : 0;
    const started = r.state.meta && r.state.meta.startedAt ? Date.parse(r.state.meta.startedAt) : NaN;
    const basis = Number.isFinite(started) ? started : t;
    return basis < cutoff;
  });
  if (expired.length === 0) { console.log("nothing older than " + spec); return 0; }
  for (const r of expired) {
    const dir = join(ROOT, r.repo, r.runId);
    if (yes) {
      rmSync(dir, { recursive: true, force: true });
      console.log("deleted " + dir);
    } else {
      console.log("would delete " + dir + " (dry-run; add --yes to execute)");
    }
  }
  return 0;
}

// ── main ──────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "list": process.exit(cmdList(rest[0])); break;
    case "stats": {
      if (!rest[0]) { console.log("usage: rfl stats <runId|latest> [repoSlug]"); process.exit(1); }
      process.exit(cmdStats(rest[0], rest[1]));
      break;
    }
    case "trends": process.exit(cmdTrends(rest[0])); break;
    case "clean": {
      const oi = rest.indexOf("--older-than");
      const spec = oi >= 0 ? rest[oi + 1] : null;
      if (!spec) { console.log("usage: rfl clean --older-than <N>d [--yes]"); process.exit(1); }
      process.exit(cmdClean(spec, rest.includes("--yes")));
      break;
    }
    default:
      console.log("usage: rfl <list|stats|trends|clean> ...\n  list [repoSlug]\n  stats <runId|latest> [repoSlug]\n  trends [repoSlug]\n  clean --older-than 30d [--yes]");
      process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error("rfl: " + (err && err.message ? err.message : String(err)));
  process.exit(2);
}
