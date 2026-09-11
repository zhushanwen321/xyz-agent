// src/execution/engine/common/size-rotated-stream.ts
//
// 同进程 size 轮转 append 流（crash-resilience §3.3 D6-⑦：size 轮转只由 writer 进程
// 自做——跨进程 rename 会打断写方 append fd，日志进孤儿 inode、主文件不再增长、size 帽
// 失效）。当前消费方 = zcode app-server 连接的 stderr tee（connection.ts appendStderrLog），
// writer 是 runtime 进程自身，rename 安全。
//
// 轮转语义对齐 runtime infra/logger.ts rotateMain（顺序硬约束，探针实测教训）：
//   end 旧流 → 等待 'close'（fd 释放、在途 fs.write 全部落盘）→ rename .1 → 开新流 →
//   回放轮转窗口内到达的写入。rename 早于 flush 完成时，旧流在途写会落进已改名 inode，
//   而单代 .1 在下次轮转时被新 inode 覆盖路径，在途数据随之丢失。
//
// 失败语义（对齐 stderr tee 取证面契约）：绝不向上抛——同步 IO 异常置 failed，流级
// 异步错误经 'error' 监听置 failed，调用方读 failed 决定停止写入。取证面不能拖垮主通道。

import * as fs from "node:fs";
import { dirname } from "node:path";

/** 默认轮转帽（50MB）：对齐 runtime 主日志 DEFAULT_MAX_FILE_MB。stderr 是低频兜底取证面（常态零输出），帽只防极端洪泛。 */
const BYTES_PER_KB = 1024;
const DEFAULT_MAX_MB = 50;
export const DEFAULT_ROTATE_MAX_BYTES = DEFAULT_MAX_MB * BYTES_PER_KB * BYTES_PER_KB;

/** 等待旧流 'close' 的超时：fs 挂起时 close 永不触发，超时强制销毁后仍继续 rename（防轮转永久挂起）。 */
const END_AWAIT_TIMEOUT_MS = 5_000;

/** 轮转窗口 pending 容量上限（fs 挂起时轮转窗口拉长，无界入队会内存膨胀；超限丢弃并计数）。 */
const MAX_PENDING_CHUNKS = 10_000;

/**
 * 带 size 轮转的 append 写流（单代 `.1` 滚动，同 runtime logger 惯例）。
 *
 * - write：字节计数超帽 → 异步轮转（end 旧流等 close → rename → 开新流），窗口内
 *   chunk 入 pending 队列，新流就绪后按序回放——写入方同步路径零阻塞。
 * - 惰性打开：首次 write 才建流；打开前磁盘文件已超帽（跨重启遗留）先滚一次。
 * - end 后 write 为 no-op（幂等）。
 */
