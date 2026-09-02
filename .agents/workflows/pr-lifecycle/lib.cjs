'use strict';
/*
 * pr-lifecycle 状态核心（纯逻辑库）——设计：docs/design/pr-lifecycle-workflow.md §3.4/§3.5/§3.7
 *
 * 本模块禁止直接产生外部效应：fs / pid 探测 / 时间 / 随机源全部经 io 注入，
 * 禁止引用 workerData 与任何 worker 注入全局（入口 pr-lifecycle.js 组装 io，
 * 测试 test/run-tests.js 以 mock io 驱动）。
 *
 * io 契约：
 *   args              发起参数（$ARGS 原样透传；CLI 形态下值为字符串）
 *   repoRoot          repo/worktree 绝对路径（入口解析；state.repo 与守卫 2 的比对基准）
 *   pid               当前进程 pid
 *   fs                { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
 *                       unlinkSync, openSync, writeSync, closeSync }
 *   sh(cmd, args, opts) => { code, stdout, stderr }（lib.createSh 产物；不 throw）
 *   readEngineState(engineRunId) => { ok: true, status } | { ok: false, reason }
 *                                     读引擎 state 文件末行 state.status（P5 实证 JSONL）
 *   probePid(pid) => 'alive' | 'dead'（process.kill(pid, 0) 探测，信号 0 无副作用）
 *   log(...msg)
 *   now() => Date
 *   randomToken() => 4 位随机串（runId 的 rand4 段）
 *   steps             step 注册表 [{ id, run(ctx) }]（u1 为空数组，u2-u5 填充）
 *                       ctx = { state, params, runIdDir, io, saveCheckpoint() }
 */

const path = require('node:path');

const STATE_VERSION = 1;
const LOCK_RETRIES_MAX = 2;

// §3.4-(2) state schema 顶层字段（顺序 = createState 的写盘顺序；测试逐字段断言）
const STATE_FIELDS = [
  'stateVersion',
  'runId',
  'repo',
  'branch',
  'base',
  'baseHash',
  'pid',
  'engineRunId',
  'params',
  'status',
  'failedStep',
  'error',
  'lastHead',
  'result',
  'steps',
];

// 引擎 state 末行 state.status 的已知终态集合（P5 实证：running / done）。
// fail-closed：集合外的值（含缺失/undefined）一律按 running 处理，
// 防引擎格式演进导致旧 run 仍存活时被误放行、双 run 并发互写。
const ENGINE_TERMINAL_STATUS = new Set(['done', 'failed', 'aborted', 'cancelled', 'error']);

/* ── §3.7 错误规格表文案模板 ─────────────────────────────────────────── */

const MSG = {
  stateMissing: (runId) =>
    `runId ${runId} 无效：state 不存在、损坏或版本不兼容；从头执行请去掉 runId 参数`,
  repoMismatch: (stateRepo, curRepo) =>
    `该 runId 属于另一仓库/worktree（state.repo=${stateRepo}，当前=${curRepo}）；请切回发起时的 worktree 后重新带 runId 发起`,
  branchMismatch: (runId, branch) =>
    `runId ${runId} 属于分支 ${branch}；切回该分支后 resume，如需对当前分支跑全流程请不传 runId 起新 run`,
  activeEngine: (engineRunId, status) =>
    `原 run 仍在进行（engineRunId=${engineRunId} status=${status}）；如需接管请先 abort 原 run，之后重新带 runId 发起`,
  activePid: (pid) =>
    `原 run 仍在进行（pid=${pid}；引擎 state 文件不可读，已降级 pid 探测）；如需接管请先终止该进程；` +
    `若疑似 pid 复用，先用 \`ps -p ${pid} -o command=\` 核实非本 run 进程（终态/无关）后终止之，或手工编辑 state 清除 pid 字段后重试`,
  dirtyWorktree: (list) =>
    `存在未提交改动：\n${list}\n若为中断残留（cr-fix/simplify 的半成品），人工检查后经 \`git add <显式路径> && git commit\` 落盘或 \`git checkout -- <路径>\` 还原后 resume`,
  externalChanges: (from, to) =>
    `HEAD 存在外部变更（${from} → ${to}）。确认外部改动后带 allowExternalChanges=true 重新发起（walker 从断点 step 重跑，新 commit 自然进入检查范围），或不传 runId 起新 run`,
  allDoneHeadMoved: (runId, from, to, freshCmd) =>
    `本 run ${runId} 已完成；新产生的 commit（${from} → ${to}）未经任何门禁，请不传 runId 起新 run` +
    `（allowExternalChanges 在此场景无效）。新 run 命令：${freshCmd}`,
  freshConcurrent: (runId) =>
    `已有进行中的 run ${runId}；如需从头再来请先 abort 原 run，或带其 runId resume`,
  lockUnreadable: (lockPath) =>
    `互斥锁存在但内容不可读（${lockPath}）；人工确认无进行中 run 后，手工删除该文件重试`,
  lockRetryExhausted: (n) =>
    `互斥锁接管重试 ${n} 次仍被占用（并发发起过密或持锁进程正在重建）；稍后重试，若持续存在按「${MSG.lockUnreadable('.review/pr-workflow/lock')}」处置`,
  gitFailed: (args, stderr) =>
    `git ${args.join(' ')} 失败：${String(stderr || '').trim() || '无 stderr'}；确认当前目录是有效 git 仓库`,
  baseUnresolvable: (base, stderr) =>
    `base "${base}" 无法解析为 commit（${String(stderr || '').trim()}）；确认 base 分支/ref 名正确`,
  badParam: (name, why) =>
    `参数 ${name} 非法：${why}；对照脚本 @pi-meta 的 parameters 声明修正发起参数`,
};

