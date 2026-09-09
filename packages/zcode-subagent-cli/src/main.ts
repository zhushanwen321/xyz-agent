// src/main.ts
//
// zcode-subagent-cli 进程入口（bin/zcode-subagent-cli.mjs 直载本文件——node ≥23.6
// 原生 TS type-stripping，本仓实际运行面 node 24；仓 engines 下限 22.19 之外由
// 发现器 bin 可执行检查兜底）。
//
// 启动序：
//   1. armEngineSelfDestruct（SDK）：宿主死亡自灭守卫（主判据 stdin EOF；辅助判据
//      in-flight 反向请求计时——ack 排除面见 SDK spawn.ts）；
//   2. 构造 EngineProtocolServer（stdout 独占协议通道，一行一帧）；
//   3. configureLoggerSink：SDK logger facade 出口桥到 host/log 反向请求 + 本进程
//      stderr 兜底（反向通道未就绪/失败时日志不丢）；
//   4. stdin 行解析（NDJSON）→ server.handleFrame。
//
// 进程退出面：宿主 stdin EOF → 自灭守卫杀进程组（任务子进程同组连带收割）；正常
// dispose 不退进程（引擎进程生命周期归宿主 EngineClient / 自灭守卫）。

import * as readline from "node:readline";

import {
  armEngineSelfDestruct,
  configureLoggerSink,
  getLogger,
  type ReverseRequestClock,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineProtocolServer } from "./server.ts";

const logger = getLogger("zcode-engine-cli");

/** 坏行进日志的截断长度（够诊断、不刷屏）。 */
const INBOUND_LOG_CHARS = 200;

const clock: ReverseRequestClock = armEngineSelfDestruct({ stdin: process.stdin });

const server = new EngineProtocolServer({
  write: (frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  },
  reverseClock: clock,
});

// stdout 是协议独占通道：应用日志一律走 host/log 反向请求 + stderr 兜底，禁写 stdout。
configureLoggerSink({
  log(level, component, message, data) {
    // stderr 兜底先落（反向通道未就绪/失败时日志不丢）；host/log 为数据面反向请求
    // （10s 应答分类），失败吞掉——日志面不能拖垮主链路。
    process.stderr.write(`[${level}] [${component}] ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ""}\n`);
    void server.reverseRequest("host/log", { level, component, message }).catch(() => undefined);
  },
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  try {
    server.handleFrame(JSON.parse(text));
  } catch (err) {
    // 坏行跳过不断流（对端 EngineClient 同款纪律）；stdout 协议通道不回显坏行。
    logger.warn(`unparseable inbound protocol line (ignored): ${text.slice(0, INBOUND_LOG_CHARS)}`, {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});
rl.on("close", () => {
  // stdin EOF：自灭守卫已挂（armEngineSelfDestruct 的 once('close') 杀进程组）；
  // 此处仅留痕（守卫先注册，杀链不依赖本 handler）。
  logger.debug("stdin closed (host exit path)");
});
