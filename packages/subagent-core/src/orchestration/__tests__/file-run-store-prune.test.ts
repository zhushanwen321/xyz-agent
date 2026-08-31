// file-run-store-prune.test.ts —— FileRunStore.pruneStateFilesBeyondCap 磁盘保留测试（U7/C1/D8）。
//
// 语义对齐 pi jsonl-run-store mtime 裁剪实现（逐段平移）：mtime 升序删最旧、
// 只碰 wf-*.jsonl、旁路容错（任何失败不抛）。
//
// 覆盖（验收条款②③）：
// - 超 cap 裁剪最旧（mtime 递增序列，剩最新的 cap 个）
// - 未超 cap 不动
// - envName 语义：env 未设/非法 → no-op（默认关）；有效值 → 上限 = env 值（覆盖 max 参数）
// - 非 state 文件（不命中 glob）永不碰；目录不存在静默 no-op
//
// dataRoot 经 configureCore(tmp) 注入（对齐 file-run-store.test.ts 配置态隔离模式）。

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureCore, resetCoreForTests, type HostServices } from "../../core/host-services.ts";
import { FileRunStore } from "../file-run-store.ts";

const ENV_NAME = "XYZ_SUBAGENT_STATE_MAX_RUNS";

let dataRoot: string;
let store: FileRunStore;

beforeEach(() => {
  resetCoreForTests();
  dataRoot = mkdtempSync(join(tmpdir(), "file-run-store-prune-"));
  const host: HostServices = {
    dataRoot: () => dataRoot,
    log: () => {},
  };
  configureCore(host);
  store = new FileRunStore();
  delete process.env[ENV_NAME];
});

afterEach(() => {
  resetCoreForTests();
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env[ENV_NAME];
});

/** 往 workflow-state 目录写 state 文件并设定 mtime（秒级间距保证严格序）。 */
function writeStateFile(name: string, mtimeMs?: number): string {
  const dir = join(dataRoot, "workflow-state");
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, `{"runId":"${name}"}\n`);
  if (mtimeMs !== undefined) {
    utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  }
  return full;
}

/** 目录内文件名集合（断言终态）。 */
function listDir(): string[] {
  return readdirSync(join(dataRoot, "workflow-state")).sort();
}

/** 写 N 个 mtime 递增的 state 文件（wf-1..wf-N，mtime 间隔 1s，wf-N 最新）。 */
function writeDatedStateFiles(n: number, baseMs: number): void {
  for (let i = 1; i <= n; i++) {
    writeStateFile(`wf-${i}.jsonl`, baseMs + i * 1000);
  }
}

describe("FileRunStore.pruneStateFilesBeyondCap — max 直接裁剪", () => {
  it("超 cap：mtime 升序删最旧，剩最新的 cap 个", async () => {
    writeDatedStateFiles(5, 1_000_000);

    await store.pruneStateFilesBeyondCap(3);

    // wf-1/2 最旧先删，剩 mtime 最新的 3 个
    expect(listDir()).toEqual(["wf-3.jsonl", "wf-4.jsonl", "wf-5.jsonl"]);
  });

  it("未超 cap：目录原样不动", async () => {
    writeDatedStateFiles(3, 1_000_000);

    await store.pruneStateFilesBeyondCap(10);

    expect(listDir()).toEqual(["wf-1.jsonl", "wf-2.jsonl", "wf-3.jsonl"]);
  });

  it("恰等于 cap：no-op（边界 ≤ 判定）", async () => {
    writeDatedStateFiles(3, 1_000_000);

    await store.pruneStateFilesBeyondCap(3);

    expect(listDir()).toEqual(["wf-1.jsonl", "wf-2.jsonl", "wf-3.jsonl"]);
  });

  it("只碰命中 wf-*.jsonl glob 的文件，非 state 文件永不删", async () => {
    writeDatedStateFiles(4, 1_000_000);
    writeStateFile("readme.txt", 900_000); // 最旧但非 state 文件
    writeStateFile("other.jsonl", 950_000); // 不带 wf- 前缀

    await store.pruneStateFilesBeyondCap(2);

    // wf-1/2 被删；readme.txt 与 other.jsonl 虽更旧但不在 glob 内
    expect(listDir()).toEqual(["other.jsonl", "readme.txt", "wf-3.jsonl", "wf-4.jsonl"]);
  });

  it("目录不存在（从未持久化）：静默 no-op 不抛", async () => {
    await expect(store.pruneStateFilesBeyondCap(3)).resolves.toBeUndefined();
  });
});

describe("FileRunStore.pruneStateFilesBeyondCap — envName 语义", () => {
  it("env 未设：no-op（默认关，pi B1 opt-in 语义）", async () => {
    writeDatedStateFiles(4, 1_000_000);
    delete process.env[ENV_NAME];

    await store.pruneStateFilesBeyondCap(2, ENV_NAME);

    expect(listDir()).toEqual(["wf-1.jsonl", "wf-2.jsonl", "wf-3.jsonl", "wf-4.jsonl"]);
  });

  it("env 设有效值：上限 = env 值（覆盖 max 参数）", async () => {
    writeDatedStateFiles(5, 1_000_000);
    process.env[ENV_NAME] = "2";

    // max=4 传入但 env=2 优先 → 裁到 2
    await store.pruneStateFilesBeyondCap(4, ENV_NAME);

    expect(listDir()).toEqual(["wf-4.jsonl", "wf-5.jsonl"]);
  });

  it("env 非法值（非有限数 / 0 / 负数）：no-op（对齐 pi getEnvStateMaxRuns 解析）", async () => {
    for (const bad of ["abc", "0", "-1", ""]) {
      writeDatedStateFiles(4, 1_000_000);
      process.env[ENV_NAME] = bad;

      await store.pruneStateFilesBeyondCap(2, ENV_NAME);

      expect(listDir()).toEqual(["wf-1.jsonl", "wf-2.jsonl", "wf-3.jsonl", "wf-4.jsonl"]);
      for (const f of readdirSync(join(dataRoot, "workflow-state"))) {
        rmSync(join(dataRoot, "workflow-state", f));
      }
      delete process.env[ENV_NAME];
    }
  });

  it("envName 缺省：直接按 max 裁剪（调用方自管启用时机）", async () => {
    writeDatedStateFiles(4, 1_000_000);

    await store.pruneStateFilesBeyondCap(1);

    expect(listDir()).toEqual(["wf-4.jsonl"]);
  });
});