// resumeCommand（§3.4-(1)：失败终态必须含可直接复制执行的恢复命令）
function resumeCommand(repo, runId) {
  return runId
    ? `zflow run pr-lifecycle workdir=${repo} runId=${runId}`
    : `zflow run pr-lifecycle workdir=${repo}`;
}

/* ── 守卫失败载体 ────────────────────────────────────────────────────── */

class GuardError extends Error {
  constructor(message, { runId = null, resumeCommand = undefined } = {}) {
    super(message);
    this.name = 'GuardError';
    this.runId = runId;
    this.resumeCommand = resumeCommand;
  }
}

/* ── 参数合并语义（§3.5：发起值覆盖脚本默认值；CLI 字符串形态防御性归一） ── */

function asString(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new GuardError(MSG.badParam(name, '应为字符串'));
}

function asStringArray(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (typeof x !== 'string' && typeof x !== 'number') {
        throw new GuardError(MSG.badParam(name, '数组元素应为字符串'));
      }
      return String(x);
    });
  }
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return asStringArray(parsed, name, dflt);
    } catch { /* 非 JSON，按逗号分割 */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  throw new GuardError(MSG.badParam(name, '应为字符串数组或逗号分隔字符串'));
}

function asNumber(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new GuardError(MSG.badParam(name, `应为数字，得到 ${JSON.stringify(v)}`));
  return n;
}

function asBool(v, name, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new GuardError(MSG.badParam(name, '应为布尔值（true/false）'));
}

function asEnum(v, name, allowed, dflt) {
  const s = asString(v, name, dflt);
  if (!allowed.includes(s)) {
    throw new GuardError(MSG.badParam(name, `应为 ${allowed.map((a) => `"${a}"`).join(' | ')} 之一，得到 "${s}"`));
  }
  return s;
}

/**
 * @pi-meta parameters 声明的全部脚本级参数（timeoutMs/workdir/model 等引擎级
 * 参数不在此列——RUN_ENVELOPE_KEYS 不进 $ARGS）。CLI 透传值为字符串时在此归一。
 */
function normalizeParams(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    runId: asString(raw.runId, 'runId', null) || null,
    base: asString(raw.base, 'base', 'main'),
    reviewers: asStringArray(raw.reviewers, 'reviewers', null),
    maxRounds: asNumber(raw.maxRounds, 'maxRounds', 10),
    simplifyMode: asEnum(raw.simplifyMode, 'simplifyMode', ['apply', 'report'], 'apply'),
    skipSteps: asStringArray(raw.skipSteps, 'skipSteps', []),
    allowExternalChanges: asBool(raw.allowExternalChanges, 'allowExternalChanges', false),
  };
}

/* ── runId（§3.4-(1)：prw-<yyyymmdd>-<HHMMSS>-<rand4>，脚本自生成） ──── */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function makeRunId(now, randomToken) {
  const d = now();
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `prw-${date}-${time}-${randomToken()}`;
}

