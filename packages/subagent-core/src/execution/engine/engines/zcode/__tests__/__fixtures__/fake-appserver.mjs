/**
 * fake app-server（R2 连接层测试专用，绝不 spawn 真 zcode.cjs）。
 *
 * 移植改造自 zsw 仓 84b63a0^ z-subagent-workflow/fixtures/fake-appserver.js 的测试
 * 模式（该仓只读参照），vitest 子进程形态（ESM——本仓 eslint 禁 require，CJS 形态
 * 被 no-require-imports 拦截）：启动方式与真协议对齐——由被测 AppServerConnection
 * 以 `node <本文件> app-server --cwd <dir>` spawn（argv 解析后记录进流水，不消费）。
 * stdio NDJSON，帧形态对齐设计附录 A.1（无 jsonrpc 字段）。
 *
 * 测试断言面 = FAKE_STATE_FILE 事件流水（append JSONL）：
 *   boot / env / recv（收到的每个客户端帧）/ reverse-answer（反向请求收到的我方应答）
 * / unparseable-from-client。env 开关随 spawn env 固化：
 *   FAKE_STATE_FILE     流水文件路径（未设则不记流水）
 *   FAKE_STDERR=1       启动时往 stderr 写两行（tee 落盘断言取证）
 *   FAKE_EXTRA_KEYS=1   我方应答/推送帧携带未知键（客户端宽容解析断言）
 *   FAKE_PROTOCOL_PUSH=1 协议自报走 {method:'protocol'} 推送形态（缺省走 A.1 首帧
 *                        {protocol:{...}} 形态）
 *
 * 内置方法（可编程注入四帧型的全部形态）：
 *   test/echo            应答 {id, result: params}（原样回显——并发 id 关联断言依据）
 *   test/delay-echo      delayMs 后应答回显（制造在途请求）
 *   test/fail            应答 {id, error:{code,message,data}}（params 指定）
 *   test/push            先推一帧 {method: pushMethod, params: pushParams} 再应答
 *   test/reverse         发一个反向请求（method=params.reverseMethod）并等客户端
 *                        应答，流水记录后回 {id, result:{answered:true}}
 *   test/malformed-first 先写一行非 JSON 再正常应答（坏行跳过不断流断言）
 *   test/suicide         stderr 写 600 字符噪声 + 标记后 exit(1)（崩溃收割断言）
 *   session/create       真实协议语义（A.2）：先发反向请求 session/requestRuntime
 *                        Preferences 并等客户端应答（D9 常量表断言依据），流水记录
 *                        后回 {session:{sessionId}}
 *   session/close        应答 {closed:true}
 *   其余方法             应答 -32601（method not found）
 */

import fs from 'node:fs';
import readline from 'node:readline';

const STATE_FILE = process.env.FAKE_STATE_FILE;
const EXTRA_KEYS = process.env.FAKE_EXTRA_KEYS === '1';
const PROTOCOL_AS_PUSH = process.env.FAKE_PROTOCOL_PUSH === '1';

let seq = 0;
function log(ev, data = {}) {
  if (!STATE_FILE) return;
  try {
    fs.appendFileSync(STATE_FILE, JSON.stringify({ seq: ++seq, ev, ...data }) + '\n');
  } catch { /* 流水写失败不影响协议行为 */ }
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const withExtra = (frame) => (EXTRA_KEYS ? { ...frame, unknownServerKey: 'lenient' } : frame);
const reply = (id, result) => out(withExtra({ id, result }));
const replyErr = (id, code, message, data) =>
  out({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

// 协议自报（A.1：首帧 {protocol:{...}}；推送形态显式开关——两种到达形态都要被忽略）
if (PROTOCOL_AS_PUSH) out({ method: 'protocol', params: { name: 'ZCode Protocol', version: 1 } });
else out({ protocol: { name: 'ZCode Protocol', version: 1 } });

// env 快照 + boot 流水（惰性启动 / argv 形态 / env 惯例断言的数据源）
log('env', {
  pid: process.pid,
  home: process.env.HOME,
  telemetry: process.env.ZCODE_MODEL_TELEMETRY_ENABLED,
  nested: process.env.ZSW_NESTED,
  unifiedNested: process.env.XYZ_AGENT_SUBAGENT,
});
log('boot', { pid: process.pid, argv: process.argv.slice(2) });
if (process.env.FAKE_STDERR === '1') {
  process.stderr.write('fake-appserver stderr line A\nfake-appserver stderr line B\n');
}

// 反向请求记账：id -> 客户端应答到达时 resolve
let reqSeq = 0;
const pendingReverse = new Map();

function sendReverse(method, params) {
  return new Promise((resolve) => {
    const id = `srv-${++reqSeq}`;
    pendingReverse.set(id, resolve);
    out({ id, method, ...(params !== undefined ? { params } : {}) });
  });
}

function onClientAnswer(frame) {
  const settle = pendingReverse.get(frame.id);
  if (settle) {
    pendingReverse.delete(frame.id);
    settle({ id: frame.id, result: frame.result, error: frame.error });
  }
}

async function handleRequest(f) {
  const { id, method } = f;
  const params = f.params ?? {};
  switch (method) {
    case 'test/echo':
      return reply(id, params);
    case 'test/delay-echo': {
      const delay = Number(params.delayMs) || 50;
      setTimeout(() => reply(id, params), delay);
      return;
    }
    case 'test/fail':
      return replyErr(id, Number(params.code) || -32603, String(params.message || 'fake failure'), params.data);
    case 'test/push': {
      const pushMethod = String(params.pushMethod || 'test/notification');
      out(withExtra({ method: pushMethod, ...(params.pushParams !== undefined ? { params: params.pushParams } : {}) }));
      return reply(id, { pushed: true });
    }
    case 'test/reverse': {
      const answer = await sendReverse(String(params.reverseMethod || 'permission/request'), params.reverseParams);
      log('reverse-answer', { requested: params.reverseMethod, answer });
      return reply(id, { answered: true });
    }
    case 'test/malformed-first':
      process.stdout.write('this is not json {{{\n');
      return reply(id, { survived: true });
    case 'test/suicide':
      process.stderr.write('A'.repeat(600) + 'CRASH-MARK-TAIL');
      process.exit(1);
      return; // 不可达（exit 先行），保持 switch 完整
    case 'session/create': {
      const answer = await sendReverse('session/requestRuntimePreferences');
      log('reverse-answer', { requested: 'session/requestRuntimePreferences', answer });
      return reply(id, { session: { sessionId: `sess_${id}` } });
    }
    case 'session/close':
      return reply(id, { closed: true });
    default:
      return replyErr(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = String(line).trim();
  if (!text) return;
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    log('unparseable-from-client', { line: text.slice(0, 100) });
    return;
  }
  log('recv', { frame: f });
  if (f && f.id != null && typeof f.method === 'string') {
    void handleRequest(f);
    return;
  }
  if (f && f.id != null) onClientAnswer(f); // 我方反向请求的客户端应答
});
rl.on('close', () => process.exit(0));
