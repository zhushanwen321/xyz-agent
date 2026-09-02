// pr-lifecycle — PR 全生命周期 workflow 入口（zsw 1.2.0 core 契约）
//
// 设计：docs/design/pr-lifecycle-workflow.md；实施计划：docs/design/pr-lifecycle-workflow.impl-plan.md
// 结构：本入口只做 io 适配层组装（引擎注入 → 纯逻辑库），全部状态机/守卫/walker
// 在 ./pr-lifecycle/lib.cjs（依赖注入，node 直测：test/run-tests.js）。
// 单元进度：u1 状态核心与骨架——steps 注册表为空数组（u2-u5 填充 PR 阶段 /
// 门禁 / cr-fix / simplify steps），空注册表跑完 = 幂等返回 state 现状。
//
// 恢复通道：终态 scriptResult 必含 runId；暴毙时 cat .review/pr-workflow/latest。

/* @pi-meta
name: pr-lifecycle
description: >-
  PR 全生命周期单脚本编排：开 PR、静态与覆盖率与度量门禁、review-fix 循环、code-simplify 到待 push 终态，任意环节失败后带 runId 重新发起即从断点续跑
when: 需要执行 pr-cr-fix 全流程（从开 PR 到终局门禁、最终 push 之前）时
notFor: 只做最终 push、单跑某道门禁、或 merge 与 release 流程时
phases: []
parameters:
  type: object
  properties:
    runId: { type: string, description: 断点恢复键；缺失 = 从头执行，存在 = 从未完成的第一个 step 续跑 }
    base: { type: string, default: main, description: PR 目标基线分支，全流程 review 与 diff 口径锁定为发起时该 ref 指向的 commit }
    reviewers: { type: array, items: { type: string }, description: cr-fix 审查维度裁剪（默认全量 8 维）；值为 agent 名或路径关键词 }
    maxRounds: { type: integer, default: 10, minimum: 1, description: cr-fix 循环轮次上限透传给嵌套 loop }
    simplifyMode: { type: string, enum: [apply, report], default: apply, description: apply = 自动落地高置信 A 档简化并独立 commit；report = 只出报告不改码 }
    skipSteps: { type: array, items: { type: string }, default: [], description: 人工接管逃生舱——列出未完成 step 标记为用户确认跳过，终态逐项披露 }
    allowExternalChanges: { type: boolean, default: false, description: resume 时 HEAD 存在非本 run 产生的外部 commit 时显式放行重跑检查 }
usage: |
  ## 发起（主 agent 一次调用；workdir 传 repo 绝对路径）
  zsw workflow --workflow pr-lifecycle --workdir <repo 绝对路径> --timeout-ms 21600000
  ## 断点恢复
  带 runId=<state 里或 .review/pr-workflow/latest 的 prw-* id> 重新发起同一 workflow
  ## 终态
  awaiting-push（待用户授权 push）/ failed（error 含 resumeCommand，可直接复制执行）
*/

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// 入口脚本被引擎内联执行（__dirname 无效），lib 锚定 workerData.scriptPath（入口绝对路径）。
// lib 位于入口同级的 pr-lifecycle/ 子目录（impl-plan 偏差 1：子目录不进 workflow 顶层 *.js 扫描）
const libDir = path.join(path.dirname(workerData.scriptPath), 'pr-lifecycle');
const lib = require(path.join(libDir, 'lib.cjs'));

// 假设（u2 preflight 验证兜底）：worker 进程 cwd 即发起方传入的 workdir；
// $WORKSPACE 是宿主 cwd 不是 workdir，不能用作 repoRoot。
const repoRoot = process.cwd();

const engineStateDir = path.join(os.homedir(), '.zcode', 'zsw', 'workflow-state');

// 活性守卫主通道：读引擎 run state 文件末行 state.status（P5 实证 JSONL 形态）。
// 未知/缺失状态值返回 ok:false 由 lib 按 fail-closed 处理（降级 pid 探测）。
function readEngineState(engineRunId) {
  if (!engineRunId) return { ok: false, reason: 'no engineRunId' };
  const file = path.join(engineStateDir, `${engineRunId}.jsonl`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const lastLine = raw.trim().split('\n').pop() || '';
    const entry = JSON.parse(lastLine);
    const lastStatus = entry && entry.state && entry.state.status;
    if (typeof lastStatus === 'string') return { ok: true, status: lastStatus };
    return { ok: false, reason: `last line has no state.status (${file})` };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// 降级通道：信号 0 探测（不杀进程）；EPERM 等异常按存活处理（fail-closed）
function probePid(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    return e && e.code === 'ESRCH' ? 'dead' : 'alive';
  }
}

// agent 适配层：强制 returnMeta:true（引擎 agent 失败不 reject，错误只能经 meta
// 观测）；u1 骨架尚无调用方（u2 引入 steps 后经 ctx.io.agent 使用）。
async function agentAdapter(params) {
  const meta = await agent({
    description: params.description || 'pr-lifecycle-agent',
    ...params,
    returnMeta: true,
  });
  const err = meta && meta.error;
  if (err) {
    log(`[agent] 调用失败（${params.description || 'unnamed'}）：${err}`);
  }
  return { value: meta && meta.value, error: err || null, meta: meta || null };
}

// 嵌套 workflow 适配层（u4 cr-fix 使用；引擎契约：返回 {content, parsedOutput}）
async function workflowAdapter(name, params) {
  return workflow(name, params);
}

function log(...msg) {
  console.error('[pr-lifecycle]', ...msg);
}

const io = {
  args: (typeof $ARGS === 'object' && $ARGS !== null) ? $ARGS : {},
  repoRoot,
  pid: process.pid,
  fs,
  sh: lib.createSh({ execFileSync, defaultCwd: repoRoot }),
  agent: agentAdapter,
  workflow: workflowAdapter,
  log,
  readEngineState,
  probePid,
  now: () => new Date(),
  randomToken: () => crypto.randomBytes(2).toString('hex'),
  steps: [], // u1 骨架：空注册表（u2-u5 按 impl-plan 顺序填充）
};

// 顶层 return Promise：worker 将本脚本内联进 async IIFE，async 函数的 return
// 语义自动展开 Promise（等价 await 后 return）；同时保持 node --check（CJS）语法合法。
return lib.runPipeline(io);