function isValidRunId(runId) {
  return /^prw-\d{8}-\d{6}-[a-z0-9]{4}$/.test(runId);
}

/* ── state（§3.4-(2)：schema v1 + 原子写） ───────────────────────────── */

function createState({ runId, repo, branch, base, baseHash, pid, engineRunId, params, head }) {
  const state = {
    stateVersion: STATE_VERSION,
    runId,
    repo,
    branch,
    base,
    baseHash,
    pid,
    engineRunId,
    params,
    status: 'running',
    failedStep: null,
    error: null,
    lastHead: head,
    result: null,
    steps: {},
  };
  return state;
}

let tmpSeq = 0;

/**
 * 原子落盘：tmp 写全量 + rename 原子替换（§3.4-(2)）。
 * 每次 checkpoint 顺带刷新 lastHead = 当前 HEAD（读失败保留原值，不阻断落盘）。
 */
function saveState(io, state, stateFile) {
  const headRes = io.sh('git', ['rev-parse', 'HEAD']);
  if (headRes.code === 0 && headRes.stdout.trim()) state.lastHead = headRes.stdout.trim();
  const tmp = `${stateFile}.tmp-${io.pid}-${tmpSeq++}`;
  io.fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  io.fs.renameSync(tmp, stateFile);
}

/* ── sh() 封装（§3.5：execFileSync + 参数数组 + maxBuffer ≥64MB + 显式 cwd） ── */

const SH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * 确定性命令封装工厂。入口传真实 execFileSync；测试传 spy。
 * 约定：cmd/args 严格数组形态，绝不拼接 shell 字符串；失败不 throw，
 * 统一归一为 { code, stdout, stderr }（P4：maxBuffer 显式 64MB，防插桩长输出炸默认 1MB）。
 */
function createSh({ execFileSync, defaultCwd, maxBufferBytes = SH_MAX_BUFFER_BYTES }) {
  return function sh(cmd, args, opts = {}) {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: opts.cwd || defaultCwd,
        maxBuffer: maxBufferBytes,
        encoding: 'utf8',
      });
      return { code: 0, stdout: typeof stdout === 'string' ? stdout : '', stderr: '' };
    } catch (e) {
      return {
        code: typeof e.status === 'number' ? e.status : (e.code === 'ENOENT' ? 127 : -1),
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' && e.stderr ? e.stderr : String((e && e.message) || e),
      };
    }
  };
}

/* ── git 只读解析 ────────────────────────────────────────────────────── */

function gitSnapshot(io) {
  const repoRes = io.sh('git', ['rev-parse', '--show-toplevel']);
  if (repoRes.code !== 0) throw new GuardError(MSG.gitFailed(['rev-parse', '--show-toplevel'], repoRes.stderr));
  const branchRes = io.sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branchRes.code !== 0) throw new GuardError(MSG.gitFailed(['rev-parse', '--abbrev-ref', 'HEAD'], branchRes.stderr));
  const headRes = io.sh('git', ['rev-parse', 'HEAD']);
  if (headRes.code !== 0) throw new GuardError(MSG.gitFailed(['rev-parse', 'HEAD'], headRes.stderr));
  return {
    repo: repoRes.stdout.trim(),
    branch: branchRes.stdout.trim(),
    head: headRes.stdout.trim(),
  };
}

function resolveBaseHash(io, base) {
  const res = io.sh('git', ['rev-parse', `${base}^{commit}`]);
  if (res.code !== 0) throw new GuardError(MSG.baseUnresolvable(base, res.stderr));
  return res.stdout.trim();
}

/* ── 活性守卫（§3.4-(4)：双通道 fail-closed） ─────────────────────────── */

/**
 * 主通道：读引擎 state 文件末行 status——running 或未知/缺失值一律视为
 * 进行中（fail-closed）；明确终态放行。
 * 降级通道：文件不可读/缺失时 probePid(pid)，死 → 放行（log 标注降级），
 * 活 → fail-fast（文案带 pid 复用人工出口）。
 */
