/**
 * A7: rfl.mjs CLI smoke（rfl 仪表 T4，tier-1 §7.4）。
 *
 * node 子进程执行 scripts/rfl.mjs，HOME 指向临时目录 + 预置 fixture state.json：
 *   - list：列出两 run（runId/时间/terminated/轮数）
 *   - stats latest：token 汇总 + 缓存命中率 + per-role + 轮次时间线
 *   - trends：跨 run 行
 *   - clean --older-than：默认干跑不删；--yes 删过期保留新 run
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RFL_PATH = join(__dirname, "..", "..", "scripts", "rfl.mjs");
const run = promisify(execFile);

function fixtureState(opts: {
  startedAt: string;
  terminated: string;
  calls: Array<{ batch: number; round: number; role: string; name: string; usage?: Record<string, number> }>;
  rounds?: Array<{ round: number; phaseTimings: Record<string, [number, number] | null> }>;
}): Record<string, unknown> {
  return {
    meta: { runId: "x", startedAt: opts.startedAt, terminated: opts.terminated, baseHash: "" },
    calls: opts.calls.map((c) => ({
      batch: c.batch, round: c.round, role: c.role, name: c.name,
      model: "m", durationMs: 100, usage: c.usage ?? { input: 100, output: 10, cacheRead: 300, cacheWrite: 0, cost: 0.01 },
      promptMode: "full", promptBytes: 500, sessionId: "s1",
    })),
    batches: [{ index: 1, name: "batch-1", rounds: opts.rounds ?? [{ round: 1, mustFix: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } }] }],
    issues: {},
    fixResults: [],
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rfl-cli-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeRun(repoSlug: string, runId: string, state: Record<string, unknown>): string {
  const dir = join(home, ".review-fix-loop", repoSlug, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf8");
  return dir;
}

async function rfl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [RFL_PATH, ...args], { env: { ...process.env, HOME: home } });
}

describe("A7 rfl CLI（list/stats/trends/clean）", () => {
  it("A7 list：列出两 run 的 runId/terminated/rounds", async () => {
    writeRun("repo-a", "wf-old-1", fixtureState({
      startedAt: "2026-07-01T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r1" }],
    }));
    writeRun("repo-a", "wf-new-2", fixtureState({
      startedAt: "2026-08-15T10:00:00.000Z", terminated: "stuck",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r1" }, { batch: 1, round: 1, role: "aggregator", name: "aggregate" }],
      rounds: [
        { round: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } },
        { round: 2, phaseTimings: { review: [5, 6], aggregate: [6, 7], fix: null } },
      ],
    }));
    const { stdout } = await rfl(["list", "repo-a"]);
    expect(stdout).toContain("wf-old-1");
    expect(stdout).toContain("wf-new-2");
    expect(stdout).toContain("clean");
    expect(stdout).toContain("stuck");
    // rounds 计数来自 batches[].rounds
    expect(stdout).toMatch(/wf-new-2.*rounds: 2/);
  });

  it("A7 stats latest：token 汇总 + 缓存命中率 + per-role + 轮次时间线 + phaseTimings 派生", async () => {
    writeRun("repo-b", "wf-stats-1", fixtureState({
      startedAt: "2026-08-15T10:00:00.000Z", terminated: "clean",
      calls: [
        { batch: 1, round: 1, role: "reviewer", name: "reviewer-a", usage: { input: 1000, output: 100, cacheRead: 3000, cacheWrite: 0, cost: 0.05 } },
        { batch: 1, round: 1, role: "aggregator", name: "aggregate", usage: { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, cost: 0.01 } },
        { batch: 1, round: 1, role: "fixer", name: "fix", usage: { input: 500, output: 200, cacheRead: 1200, cacheWrite: 0, cost: 0.02 } },
      ],
      rounds: [{ round: 1, phaseTimings: { review: [1000, 61000], aggregate: [61000, 91000], fix: [91000, 151000] } }],
    }));
    const { stdout } = await rfl(["stats", "latest", "repo-b"]);
    expect(stdout).toContain("wf-stats-1");
    expect(stdout).toContain("repo-b");
    // 汇总：input 1700 → 2k 级；cacheRead 5000 / (1700+5000) = 75%
    expect(stdout).toContain("75%");
    expect(stdout).toContain("reviewer ×1");
    expect(stdout).toContain("aggregator ×1");
    expect(stdout).toContain("fixer ×1");
    // 轮次时间线（phaseTimings 派生：60s/30s/60s）
    expect(stdout).toContain("R1 (batch 1)");
    expect(stdout).toContain("review 1m0s");
    expect(stdout).toContain("aggregate 30s");
    expect(stdout).toContain("fix 1m0s");
  });

  it("A7 trends：跨 run 行含轮数与缓存命中率", async () => {
    writeRun("repo-c", "wf-t1", fixtureState({
      startedAt: "2026-08-14T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 100, output: 10, cacheRead: 300, cacheWrite: 0, cost: 0 } }],
    }));
    writeRun("repo-c", "wf-t2", fixtureState({
      startedAt: "2026-08-15T10:00:00.000Z", terminated: "converged",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r", usage: { input: 100, output: 10, cacheRead: 100, cacheWrite: 0, cost: 0 } }],
      rounds: [
        { round: 1, phaseTimings: { review: [1, 2], aggregate: [2, 3], fix: [3, 4] } },
        { round: 2, phaseTimings: { review: [5, 6], aggregate: [6, 7], fix: [7, 8] } },
      ],
    }));
    const { stdout } = await rfl(["trends", "repo-c"]);
    expect(stdout).toContain("wf-t1");
    expect(stdout).toContain("wf-t2");
    // cache% 列：t1 = 300/400 = 75%；t2 = 100/200 = 50%
    expect(stdout).toContain("75%");
    expect(stdout).toContain("50%");
  });

  it("A7 clean：默认干跑不删；--yes 删过期保留新 run", async () => {
    const oldDir = writeRun("repo-d", "wf-old", fixtureState({
      startedAt: "2026-06-01T10:00:00.000Z", terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
    }));
    const newDir = writeRun("repo-d", "wf-new", fixtureState({
      startedAt: new Date().toISOString(), terminated: "clean",
      calls: [{ batch: 1, round: 1, role: "reviewer", name: "r" }],
    }));
    // 干跑：两个目录都在
    const dry = await rfl(["clean", "--older-than", "30d"]);
    expect(dry.stdout).toContain("would delete");
    expect(dry.stdout).toContain("wf-old");
    expect(existsSync(join(oldDir, "state.json"))).toBe(true);

    // --yes：old 删除、new 保留
    const del = await rfl(["clean", "--older-than", "30d", "--yes"]);
    expect(del.stdout).toContain("deleted");
    expect(existsSync(join(oldDir, "state.json"))).toBe(false);
    expect(existsSync(join(newDir, "state.json"))).toBe(true);
  });

  it("A7 stats：无字段容错（M1/M2 的 origin/dormant/scores 缺省显示不崩）", async () => {
    const dir = writeRun("repo-e", "wf-bare", {
      meta: { runId: "x", startedAt: "2026-08-15T10:00:00.000Z" },
      batches: [],
    });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    const { stdout } = await rfl(["stats", "latest", "repo-e"]);
    expect(stdout).toContain("wf-bare");
    expect(stdout).toContain("dormant 0");
  });
});
