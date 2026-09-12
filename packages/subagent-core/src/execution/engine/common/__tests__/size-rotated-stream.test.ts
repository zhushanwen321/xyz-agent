// src/execution/engine/common/__tests__/size-rotated-stream.test.ts
//
// SizeRotatedAppendStream 单测（crash-resilience §3.3 D6-⑦：zcode-appserver-stderr.log
// 的 runtime 侧 size 自轮转——writer 进程自做 rename，A9②「轮转不打断写方」的单元半边）。
//
// 锁定：
// - 帽内直写主文件（不轮转）；超帽异步轮转（end 旧流 → close → rename .1 → 新流回放）
// - 轮转后写入继续落主文件（无孤儿 inode——旧流 close 后才 rename 的顺序硬约束）
// - 打开时磁盘遗留超帽文件先滚一次（跨重启 size 上限弥合，对齐 runtime logger）
// - 失败语义：end 后 write no-op；不向上抛
//
// fs 目标全部 mkdtemp(tmpdir) 自建自删（仓规测试红线）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SizeRotatedAppendStream, DEFAULT_ROTATE_MAX_BYTES } from "../size-rotated-stream.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "size-rotated-stream-test-"));
});

afterEach(() => {
  // tmpdir 白名单内的自建目录，测试自清理；残留由 os.tmpdir 系统回收兜底
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    // 清理失败不影响断言
  }
});

/** 让事件循环转一圈：WriteStream 异步 fd open / flush 在 tick 间完成。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 轮询等待条件成立（WriteStream 的 open/write/flush 是多阶段异步链，固定 tick 数
 * 在不同机器负载下不稳定；对齐仓内 relay 测试的 waitFor 惯例，5s 预算）。
 */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 5_000) throw new Error(`timeout waiting for ${what}`);
    await tick();
  }
}

/** 等文件存在且内容包含期望片段（轮询等 WriteStream 缓冲 flush，不依赖时序）。 */
async function waitForContent(file: string, expected: string): Promise<void> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes(expected), `content of ${file}`);
}

describe("SizeRotatedAppendStream（D6-⑦ stderr 取证面 size 自轮转）", () => {
  it("帽内写入不轮转：单文件、内容完整", async () => {
    const file = join(dir, "zcode-appserver-stderr.log");
    const s = new SizeRotatedAppendStream(file, 1024);
    s.write("chunk-1\n");
    s.write("chunk-2\n");
    await waitForContent(file, "chunk-2\n");
    s.end();
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("chunk-1\nchunk-2\n");
  });

  it("超帽轮转：rename 单代 .1，轮转后新写入落主文件（写方不被打断）", async () => {
    const file = join(dir, "zcode-appserver-stderr.log");
    const s = new SizeRotatedAppendStream(file, 32);
    s.write("A".repeat(24) + "\n"); // 25B < 32，直写
    await waitForContent(file, "A");
    s.write("B".repeat(40) + "\n"); // 25+41 > 32 → 触发轮转，本块入队
    s.write("C".repeat(8) + "\n"); // 轮转窗口内到达，入队回放
    // 等轮转链完成：end 旧流 close → rename → 开新流 → 回放
    await waitFor(() => existsSync(`${file}.1`), "rotated .1 file");
    // 旧段内容 = A 块（rename 前已 flush，无在途写孤儿化）
    expect(readFileSync(`${file}.1`, "utf8")).toBe("A".repeat(24) + "\n");
    // 新段：B、C 都落主文件（回放按序，无丢失）
    await waitForContent(file, "C".repeat(8));
    const main = readFileSync(file, "utf8");
    expect(main).toContain("B".repeat(40));
    expect(main).toContain("C".repeat(8));
    // 后续写入继续落主文件（append fd 指向新 inode，非已改名孤儿）
    s.write("D-after-rotation\n");
    await waitForContent(file, "D-after-rotation");
    s.end();
  });

  it("打开时磁盘遗留超帽文件先滚一次（跨重启 size 上限弥合）", async () => {
    const file = join(dir, "zcode-appserver-stderr.log");
    writeFileSync(file, "legacy".repeat(20)); // 120B > 32B 帽
    const s = new SizeRotatedAppendStream(file, 32);
    s.write("fresh\n");
    await waitFor(() => existsSync(`${file}.1`), "rotated .1 file");
    expect(readFileSync(`${file}.1`, "utf8")).toBe("legacy".repeat(20));
    await waitForContent(file, "fresh\n");
    expect(readFileSync(file, "utf8")).toBe("fresh\n");
    s.end();
  });

  it("end 后 write 为 no-op（幂等，不追加）", async () => {
    const file = join(dir, "zcode-appserver-stderr.log");
    const s = new SizeRotatedAppendStream(file, 1024);
    s.write("before-end\n");
    await waitForContent(file, "before-end\n");
    s.end();
    s.end(); // 二次 end 幂等
    s.write("after-end\n");
    await tick();
    await tick();
    expect(readFileSync(file, "utf8")).toBe("before-end\n");
  });

  it("默认帽 50MB（对齐 runtime 主日志 DEFAULT_MAX_FILE_MB）", () => {
    expect(DEFAULT_ROTATE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it("多目录嵌套自动创建（mkdtemp 子目录路径惰性建父目录）", async () => {
    const nested = join(dir, "engines", "zcode", "shared");
    const file = join(nested, "zcode-appserver-stderr.log");
    const s = new SizeRotatedAppendStream(file, 1024);
    s.write("nested\n");
    await waitForContent(file, "nested\n");
    s.end();
    expect(statSync(file).size).toBeGreaterThan(0);
  });

  it("打开失败（父路径被文件占用，mkdir ENOTDIR）→ failed 置位、后续 write 静默 no-op、不向上抛", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const s = new SizeRotatedAppendStream(join(blocker, "nested", "stderr.log"), 1024);
    expect(() => s.write("chunk\n")).not.toThrow();
    expect(s.failed).toBe(true);
    expect(s.bytesWrittenCount).toBe(0);
    s.write("after-fail\n"); // failed 短路：静默 no-op（调用方读 failed 决定停止写入）
    s.end();
  });

  it("轮转 rename 失败降级（.1 被目录占位）：新流续写主文件，数据不丢仅丢滚动、不置 failed", async () => {
    const file = join(dir, "zcode-appserver-stderr.log");
    mkdirSync(`${file}.1`); // 占位 .1 → rotate 的 renameSync(file, file.1) EISDIR 失败
    const s = new SizeRotatedAppendStream(file, 32);
    s.write("A".repeat(24) + "\n");
    await waitForContent(file, "A");
    s.write("B".repeat(40) + "\n"); // 25+41 > 32 → 触发轮转；rename 失败 → catch 后新流续写主文件
    await waitForContent(file, "B");
    expect(s.failed).toBe(false); // rename 失败仅丢失滚动，数据不丢，不置 failed
    expect(readFileSync(file, "utf8")).toBe("A".repeat(24) + "\n" + "B".repeat(40) + "\n");
    expect(statSync(`${file}.1`).isDirectory()).toBe(true); // 目录占位未被覆盖
    s.end();
  });
});