function assertNotActive(io, engineRunId, pid, label) {
  label = label || '原 run';
  if (engineRunId) {
    const es = io.readEngineState(engineRunId);
    if (es && es.ok) {
      if (!ENGINE_TERMINAL_STATUS.has(es.status)) {
        // running、未知或缺失状态值：一律视为进行中（fail-closed）
        throw new GuardError(MSG.activeEngine(engineRunId, es.status == null ? '<missing>' : es.status));
      }
      return; // 明确终态 → 放行
    }
    io.log(`[liveness] 引擎 state 不可读（${(es && es.reason) || 'unknown'}），降级 pid 探测（${label} pid=${pid}）`);
  } else if (pid) {
    io.log(`[liveness] 无 engineRunId，直接降级 pid 探测（${label} pid=${pid}）`);
  }
  if (typeof pid === 'number' && pid > 0) {
    if (io.probePid(pid) === 'alive') {
      throw new GuardError(MSG.activePid(pid));
    }
    io.log(`[liveness] 降级通道：pid=${pid} 已退出，放行（${label}）`);
  }
  // 无 engineRunId 且无有效 pid：无从判定也无需判定（fresh 首跑等场景）
}

/* ── 互斥锁（§3.4-(1)：O_EXCL 原子创建；EEXIST 读锁内容过活性复查） ──── */

function lockPathOf(stateDir) {
  return path.join(stateDir, 'lock');
}

function writeLockContent(io, lockPath, runId, engineRunId) {
  io.fs.writeFileSync(lockPath, JSON.stringify({
    runId: runId || null,
    pid: io.pid,
    engineRunId: engineRunId || null,
    createdAt: io.now().toISOString(),
  }, null, 2));
}

function acquireLock(io, stateDir, engineRunId) {
  const lockPath = lockPathOf(stateDir);
  for (let attempt = 0; attempt <= LOCK_RETRIES_MAX; attempt++) {
    let fd;
    try {
      fd = io.fs.openSync(lockPath, 'wx'); // O_EXCL：原子创建，唯一持有者
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let info = null;
        try {
          info = JSON.parse(io.fs.readFileSync(lockPath, 'utf8'));
        } catch { info = null; }
        if (!info || typeof info !== 'object') {
          // 空锁（创建方 write 前被读）或损坏：fail-closed，交人工
          throw new GuardError(MSG.lockUnreadable(lockPath));
        }
        assertNotActive(io, info.engineRunId, info.pid, '互斥锁持有者');
        io.log(`[lock] 残留锁持有人已终态/退出（runId=${info.runId} pid=${info.pid}），接管重建`);
        io.fs.unlinkSync(lockPath);
        continue; // 重建
      }
      throw e;
    }
    try {
      io.fs.writeSync(fd, JSON.stringify({
        runId: null, // fresh 时 runId 未生成，生成后经 updateLockContent 回填
        pid: io.pid,
        engineRunId: engineRunId || null,
        createdAt: io.now().toISOString(),
      }, null, 2));
    } finally {
      io.fs.closeSync(fd);
    }
    return lockPath;
  }
  throw new GuardError(MSG.lockRetryExhausted(LOCK_RETRIES_MAX));
}

function releaseLock(io, lockPath) {
  try {
    io.fs.unlinkSync(lockPath);
  } catch (e) {
    io.log(`[lock] 锁删除失败（${(e && e.message) || e}）；残留锁将由下次发起的活性复查接管`);
  }
}

/* ── latest 指针 + fresh 并发防护（§3.4-(1)） ────────────────────────── */

function latestPathOf(stateDir) {
  return path.join(stateDir, 'latest');
}

