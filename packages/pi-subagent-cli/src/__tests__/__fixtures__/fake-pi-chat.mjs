#!/usr/bin/env node
// fake-pi-chat.mjs — chat 域 e2e 用的长驻 fake pi rpc 子进程（PATH 注入名为 `pi` 的
// wrapper 调本文件）。与 fake-pi.mjs（一次性形态）的差异：轮次完成后【不退出】——
// agent_end + agent_settled 后长驻等后续 prompt 命令（chat 会话形态的消费面）：
//   - `pi --version` 应答版本行；
//   - get_state → 应答 sessionFile/sessionId；
//   - prompt（首轮，无 streamingBehavior）→ text_delta + message_end usage +
//     agent_end + agent_settled，长驻；
//   - prompt（续聊，带 streamingBehavior）→ 同上事件流，长驻；
//   - SIGTERM → exit 0（pi trap 语义：先 flush 后退出）。

import * as readline from "node:readline";
import * as path from "node:path";
import * as os from "node:os";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-pi-chat 0.84.4\n");
  process.exit(0);
}

const sessionDir = (() => {
  const i = process.argv.indexOf("--session-dir");
  return i >= 0 ? process.argv[i + 1] : os.tmpdir();
})();
const resumeFile = (() => {
  const i = process.argv.indexOf("--session");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
// 冷续形态沿用 resume 目标文件（断言面：--session 透传后定位不变）
const sessionFile = resumeFile ?? path.join(sessionDir, "2026-09-09T00-00-00-000Z_fake-chat-1.jsonl");

const SESSION_ID = "fake-chat-1";

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let cmd;
  try {
    cmd = JSON.parse(text);
  } catch {
    return;
  }
  if (cmd.type === "get_state") {
    write({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile, sessionId: SESSION_ID } });
    return;
  }
  if (cmd.type === "prompt") {
    const tag = cmd.streamingBehavior ?? "first";
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `chat-${tag}-answer` } });
    write({ type: "message_end", message: { usage: { input: 42, output: 21 }, stopReason: "end" } });
    write({ type: "agent_end" });
    write({ type: "agent_settled" });
    // 长驻：不退出（chat 会话形态——等后续 prompt / SIGTERM）
    return;
  }
});

// pi trap 语义：SIGTERM → 优雅退出（exit 0 口径）
process.on("SIGTERM", () => {
  process.exit(0);
});
// 兜底：120s 无事件自杀（防 e2e 挂死）
setTimeout(() => process.exit(3), 120_000).unref();