export class SizeRotatedAppendStream {
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;
  private _failed = false;
  private _ended = false;
  private rotationInFlight: Promise<void> | null = null;
  private pending: Array<string | Buffer> = [];
  private pendingDropped = 0;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number = DEFAULT_ROTATE_MAX_BYTES,
  ) {}

  /** 写入失败标志：同步异常或流级 'error' 置位，置位后 write 静默 no-op。 */
  get failed(): boolean {
    return this._failed;
  }

  /** 当前累计字节数（测试探针用）。 */
  get bytesWrittenCount(): number {
    return this.bytesWritten;
  }

  /** 追加一块（string 或 Buffer 均保真；Buffer 路径避免多字节字符被 chunk 边界截断）。 */
  write(chunk: string | Buffer): void {
    if (this._failed || this._ended) return;
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    try {
      // 轮转窗口内到达的写入统一入队（容量上限防 fs 挂起时无界膨胀）
      if (this.rotationInFlight !== null) {
        this.enqueue(chunk);
        return;
      }
      // size 帽判定（写入字节计数，非每块 statSync）：仅在流已打开时判定——未打开时
      // ensureOpen 内部对磁盘遗留文件做一次性超帽滚动。
      if (this.stream !== null && this.bytesWritten + size > this.maxBytes) {
        void this.rotate();
        this.enqueue(chunk);
        return;
      }
      this.ensureOpen();
      if (this.stream === null) {
        this._failed = true;
        return;
      }
      this.stream.write(chunk);
      this.bytesWritten += size;
    } catch {
      this._failed = true;
    }
  }

  /** 关闭（幂等）。轮转进行中时待新流就绪后再关（续体收尾），不阻塞调用方。 */
  end(): void {
    if (this._ended) return;
    this._ended = true;
    if (this.rotationInFlight !== null) {
      void this.rotationInFlight.then(() => {
        this.stream?.end();
      });
      return;
    }
    this.stream?.end();
  }

  private enqueue(chunk: string | Buffer): void {
    if (this.pending.length >= MAX_PENDING_CHUNKS) {
      this.pendingDropped++;
      return;
    }
    this.pending.push(chunk);
  }

  /** 惰性打开 + 打开前磁盘遗留超帽滚动。失败静默置 failed（构造器与 write 均不抛）。 */
  private ensureOpen(): void {
    if (this.stream !== null && !this.stream.destroyed) return;
    try {
      fs.mkdirSync(dirname(this.filePath), { recursive: true });
      // 进程内字节计数不覆盖历史：上次运行崩溃未轮转 / 历史大文件，打开时补一次滚动
      try {
        if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > this.maxBytes) {
          fs.renameSync(this.filePath, `${this.filePath}.1`);
        }
      // eslint-disable-next-line taste/no-silent-catch -- 打开前滚动失败（IO 错/权限）不阻塞写入，仅丢失一次滚动；best-effort 容错
      } catch {
        // 打开前滚动失败不阻塞写入（新流仍写主文件，仅丢失一次滚动）
      }
      const stream = fs.createWriteStream(this.filePath, { flags: "a" });
      stream.on("error", () => {
        this._failed = true;
      });
      this.stream = stream;
      this.bytesWritten = 0;
    } catch {
      // mkdir/createWriteStream 同步失败置 failed 由调用方停止写入（取证面不能拖垮主通道）
      this._failed = true;
    }
  }

  /**
   * 异步轮转：end 旧流并等待 'close'（在途写落盘）→ rename 单代 .1 → 开新流 → 回放队列。
   * 幂等并发：窗口内重复触发复用同一 promise（写入统一走 pending 队列）。
   */
  private rotate(): Promise<void> {
    if (this.rotationInFlight !== null) return this.rotationInFlight;
    const oldStream = this.stream;
    // 状态先行清空：窗口内到达的写入走 rotationInFlight 分支入队
    this.stream = null;
    this.bytesWritten = 0;
    this.rotationInFlight = (async () => {
      if (oldStream !== null) await this.endAndAwait(oldStream);
      try {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      // eslint-disable-next-line taste/no-silent-catch -- rename 失败（IO 错/权限）新流仍写主文件，仅丢失滚动、数据不丢；best-effort 容错
      } catch {
        // rename 失败（IO 错/权限）：新流仍写主文件，仅丢失滚动，数据不丢
      }
      this.ensureOpen();
      // 回放轮转窗口内的写入：必须**直写新流**（此刻 rotationInFlight 尚未清空，走
      // write() 会再次命中入队分支形成无限入队；对齐 runtime logger rotateMain 直写）。
      // end 后丢弃——与 end() 后 write no-op 语义一致。
      const pending = this.pending.splice(0);
      if (!this._ended && this.stream !== null) {
        for (const chunk of pending) {
          this.stream.write(chunk);
          this.bytesWritten += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        }
      }
      const dropped = this.pendingDropped;
      this.pendingDropped = 0;
      this.rotationInFlight = null;
      if (dropped > 0) {
        // 容量上限溢出的丢弃必须出声（对齐 runtime logger 合并 warn 出口）；
        // stderr 取证面无 console 出口约定，置 failed 让调用方停止写入即可
        this._failed = true;
      }
    })();
    return this.rotationInFlight;
  }

  /** end 旧流并等待真正关闭（fd 释放、缓冲 flush）；超时强制销毁降级，永不 reject。 */
  private endAndAwait(stream: fs.WriteStream): Promise<void> {
    if (stream.closed) return Promise.resolve();
    if (!stream.writableEnded) stream.end();
    if (stream.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stream.removeListener("close", onClose);
        stream.removeListener("error", onError);
        resolve();
      };
      const onClose = (): void => finish();
      const onError = (): void => {
        // error 路径（含超时前写失败）：强制销毁释放 fd，避免 close 永不到达
        stream.destroy();
        finish();
      };
      const timer = setTimeout(() => {
        stream.destroy();
        finish();
      }, END_AWAIT_TIMEOUT_MS);
      timer.unref?.();
      stream.once("close", onClose);
      stream.once("error", onError);
    });
  }
}