function readLatest(io, stateDir) {
  try {
    const content = io.fs.readFileSync(latestPathOf(stateDir), 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function writeLatest(io, stateDir, runId) {
  io.fs.writeFileSync(latestPathOf(stateDir), `${runId}\n`);
}

// fresh 并发防护：读 latest 指针对应 run 的 state，对其 engineRunId/pid 过活性守卫
function guardFreshConcurrent(io, stateDir) {
  const latest = readLatest(io, stateDir);
  if (!latest) return;
  let prevState = null;
  try {
    prevState = JSON.parse(io.fs.readFileSync(path.join(stateDir, latest, 'state.json'), 'utf8'));
  } catch {
    prevState = null;
  }
  if (!prevState || typeof prevState !== 'object') return; // 旧 state 已不可读，无从判定（锁兜底互斥）
  try {
    assertNotActive(io, prevState.engineRunId, prevState.pid, `latest 指向的 run ${latest}`);
  } catch (e) {
    if (e instanceof GuardError) {
      // fresh 并发语义文案（带 runId），活性细节并入括号（§3.4-(1)）
      throw new GuardError(`${MSG.freshConcurrent(latest)}（${String(e.message).trim()}）`, { runId: latest });
    }
    throw e;
  }
  io.log(`[fresh] latest 指向的 run ${latest} 已终态/退出（status=${prevState.status}），允许新建`);
}

/* ── 终态组装（§3.1 scriptResult.json） ──────────────────────────────── */

function collectSkippedSteps(state) {
  const skipped = [];
  for (const id of Object.keys(state.steps)) {
    const rec = state.steps[id];
    if (rec && rec.status === 'skipped') {
      skipped.push({ step: id, reason: rec.reason || 'unspecified' });
    }
  }
  return skipped;
}

// 终态展示字段聚合（outputs 契约：§3.4-(2)；pr-submit/cr-fix/simplify/final-gates 由 u2-u5 落地）
function stepOutputs(state, stepId) {
  const rec = state.steps[stepId];
  return (rec && rec.outputs) || null;
}

function buildAwaitingPushResult(state) {
  const prSubmit = stepOutputs(state, 'pr-submit') || {};
  const crFix = stepOutputs(state, 'cr-fix') || {};
  const simplify = stepOutputs(state, 'simplify');
  const coverage1 = stepOutputs(state, 'coverage-1') || {};
  const finalGates = stepOutputs(state, 'final-gates') || {};
  return {
    status: 'awaiting-push',
    runId: state.runId,
    prUrl: prSubmit.prUrl || null,
    terminated: crFix.terminated || null,
    simplify: simplify ? `applied:${simplify.applied != null ? simplify.applied : 0}/proposals:${simplify.proposals != null ? simplify.proposals : 0}` : null,
    gates: {
      coverage: finalGates.coverageVerdict != null ? finalGates.coverageVerdict : (coverage1.coverageVerdict || null),
      metrics: finalGates.metricsVerdict || null,
      premerge: finalGates.premergeResult || null,
    },
    skippedSteps: collectSkippedSteps(state),
  };
}

function buildFailedResult(state, failedStep, error) {
  return {
    status: 'failed',
    runId: state.runId,
    failedStep: failedStep || null,
    error: error || null,
    resumeCommand: resumeCommand(state.repo, state.runId),
    skippedSteps: collectSkippedSteps(state),
  };
}

function guardFailResult(guardErr, fallbackRunId, repoRoot) {
  const runId = guardErr.runId != null ? guardErr.runId : fallbackRunId;
  return {
    status: 'failed',
    runId,
    failedStep: null,
    error: guardErr.message,
    resumeCommand: guardErr.resumeCommand !== undefined
      ? guardErr.resumeCommand
      : resumeCommand(repoRoot, runId),
    skippedSteps: [],
  };
}

/* ── resume walker（§3.4-(3) 六条语义） ──────────────────────────────── */

function isFinished(rec) {
  return !!rec && (rec.status === 'done' || rec.status === 'skipped');
}

function allStepsFinished(state, registry) {
  return registry.every((s) => isFinished(state.steps[s.id]));
}

// 语义 4：skipSteps 逃生舱——只对「未完成」step 标 skipped(reason: "user-ack")，
// done/skipped 不动；skipped 必带 reason 并透传终态 scriptResult.skippedSteps。
// skipSteps 消费本次发起参数（resume 时用户显式传入即为接管意图），
// state.params 保留首次发起的参数语境不回写。
function applySkipSteps(io, state, registry, stateFile, activeParams) {
  const skip = new Set((activeParams && activeParams.skipSteps) || []);
  if (skip.size === 0) return false;
  let changed = false;
  for (const step of registry) {
    const rec = state.steps[step.id];
    if (skip.has(step.id) && !isFinished(rec)) {
      state.steps[step.id] = {
        ...(rec || {}),
        status: 'skipped',
        reason: 'user-ack',
        finishedAt: io.now().toISOString(),
      };
      changed = true;
    }
  }
  if (changed) saveState(io, state, stateFile);
  return changed;
}

async function walkAndFinish(io, state, stateDir, activeParams) {
  const registry = io.steps || [];
  const stateFile = path.join(stateDir, state.runId, 'state.json');
  const runIdDir = path.join(stateDir, state.runId);

  applySkipSteps(io, state, registry, stateFile, activeParams);

  for (const step of registry) {
    const rec = state.steps[step.id];
    if (isFinished(rec)) continue; // 语义 2：done/skipped 一律不重跑

    // 语义 3：failed/in_progress（上次死在中途）整体重跑该 step
    state.steps[step.id] = {
      ...(rec || {}),
      status: 'in_progress',
      startedAt: io.now().toISOString(),
      attempts: ((rec && rec.attempts) || 0) + 1,
    };
    saveState(io, state, stateFile);

    const ctx = {
      state,
      params: state.params,
      runIdDir,
      io,
      saveCheckpoint() {
        saveState(io, state, stateFile); // 子循环每轮落盘的出口（u3 子循环经此落盘）
      },
    };

    try {
      const outputs = (await step.run(ctx)) || {};
      state.steps[step.id] = {
        ...state.steps[step.id],
        status: 'done',
        finishedAt: io.now().toISOString(),
        outputs,
      };
      saveState(io, state, stateFile);
    } catch (e) {
      const message = (e && e.message) ? e.message : String(e);
      state.steps[step.id] = {
        ...state.steps[step.id],
        status: 'failed',
        finishedAt: io.now().toISOString(),
        error: message,
      };
      saveState(io, state, stateFile);
      state.status = 'failed';
      state.failedStep = step.id;
      state.error = message;
      state.result = buildFailedResult(state, step.id, message);
      saveState(io, state, stateFile);
      return state.result;
    }
  }

  // 全部完成 → 唯一成功终态 awaiting-push；result 快照落盘（幂等重跑直接回放）
  state.status = 'awaiting-push';
  state.failedStep = null;
  state.error = null;
  if (!state.result) state.result = buildAwaitingPushResult(state);
  saveState(io, state, stateFile);
  return state.result;
}

/* ── 主入口 ──────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<object>} 终态 scriptResult（纯 JSON，可 structured-clone）。
 * 成功：{status:'awaiting-push', ...}；失败：{status:'failed', failedStep/error/resumeCommand}。
 * 守卫 fail-fast 不改写 state（返回 guard 失败 result），step 失败落盘 status:'failed'。
 */
async function runPipeline(io) {
  const params = normalizeParams(io.args);
  const engineRunId = io.args && typeof io.args._runId === 'string' ? io.args._runId : null;
  const stateDir = path.join(io.repoRoot, '.review', 'pr-workflow');

  io.fs.mkdirSync(stateDir, { recursive: true });

  let lockPath = null;
  try {
    lockPath = acquireLock(io, stateDir, engineRunId);

    const result = params.runId
      ? await resumeFlow(io, params, engineRunId, stateDir)
      : await freshFlow(io, params, engineRunId, stateDir, lockPath);

    // 终态（awaiting-push / failed）删除锁（§3.4-(1)）
    releaseLock(io, lockPath);
    lockPath = null;
    return result;
  } catch (e) {
    if (e instanceof GuardError) {
      if (lockPath) {
        releaseLock(io, lockPath);
        lockPath = null;
      }
      return guardFailResult(e, params.runId, io.repoRoot);
    }
    throw e; // 未预期异常：原样上抛（worker 侧报 error；锁交由残留接管路径）
  } finally {
    if (lockPath) releaseLock(io, lockPath);
  }
}

/** fresh：创建 runId（第一动作）→ 落盘 latest + state → walker */
async function freshFlow(io, params, engineRunId, stateDir, lockPath) {
  guardFreshConcurrent(io, stateDir);

  const runId = makeRunId(io.now, io.randomToken);
  if (!isValidRunId(runId)) throw new GuardError(`生成的 runId 不合法（${runId}）；检查 now/randomToken 注入`);
  writeLatest(io, stateDir, runId); // 暴毙兜底通道先落（先于任何副作用）
  updateLockContent(io, lockPath, runId, engineRunId);

  const git = gitSnapshot(io);
  const baseHash = resolveBaseHash(io, params.base);
  const state = createState({
    runId,
    repo: git.repo,
    branch: git.branch,
    base: params.base,
    baseHash,
    pid: io.pid,
    engineRunId,
    params,
    head: git.head,
  });

  const stateFile = path.join(stateDir, runId, 'state.json');
  io.fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  io.log(`runId=${runId} resumeCommand=${resumeCommand(git.repo, runId)}`); // §3.4-(1) 通道 3：log 首行
  saveState(io, state, stateFile);

  return walkAndFinish(io, state, stateDir, params);
}

/** resume：六道守卫（§3.4-(4) 顺序）→ engineRunId 刷新 → walker */
async function resumeFlow(io, params, engineRunId, stateDir) {
  const runId = params.runId;
  const stateFile = path.join(stateDir, runId, 'state.json');

  // 守卫 1：state 存在性与版本（fail-fast，绝不悄悄新建）
  if (!io.fs.existsSync(stateFile)) {
    throw new GuardError(MSG.stateMissing(runId), {
      runId,
      resumeCommand: resumeCommand(io.repoRoot, null), // 从头跑 = 不带 runId
    });
  }
  let state;
  try {
    state = JSON.parse(io.fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    throw new GuardError(`${MSG.stateMissing(runId)}（state 解析失败：${(e && e.message) || e}）`, {
      runId,
      resumeCommand: resumeCommand(io.repoRoot, null),
    });
  }
  if (!state || typeof state !== 'object' || state.stateVersion !== STATE_VERSION) {
    throw new GuardError(MSG.stateMissing(runId), { runId, resumeCommand: resumeCommand(io.repoRoot, null) });
  }

  // 守卫 2：repo 一致
  const git = gitSnapshot(io);
  if (state.repo !== git.repo) {
    throw new GuardError(MSG.repoMismatch(state.repo, git.repo), { runId });
  }

  // 守卫 3：分支一致
  if (state.branch !== git.branch) {
    throw new GuardError(MSG.branchMismatch(runId, state.branch), { runId });
  }

  // 守卫 4：活性双通道（对上一次发起的 engineRunId/pid；fail-closed）
  assertNotActive(io, state.engineRunId, state.pid);

  const registry = io.steps || [];

  // 语义 6：空转防护（先于 HEAD 守卫——全 done 场景不适用外部变更守卫）
  if (allStepsFinished(state, registry)) {
    if (git.head === state.lastHead) {
      touchRunContext(io, state, engineRunId);
      saveState(io, state, stateFile); // 幂等回放：仅刷新 engineRunId/pid，result 原样
      io.log(`[resume] run ${runId} 已全部完成且 HEAD 未变，回放既有终态`);
      // 正常路径全 done 必有 result 快照；null 只出自被手工篡改/旧版本 state，兜底重建防返回 null
      return state.result || buildAwaitingPushResult(state);
    }
    throw new GuardError(MSG.allDoneHeadMoved(runId, state.lastHead, git.head, resumeCommand(io.repoRoot, null)), {
      runId,
      resumeCommand: null, // 指向「起新 run」而非 resume，防指引链兜圈
    });
  }

  // 守卫 5：工作区干净
  const st = io.sh('git', ['status', '--porcelain']);
  if (st.code !== 0) throw new GuardError(MSG.gitFailed(['status', '--porcelain'], st.stderr), { runId });
  if (st.stdout.trim() !== '') {
    throw new GuardError(MSG.dirtyWorktree(st.stdout.trimEnd()), { runId });
  }

  // 守卫 6：HEAD 外部变更（status=failed 时外部 commit 是预期恢复动作，直接放行）
  if (git.head !== state.lastHead && state.status !== 'failed') {
    if (!params.allowExternalChanges) {
      throw new GuardError(MSG.externalChanges(state.lastHead, git.head), { runId });
    }
    io.log(`[guard] HEAD 外部变更（${state.lastHead} → ${git.head}）已由 allowExternalChanges=true 显式放行`);
  }

  // 守卫全过 → 刷新本次发起的 engineRunId/pid（活性守卫主通道永远读最近一次 run）
  touchRunContext(io, state, engineRunId);

  return walkAndFinish(io, state, stateDir, params);
}

function touchRunContext(io, state, engineRunId) {
  state.engineRunId = engineRunId || state.engineRunId;
  state.pid = io.pid;
}

function updateLockContent(io, lockPath, runId, engineRunId) {
  writeLockContent(io, lockPath, runId, engineRunId);
}

module.exports = {
  STATE_VERSION,
  STATE_FIELDS,
  ENGINE_TERMINAL_STATUS,
  SH_MAX_BUFFER_BYTES,
  MSG,
  GuardError,
  normalizeParams,
  makeRunId,
  isValidRunId,
  createState,
  saveState,
  createSh,
  resumeCommand,
  runPipeline,
};
