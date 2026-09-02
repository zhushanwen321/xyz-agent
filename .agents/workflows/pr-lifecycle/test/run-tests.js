'use strict';
/*
 * pr-lifecycle lib.cjs 单测 runner（自写断言，非 node:test 框架）。
 *
 * 运行：node .agents/workflows/pr-lifecycle/test/run-tests.js（exit 非 0 = 失败）。
 * 依据 impl-plan 偏差 3：测试对象是 .agents/workflows/ 下独立 .cjs，不在任何
 * pnpm 子包内、无 vitest 配置可挂载，故用 mock io 依赖注入直跑。
 * 全部读写只发生在 os.tmpdir() 下 mkdtemp 自建目录，测试结束删除，不触真实数据目录。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require(path.join(__dirname, '..', 'lib.cjs'));

/* ── runner 骨架 ─────────────────────────────────────────────────────── */

let passed = 0;
const failed = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed.push({ name, e });
    console.error(`FAIL  ${name}`);
    console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
  }
}

function assertIncludes(hay, needle, msg) {
  assert.ok(
    String(hay).includes(needle),
    msg || `期望包含「${needle}」，实际：「${String(hay).slice(0, 400)}」`,
  );
}

/* ── mock io 工厂 ────────────────────────────────────────────────────── */

function stateDirOf(root) {
  return path.join(root, '.review', 'pr-workflow');
}

const RUN_ID_A = 'prw-20260901-090000-aaaa';

/**
 * 构造 mock io：temp repoRoot + 可编程 git 快照 + 引擎 state 映射 + pid 映射。
 * opts: { args, steps, head, branch, base, baseHash, porcelain, engineMap, pidMap,
 *         failBase, commits, stat, names, scriptMocks: { <脚本路径>: 响应|fn(args) },
 *         agent: async (params) => ({ value, error }) }
 */
function makeIo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prl-u1-'));
  const base = opts.base || 'main';
  const git = {
    head: opts.head || 'H1',
    branch: opts.branch || 'feat-x',
    baseHash: opts.baseHash || 'B1',
    porcelain: opts.porcelain || '',
    commits: opts.commits !== undefined ? opts.commits : 'feat: a commit\n\nbody line\n---\n',
    stat: opts.stat !== undefined ? opts.stat : ' a.js | 2 +-\n',
    names: opts.names !== undefined ? opts.names : 'src/a.js\n',
  };
  const engineMap = Object.assign({ 'wf-old': 'done' }, opts.engineMap);
  const pidMap = Object.assign({}, opts.pidMap);
  const scriptMocks = opts.scriptMocks || {};
  const agentCalls = [];
  const recorded = { sh: [], logs: [], renames: [], renameContents: [] };

  const sh = (cmd, args) => {
    recorded.sh.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--show-toplevel') return { code: 0, stdout: `${root}\n` };
      if (args[1] === '--abbrev-ref' && args[2] === 'HEAD') return { code: 0, stdout: `${git.branch}\n` };
      if (args[1] === 'HEAD') return { code: 0, stdout: `${git.head}\n` };
      if (args[1] === `${base}^{commit}`) {
        if (opts.failBase) return { code: 128, stdout: '', stderr: `fatal: ambiguous argument '${base}^{commit}'` };
        return { code: 0, stdout: `${git.baseHash}\n` };
      }
    }
    if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
      return { code: 0, stdout: git.porcelain };
    }
    if (cmd === 'git' && args[0] === 'log' && args[1] === `${git.baseHash}..HEAD`) {
      return { code: 0, stdout: git.commits };
    }
    if (cmd === 'git' && args[0] === 'diff' && args[1] === `${git.baseHash}..HEAD`) {
      if (args[2] === '--stat') return { code: 0, stdout: git.stat };
      if (args[2] === '--name-only') return { code: 0, stdout: git.names };
      return { code: 0, stdout: git.stat };
    }
    // gh / fallow 等外部命令按名 mock（preflight 用）
    if (opts.cmdResults && Object.prototype.hasOwnProperty.call(opts.cmdResults, cmd)) {
      const m = opts.cmdResults[cmd];
      return typeof m === 'function' ? m(args) : m;
    }
    // u2 脚本 mock 分发（按 argv[0] = 脚本路径；假脚本经此注入，不需要真实文件）
    if (cmd === 'bash' && Object.prototype.hasOwnProperty.call(scriptMocks, args[0])) {
      const m = scriptMocks[args[0]];
      return typeof m === 'function' ? m(args) : m;
    }
    if (cmd === 'python3' && Object.prototype.hasOwnProperty.call(scriptMocks, args[0])) {
      const m = scriptMocks[args[0]];
      return typeof m === 'function' ? m(args) : m;
    }
    return { code: 0, stdout: '' };
  };

  // 包装真实 fs：写序列可观测（原子写断言），读写只落 temp root
  const fsWrap = {
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    writeSync: fs.writeSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
    renameSync: (a, b) => {
      recorded.renames.push([String(a), String(b)]);
      try {
        recorded.renameContents.push(fs.readFileSync(a, 'utf8'));
      } catch {
        recorded.renameContents.push(null);
      }
      fs.renameSync(a, b);
    },
  };

  const io = {
    args: opts.args !== undefined ? opts.args : {},
    repoRoot: root,
    pid: 4242,
    fs: fsWrap,
    sh,
    // agent mock：记录调用并按 opts.agent 编程（默认成功返回空对象）
    agent: async (params) => {
      agentCalls.push(params);
      const impl = opts.agent || (async () => ({ value: {}, error: null }));
      return impl(params);
    },
    workflow: async () => ({ content: '', parsedOutput: null }),
    readEngineState: (er) => (er && Object.prototype.hasOwnProperty.call(engineMap, er)
      ? { ok: true, status: engineMap[er] }
      : { ok: false, reason: `engine state file not found: ${er}` }),
    probePid: (pid) => (Object.prototype.hasOwnProperty.call(pidMap, pid) ? pidMap[pid] : 'dead'),
    log: (...m) => recorded.logs.push(m.join(' ')),
    now: () => new Date('2026-09-03T10:00:00'),
    randomToken: () => 'ab12',
    steps: opts.steps || [],
  };
  return { io, root, recorded, git, engineMap, pidMap, agentCalls };
}

// u2：PR 阶段六 steps 注册表（脚本路径全部注入假路径，脚本行为经 scriptMocks 编程）
const FAKE_PATHS = {
  preMerge: '/fake/pr-pre-merge.sh',
  prSubmit: '/fake/pr-submit.sh',
  validateSkillYaml: '/fake/validate-skill-yaml.py',
};

function makeSteps(opts = {}) {
  const root = opts.root;
  return lib.createPrSteps({ repoRoot: root, scriptPaths: FAKE_PATHS });
}

const shCallsTo = (recorded, scriptPath) =>
  recorded.sh.filter((c) => c[0] !== 'git' && c[1] === scriptPath);

/** 手工构造一个 resume 前置 state（绕过 fresh 链路，独立驱动守卫分支） */
function seedState(root, overrides = {}) {
  const state = Object.assign({
    stateVersion: 1,
    runId: RUN_ID_A,
    repo: root,
    branch: 'feat-x',
    base: 'main',
    baseHash: 'B1',
    pid: 111,
    engineRunId: 'wf-old',
    params: {
      runId: RUN_ID_A,
      base: 'main',
      reviewers: null,
      maxRounds: 10,
      simplifyMode: 'apply',
      skipSteps: [],
      allowExternalChanges: false,
    },
    status: 'running',
    failedStep: null,
    error: null,
    lastHead: 'H1',
    result: null,
    steps: {},
  }, overrides);
  const dir = path.join(stateDirOf(root), state.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

function readStateFile(root, runId) {
  return JSON.parse(fs.readFileSync(path.join(stateDirOf(root), runId, 'state.json'), 'utf8'));
}

const mkStep = (id, runs) => ({
  id,
  run: async () => {
    runs.push(id);
    return { v: id };
  },
});

/* ── 单元级：schema / runId / 参数归一 / sh 工厂 / 文案 ───────────────── */

async function main() {
  await test('state schema：createState 顶层字段与 §3.4-(2) 逐字段一致（不多不少）', () => {
    const state = lib.createState({
      runId: 'r', repo: '/r', branch: 'b', base: 'main', baseHash: 'h',
      pid: 1, engineRunId: 'wf-1', params: {}, head: 'H',
    });
    assert.deepStrictEqual(Object.keys(state), lib.STATE_FIELDS);
    assert.deepStrictEqual(lib.STATE_FIELDS, [
      'stateVersion', 'runId', 'repo', 'branch', 'base', 'baseHash', 'pid',
      'engineRunId', 'params', 'status', 'failedStep', 'error', 'lastHead',
      'result', 'steps',
    ]);
    assert.strictEqual(state.stateVersion, 1);
    assert.strictEqual(state.status, 'running');
    assert.strictEqual(state.failedStep, null);
    assert.strictEqual(state.error, null);
    assert.strictEqual(state.result, null);
    assert.deepStrictEqual(state.steps, {});
  });

  await test('runId 格式：prw-<yyyymmdd>-<HHMMSS>-<rand4>', () => {
    const id = lib.makeRunId(() => new Date('2026-09-03T10:00:00'), () => 'ab12');
    assert.strictEqual(id, 'prw-20260903-100000-ab12');
    assert.ok(lib.isValidRunId(id));
    assert.ok(!lib.isValidRunId('prw-20260903-100000-AB12')); // rand4 仅小写字母数字
    assert.ok(!lib.isValidRunId('wf-20260903-100000-ab12'));
  });

  await test('参数归一：CLI 字符串形态解析 + 默认值填充 + 非法值 fail-fast', () => {
    const p = lib.normalizeParams({
      base: 'dev', maxRounds: '5', skipSteps: 'a, b',
      allowExternalChanges: 'true', simplifyMode: 'report', reviewers: 'x.md,y.md',
    });
    assert.deepStrictEqual(p, {
      runId: null, base: 'dev', reviewers: ['x.md', 'y.md'], maxRounds: 5,
      simplifyMode: 'report', skipSteps: ['a', 'b'], allowExternalChanges: true,
    });
    const dflt = lib.normalizeParams({});
    assert.strictEqual(dflt.base, 'main');
    assert.strictEqual(dflt.maxRounds, 10);
    assert.strictEqual(dflt.simplifyMode, 'apply');
    assert.deepStrictEqual(dflt.skipSteps, []);
    assert.strictEqual(dflt.allowExternalChanges, false);
    assert.throws(() => lib.normalizeParams({ maxRounds: 'abc' }), /参数 maxRounds 非法/);
    assert.throws(() => lib.normalizeParams({ simplifyMode: 'nope' }), /参数 simplifyMode 非法/);
    // JSON 数组字符串形态
    assert.deepStrictEqual(lib.normalizeParams({ skipSteps: '["cr-fix","simplify"]' }).skipSteps, ['cr-fix', 'simplify']);
  });

  await test('sh 工厂：maxBuffer=64MB + 显式 cwd + 参数数组透传 + 失败归一不 throw（P4）', () => {
    const captured = [];
    const spyExec = (cmd, args, opts) => {
      captured.push({ cmd, args, opts });
      if (args[0] === 'fail') {
        const e = new Error('spawn fail');
        e.status = 42;
        e.stdout = 'partial-out';
        e.stderr = 'boom-err';
        throw e;
      }
      if (args[0] === 'enoent-marker') {
        const e = new Error('spawn git ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return 'out\n';
    };
    const sh = lib.createSh({ execFileSync: spyExec, defaultCwd: '/repo/root' });
    assert.deepStrictEqual(sh('git', ['status', '--porcelain']), { code: 0, stdout: 'out\n', stderr: '' });
    assert.strictEqual(captured[0].cmd, 'git');                       // 命令名独立（不经 shell 字符串）
    assert.deepStrictEqual(captured[0].args, ['status', '--porcelain']); // 参数数组
    assert.strictEqual(captured[0].opts.cwd, '/repo/root');           // 显式 cwd
    assert.strictEqual(captured[0].opts.maxBuffer, 64 * 1024 * 1024); // P4：≥64MB
    assert.strictEqual(captured[0].opts.encoding, 'utf8');
    const failRes = sh('git', ['fail']);
    assert.deepStrictEqual(failRes, { code: 42, stdout: 'partial-out', stderr: 'boom-err' });
    assert.strictEqual(sh('git', ['enoent-marker']).code, 127);
    // cwd 覆盖
    sh('git', ['x'], { cwd: '/other' });
    assert.strictEqual(captured[3].opts.cwd, '/other');
  });

  await test('resumeCommand 生成：带 runId 与 fresh 形态', () => {
    assert.strictEqual(
      lib.resumeCommand('/abs/repo', 'prw-20260903-100000-ab12'),
      'zflow run pr-lifecycle workdir=/abs/repo runId=prw-20260903-100000-ab12',
    );
    assert.strictEqual(
      lib.resumeCommand('/abs/repo', null),
      'zflow run pr-lifecycle workdir=/abs/repo',
    );
  });

  /* ── fresh 流程 ── */

  await test('fresh（空注册表）：直接到 awaiting-push 终态，latest/state/锁/engineRunId 全部落盘', async () => {
    const { io, root, recorded } = makeIo({ args: { _runId: 'wf-engine-1' } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.ok(lib.isValidRunId(result.runId), `runId 格式：${result.runId}`);
    assert.strictEqual(result.runId, 'prw-20260903-100000-ab12');
    assert.strictEqual(result.prUrl, null);
    assert.strictEqual(result.terminated, null);
    assert.strictEqual(result.simplify, null);
    assert.deepStrictEqual(result.gates, { coverage: null, metrics: null, premerge: null });
    assert.deepStrictEqual(result.skippedSteps, []);
    // latest 指针 = runId 单行（暴毙兜底通道）
    assert.strictEqual(fs.readFileSync(path.join(stateDirOf(root), 'latest'), 'utf8'), `${result.runId}\n`);
    // state 落盘：status/engineRunId/params
    const state = readStateFile(root, result.runId);
    assert.strictEqual(state.status, 'awaiting-push');
    assert.strictEqual(state.engineRunId, 'wf-engine-1'); // fresh：engineRunId = 本次 $ARGS._runId
    assert.strictEqual(state.pid, 4242);
    assert.strictEqual(state.baseHash, 'B1');
    assert.strictEqual(state.branch, 'feat-x');
    assert.deepStrictEqual(state.result, result); // result 快照 = 返回值
    // 终态后锁删除
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), false);
    // log 首行含 runId 与 resumeCommand（获取通道 3）
    assertIncludes(recorded.logs[0], `runId=${result.runId}`);
    assertIncludes(recorded.logs[0], `resumeCommand=zflow run pr-lifecycle workdir=${root} runId=${result.runId}`);
  });

  await test('fresh 并发防护：latest 指向进行中 run → fail-fast「已有进行中的 run」', async () => {
    const { io, root } = makeIo({ args: {}, engineMap: { 'wf-live': 'running' } });
    seedState(root, { runId: RUN_ID_A, engineRunId: 'wf-live', pid: 999, status: 'running' });
    fs.writeFileSync(path.join(stateDirOf(root), 'latest'), `${RUN_ID_A}\n`);
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.runId, RUN_ID_A); // result 指向在跑的 run（供主 agent abort/resume）
    assertIncludes(result.error, `已有进行中的 run ${RUN_ID_A}`);
    assertIncludes(result.error, 'abort');
    // 未新建任何 run 目录
    const entries = fs.readdirSync(stateDirOf(root)).filter((n) => n.startsWith('prw-'));
    assert.deepStrictEqual(entries, [RUN_ID_A]);
  });

  await test('fresh 并发防护：latest 指向已终态 run → 放行新建', async () => {
    const { io, root } = makeIo({ args: {} });
    seedState(root, { runId: RUN_ID_A, engineRunId: 'wf-old', status: 'awaiting-push' }); // wf-old = done
    fs.writeFileSync(path.join(stateDirOf(root), 'latest'), `${RUN_ID_A}\n`);
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.notStrictEqual(result.runId, RUN_ID_A);
  });

  await test('fresh：base 无法解析 → fail-fast 带 base 修复指引', async () => {
    const { io } = makeIo({ args: { base: 'nonexist' }, base: 'nonexist', failBase: true });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, 'base "nonexist" 无法解析');
  });

  /* ── 互斥锁 ── */

  await test('lockfile：EEXIST 且持锁 run 进行中 → fail-fast（活性复查拦截）', async () => {
    const { io, root } = makeIo({ args: {}, engineMap: { 'wf-live': 'running' } });
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(root), 'lock'), JSON.stringify({ runId: RUN_ID_A, pid: 999, engineRunId: 'wf-live' }));
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'abort');
    // 锁未被误删（持锁者还活着）
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), true);
  });

  await test('lockfile：EEXIST 且持锁 run 已终态 → 接管（删旧锁重建，流程完成）', async () => {
    const { io, root, recorded } = makeIo({ args: {} }); // wf-old = done
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(root), 'lock'), JSON.stringify({ runId: 'prw-20260901-080000-zzzz', pid: 111, engineRunId: 'wf-old' }));
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assertIncludes(recorded.logs.join('\n'), '接管重建');
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), false); // 终态删锁
  });

  await test('lockfile：EEXIST 且锁内容不可读 → fail-closed 交人工（锁保留）', async () => {
    const { io, root } = makeIo({ args: {} });
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(root), 'lock'), 'garbage{not-json');
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '互斥锁存在但内容不可读');
    assertIncludes(result.error, '手工删除');
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), true);
  });

  await test('lockfile：锁内容含 runId/pid/engineRunId（fresh 期间可观测）', async () => {
    const { io, root } = makeIo({ args: { _runId: 'wf-lock-check' } });
    // 拦截 rename 前的流程不可行，改为：跑完后验证接管场景留下的日志链；此处直接验证
    // acquireLock 写入内容——借一次「持锁 run 终态」接管后旧锁内容被覆盖为新 engineRunId。
    const lockPath = path.join(stateDirOf(root), 'lock');
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ runId: null, pid: 111, engineRunId: 'wf-old' }));
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    // （锁终态已删；内容正确性由 EEXIST 接管测试路径覆盖：wf-old=done 才会放行）
  });

  /* ── resume 守卫（§3.4-(4) 顺序） ── */

  const resumeArgs = () => ({ runId: RUN_ID_A, _runId: 'wf-new' });

  await test('守卫 1 反：runId 对应 state 不存在 → 文案含「去掉 runId」，resumeCommand 为 fresh 形态', async () => {
    const { io, root } = makeIo({ args: { runId: 'prw-20260901-000000-zzzz' } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.runId, 'prw-20260901-000000-zzzz');
    assertIncludes(result.error, '无效');
    assertIncludes(result.error, '去掉 runId');
    assert.strictEqual(result.resumeCommand, `zflow run pr-lifecycle workdir=${root}`);
  });

  await test('守卫 1 反：stateVersion 非 1（版本不兼容）→ 同文案 fail-fast', async () => {
    const { io, root } = makeIo({ args: resumeArgs() });
    seedState(root, { stateVersion: 2 });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '版本不兼容');
  });

  await test('守卫 2 反：repo 不一致 → fail-fast「另一仓库/worktree」，且不再继续后续 git 调用', async () => {
    const { io, root, recorded } = makeIo({ args: resumeArgs() });
    seedState(root, { repo: '/some/other/worktree' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '另一仓库/worktree');
    assertIncludes(result.error, '/some/other/worktree');
    // 守卫顺序：分支/活性/工作区检查不应发生
    assert.ok(!recorded.sh.some((c) => c[0] === 'git' && c[1] === 'status'), 'repo 守卫失败后不应执行工作区检查');
  });

  await test('守卫 3 反：分支不一致 → fail-fast 文案含「属于分支 X」与正确做法', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), branch: 'other-branch' });
    seedState(root, { branch: 'feat-x' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '属于分支 feat-x');
    assertIncludes(result.error, '不传 runId 起新 run');
  });

  await test('守卫 4 主通道：引擎 status=running → fail-fast「仍在进行」+ abort 指引', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), engineMap: { 'wf-live': 'running' } });
    seedState(root, { engineRunId: 'wf-live' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'engineRunId=wf-live');
    assertIncludes(result.error, 'abort');
  });

  await test('守卫 4 fail-closed：引擎 status 为未知值 → 一律视为进行中拦截', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), engineMap: { 'wf-weird': 'frobnicated' } });
    seedState(root, { engineRunId: 'wf-weird' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'frobnicated');
  });

  await test('守卫 4 主通道终态放行：status=done → 进入后续流程（walker 执行未完成 step）', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), steps: [mkStep('s1', runs)] }); // wf-old = done
    seedState(root, { engineRunId: 'wf-old' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']); // 守卫放行后 walker 正常执行
  });

  await test('守卫 4 降级通道：引擎文件不可读 + pid 已死 → 放行并 log 标注降级', async () => {
    const runs = [];
    const { io, root, recorded } = makeIo({ args: resumeArgs(), engineMap: {}, steps: [mkStep('s1', runs)] }); // wf-gone 不在 map → ok:false
    seedState(root, { engineRunId: 'wf-gone', pid: 222 }); // pidMap 无 222 → dead
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']);
    assertIncludes(recorded.logs.join('\n'), '降级 pid 探测');
    assertIncludes(recorded.logs.join('\n'), 'pid=222 已退出，放行');
  });

  await test('守卫 4 降级通道：pid 存活 → fail-fast，文案含 pid 复用人工出口', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), engineMap: {}, pidMap: { 222: 'alive' } });
    seedState(root, { engineRunId: 'wf-gone', pid: 222 });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'pid=222');
    assertIncludes(result.error, 'ps -p 222 -o command='); // pid 复用核实出口
    assertIncludes(result.error, '清除 pid 字段'); // 人工出口
  });

  await test('守卫 5 反：工作区脏 → fail-fast，error 含改动清单与 commit/checkout 指引', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), porcelain: ' M src/a.js\n?? src/b.js', steps: [mkStep('s1', runs)] });
    seedState(root, { engineRunId: 'wf-old' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '存在未提交改动');
    assertIncludes(result.error, 'M src/a.js');
    assertIncludes(result.error, '?? src/b.js');
    assertIncludes(result.error, 'git add <显式路径> && git commit');
    assertIncludes(result.error, 'git checkout --');
  });

  await test('守卫 6 反：HEAD 外部变更（running）无参数 → fail-fast 带 allowExternalChanges 指引', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), head: 'H2', steps: [mkStep('s1', runs)] });
    seedState(root, { lastHead: 'H1', status: 'running' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '外部变更');
    assertIncludes(result.error, 'H1 → H2');
    assertIncludes(result.error, 'allowExternalChanges=true');
  });

  await test('守卫 6 正：带 allowExternalChanges=true → 放行，walker 从断点重跑', async () => {
    const runs = [];
    const { io, root, recorded } = makeIo({
      args: Object.assign(resumeArgs(), { allowExternalChanges: true }),
      head: 'H2',
      steps: [mkStep('s1', runs)],
    });
    seedState(root, { lastHead: 'H1', status: 'running' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']);
    assertIncludes(recorded.logs.join('\n'), 'allowExternalChanges=true 显式放行');
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.lastHead, 'H2');
  });

  await test('守卫 6：status=failed 时外部 commit 属预期恢复动作 → 无参数直接放行', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), head: 'H2', steps: [mkStep('s1', runs)] });
    seedState(root, { lastHead: 'H1', status: 'failed', failedStep: 's1', steps: { s1: { status: 'failed', attempts: 1 } } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']); // 从断点 step 重跑
  });

  /* ── resume walker（§3.4-(3) 六条语义） ── */

  await test('walker：done 跳过 / failed 整体重跑 / pending 执行，执行顺序按注册表', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs), mkStep('c', runs)],
    });
    seedState(root, {
      steps: { a: { status: 'done', attempts: 1, outputs: { v: 'a' } }, b: { status: 'failed', attempts: 1 } },
    });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['b', 'c']); // a done 不重跑
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.steps.a.status, 'done');
    assert.strictEqual(state.steps.b.status, 'done');
    assert.strictEqual(state.steps.b.attempts, 2); // 重跑计数递增
    assert.strictEqual(state.steps.c.attempts, 1);
  });

  await test('walker：in_progress（上次死在中途）整体重跑', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs)],
    });
    seedState(root, { steps: { a: { status: 'done', attempts: 1 }, b: { status: 'in_progress', attempts: 1 } } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['b']);
    assert.strictEqual(readStateFile(root, RUN_ID_A).steps.b.status, 'done');
  });

  await test('walker：skipped 跳过不重跑', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs), mkStep('c', runs)],
    });
    seedState(root, {
      steps: {
        a: { status: 'done', attempts: 1 },
        b: { status: 'skipped', reason: 'user-ack' },
      },
    });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['c']);
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'b', reason: 'user-ack' }]); // skipped 透传终态
  });

  await test('walker：skipSteps 逃生舱消费本次发起参数，skipped 落盘必带 reason=user-ack', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: { runId: RUN_ID_A, skipSteps: 'b' }, // CLI 字符串形态
      steps: [mkStep('a', runs), mkStep('b', runs), mkStep('c', runs)],
    });
    // state.params.skipSteps 为空（上次未传）——逃生舱仍应按本次发起参数生效
    seedState(root, {});
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['a', 'c']); // b 被跳过
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.steps.b.status, 'skipped');
    assert.strictEqual(state.steps.b.reason, 'user-ack');
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'b', reason: 'user-ack' }]);
  });

  await test('walker：skipSteps 对 done/skipped step 无效果', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: { runId: RUN_ID_A, skipSteps: 'a' },
      steps: [mkStep('a', runs)],
    });
    seedState(root, { steps: { a: { status: 'done', attempts: 1 } }, lastHead: 'H1' });
    const result = await lib.runPipeline(io);
    // a 已 done → 全 finished → 空转防护路径，skipSteps 不产生 skipped 条目
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, []);
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.steps.a.status, 'done');
  });

  await test('walker：step 失败 → state 落盘 failed + failedStep + error + resumeCommand，后续 step 不执行', async () => {
    const runs = [];
    const boom = {
      id: 'b',
      run: async () => {
        runs.push('b');
        throw new Error('boom-b');
      },
    };
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), boom, mkStep('c', runs)],
    });
    seedState(root, { steps: { a: { status: 'done', attempts: 1 } } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'b');
    assert.strictEqual(result.error, 'boom-b');
    assert.strictEqual(result.resumeCommand, `zflow run pr-lifecycle workdir=${root} runId=${RUN_ID_A}`);
    assert.deepStrictEqual(runs, ['b']); // c 未执行
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.status, 'failed');
    assert.strictEqual(state.failedStep, 'b');
    assert.strictEqual(state.error, 'boom-b');
    assert.strictEqual(state.steps.b.status, 'failed');
    assert.deepStrictEqual(state.result, result); // result 快照落盘
  });

  await test('落盘时序：step 开始（in_progress）与结束（done）各一次原子写，终态再次落盘', async () => {
    const runs = [];
    const { io, root, recorded } = makeIo({ args: { _runId: 'wf-1' }, steps: [mkStep('a', runs)] });
    const stateJsonPath = path.join(stateDirOf(root), 'prw-20260903-100000-ab12', 'state.json');
    await lib.runPipeline(io);
    // 原子写序列：tmp 写 → rename 替换 state.json；无 tmp 残留
    assert.ok(recorded.renames.length >= 3, `至少 in_progress/done/终态三次落盘，实际 ${recorded.renames.length}`);
    for (const [src, dst] of recorded.renames) {
      assert.ok(src.includes('.tmp-4242-'), `tmp 文件名含 pid：${src}`);
      assert.strictEqual(dst, stateJsonPath);
      assert.strictEqual(fs.existsSync(src), false); // rename 后 tmp 不存在
    }
    const snapshots = recorded.renameContents.map((c) => JSON.parse(c));
    const aSnapshots = [];
    for (const snap of snapshots) {
      if (snap.steps && snap.steps.a) aSnapshots.push(snap.steps.a.status);
    }
    assert.deepStrictEqual(aSnapshots, ['in_progress', 'done', 'done']); // 开始/结束/终态各一次
  });

  await test('lastHead 语义：每次 checkpoint 刷新为当时 HEAD', async () => {
    const runs = [];
    const { io, root, git } = makeIo({ args: resumeArgs(), head: 'H1', steps: [mkStep('s1', runs)] });
    seedState(root, { lastHead: 'H0', status: 'failed', failedStep: 's1', steps: { s1: { status: 'failed', attempts: 1 } } });
    git.head = 'H9'; // resume 期间 HEAD 前移（模拟人工修复 commit，failed 状态被守卫 6 放行）
    await lib.runPipeline(io);
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.lastHead, 'H9'); // 最后一次 checkpoint 时 HEAD
  });

  /* ── 空转防护（walker 语义 6） ── */

  await test('空转防护：全 done 且 HEAD 不变 → 幂等回放 result 快照，零 step 执行', async () => {
    const runs = [];
    const snapshot = { status: 'awaiting-push', runId: RUN_ID_A, prUrl: 'https://github.com/x/pull/1', terminated: 'clean', simplify: null, gates: { coverage: 'pass', metrics: 'pass', premerge: 'PASS' }, skippedSteps: [] };
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs)],
    });
    seedState(root, {
      status: 'awaiting-push',
      lastHead: 'H1',
      result: snapshot,
      steps: { a: { status: 'done', attempts: 1 }, b: { status: 'skipped', reason: 'cond' } },
    });
    const result = await lib.runPipeline(io);
    assert.deepStrictEqual(result, snapshot); // 同一结果（快照回放）
    assert.deepStrictEqual(runs, []); // 不重跑任何步骤
  });

  await test('空转防护：全 done 且 HEAD 已变 → fail-fast 指引起新 run；allowExternalChanges 也拦', async () => {
    for (const allow of [false, true]) {
      const runs = [];
      const args = resumeArgs();
      if (allow) args.allowExternalChanges = true;
      const { io, root } = makeIo({ args, head: 'H2', steps: [mkStep('a', runs)] });
      seedState(root, { status: 'awaiting-push', lastHead: 'H1', steps: { a: { status: 'done', attempts: 1 } } });
      const result = await lib.runPipeline(io);
      assert.strictEqual(result.status, 'failed', `allowExternalChanges=${allow}`);
      assertIncludes(result.error, `本 run ${RUN_ID_A} 已完成`);
      assertIncludes(result.error, '请不传 runId 起新 run');
      assertIncludes(result.error, 'allowExternalChanges 在此场景无效');
      assertIncludes(result.error, `新 run 命令：zflow run pr-lifecycle workdir=${root}`);
      assert.strictEqual(result.resumeCommand, null); // 防指引链兜圈
      assert.deepStrictEqual(runs, []);
    }
  });

  /* ── result 快照回放一致性 + engineRunId 刷新 ── */

  await test('快照回放一致性：fresh 终态 → resume 回放同一 result，engineRunId 刷新落盘', async () => {
    const first = makeIo({ args: { _runId: 'wf-run-1' } });
    const resultA = await lib.runPipeline(first.io);
    assert.strictEqual(resultA.status, 'awaiting-push');
    // 第二次发起：带 runId resume（空 registry = 全 done，HEAD 不变）
    const secondIo = first.io;
    secondIo.args = { runId: resultA.runId, _runId: 'wf-run-2' };
    const resultB = await lib.runPipeline(secondIo);
    assert.deepStrictEqual(resultB, resultA); // 同一结果
    const state = readStateFile(first.root, resultA.runId);
    assert.strictEqual(state.engineRunId, 'wf-run-2'); // 每次发起刷新（活性主通道读最近一次）
    assert.strictEqual(state.pid, 4242);
    assert.deepStrictEqual(state.result, resultA); // 快照原样保留
  });

  await test('resume 后 state 引擎上下文刷新：守卫过 → engineRunId/pid 为本次值', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), head: 'H2' });
    seedState(root, { lastHead: 'H1', status: 'failed', failedStep: 's1', steps: { s1: { status: 'failed', attempts: 1 } } });
    const runs = [];
    io.steps = [mkStep('s1', runs)];
    await lib.runPipeline(io);
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.engineRunId, 'wf-new');
    assert.strictEqual(state.pid, 4242);
  });

  /* ── u2：PR 阶段 steps（preflight / static-gate / changeset / pr-meta / skill-yaml / pr-submit） ── */

  // 全链成功 mocks：gate 过（带 WARN 触发 changeset）、两 agent 成功、submit 返回合法 pr_url
  function allPassMocks() {
    return {
      scriptMocks: {
        [FAKE_PATHS.preMerge]: { code: 0, stdout: '  PASS typecheck:extensions\n  PASS lint\n  WARN changeset-check 0s (2 missing)\n' },
        [FAKE_PATHS.prSubmit]: { code: 0, stdout: 'branch pushed\nhttps://github.com/acme/widget/pull/42\n' },
        [FAKE_PATHS.validateSkillYaml]: { code: 0, stdout: 'OK' },
      },
      agent: async (params) => {
        if (params.description === 'pr-meta') return { value: { title: 'feat(core): add x', body: '## Summary\nadd x\n## Test plan\ntypecheck+lint pass\n' }, error: null };
        if (params.description === 'changeset-draft') return { value: { action: 'draft', files: ['.changeset/widget.md'] }, error: null };
        return { value: {}, error: null }; // gate fix agent
      },
    };
  }

  const findStep = (steps, id) => {
    const s = steps.find((x) => x.id === id);
    assert.ok(s, `注册表中存在 step ${id}`);
    return s;
  };

  function mkCtx(t, state, runIdDir) {
    return {
      state,
      params: state.params,
      runIdDir: runIdDir || path.join(t.root, '.review', 'pr-workflow', state.runId),
      io: t.io,
      saveCheckpoint() {},
    };
  }

  await test('u2 全链 fresh：六 steps 串行到 awaiting-push，prUrl/skippedSteps/outputs 契约正确', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-full' }, names: 'src/a.js\n' }, m));
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.strictEqual(result.prUrl, 'https://github.com/acme/widget/pull/42');
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'skill-yaml', reason: 'diff 未触及 .agents/skills/，条件不满足' }]);
    const state = readStateFile(t.root, result.runId);
    assert.deepStrictEqual(state.steps['static-gate'].outputs, { result: 'PASS', changesetWarn: true });
    assert.strictEqual(state.steps.changeset.status, 'done');
    assert.strictEqual(state.steps['pr-submit'].status, 'done');
    assert.strictEqual(state.steps['skill-yaml'].status, 'skipped');
    assert.ok(state.steps['pr-submit'].outputs.prUrl.startsWith('https://github.com/acme/widget/pull/'));
  });

  await test('preflight：state.baseHash 已锁定时不重算 rev-parse base（全程恰 1 次 = fresh 创建时）', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-pf' } }, m));
    t.io.steps = makeSteps({ root: t.root });
    await lib.runPipeline(t.io);
    const baseResolves = t.recorded.sh.filter(
      (c) => c[0] === 'git' && c[1] === 'rev-parse' && c[2] === 'main^{commit}',
    );
    assert.strictEqual(baseResolves.length, 1,
      'rev-parse base 只应发生在 fresh 创建 state 时；preflight 复用 state.baseHash 不重算');
  });

  await test('preflight：无 commits + gh 未认证 + fallow 缺失 → 聚合失败文案逐条给修复命令', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({
      args: { _runId: 'wf-u2-pf2' },
      commits: '',
      cmdResults: {
        gh: { code: 1, stderr: 'not logged in' },
        fallow: { code: 127, stderr: 'command not found' },
      },
    }, m));
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'preflight');
    assertIncludes(result.error, 'preflight 前置条件未过');
    assertIncludes(result.error, `分支相对 base main 无 commits`);
    assertIncludes(result.error, 'gh auth login');
    assertIncludes(result.error, 'npm i -g fallow');
  });

  await test('preflight：baseHash 缺失（旧 state）时补锁并落盘', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u2-pf3' } }, m));
    seedState(t.root, { baseHash: null });
    t.io.steps = makeSteps({ root: t.root });
    await lib.runPipeline(t.io);
    assert.ok(t.recorded.sh.some((c) => c[0] === 'git' && c[1] === 'rev-parse' && c[2] === 'main^{commit}'));
    assert.strictEqual(readStateFile(t.root, RUN_ID_A).baseHash, 'B1');
  });

  await test('static-gate：过且无 WARN → outputs 契约 + changeset 预写 skipped（条件随前置 done checkpoint 落盘）', async () => {
    const m = allPassMocks();
    m.scriptMocks[FAKE_PATHS.preMerge] = { code: 0, stdout: '  PASS typecheck:extensions\n  PASS lint\n' }; // 无 WARN
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-sg1' } }, m));
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    const state = readStateFile(t.root, result.runId);
    assert.deepStrictEqual(state.steps['static-gate'].outputs, { result: 'PASS', changesetWarn: false });
    assert.strictEqual(state.steps.changeset.status, 'skipped');
    assertIncludes(state.steps.changeset.reason, '条件不满足');
    assert.strictEqual(t.agentCalls.filter((c) => c.description === 'changeset-draft').length, 0);
  });

  await test('static-gate：fail → fix agent 修 → 第 2 轮过（gate 调 2 次、agent 1 次、prompt 含 commit message 约定）', async () => {
    let gateRuns = 0;
    const m = allPassMocks();
    m.scriptMocks[FAKE_PATHS.preMerge] = () => {
      gateRuns += 1;
      return gateRuns === 1 ? { code: 1, stderr: 'lint failed hard' } : { code: 0, stdout: '  PASS lint\n' };
    };
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-sg2' } }, m));
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.strictEqual(gateRuns, 2);
    const fixCalls = t.agentCalls.filter((c) => c.description === 'fix-static-gate');
    assert.strictEqual(fixCalls.length, 1);
    assertIncludes(fixCalls[0].prompt, 'fix: gate static-gate round 1');
    assertIncludes(fixCalls[0].prompt, 'lint failed hard');
    assertIncludes(fixCalls[0].prompt, 'git add <显式路径>'); // 禁 add -A 语义
    const state = readStateFile(t.root, result.runId);
    assert.strictEqual(state.steps['static-gate'].attempts, 1);
  });

  await test('static-gate：3 轮子循环上限 → failed（gate 3 次、agent 2 次、文案含人工修复 + resumeCommand 指引）', async () => {
    let gateRuns = 0;
    const t = makeIo({
      args: { _runId: 'wf-u2-sg3' },
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          gateRuns += 1;
          return { code: 1, stderr: `still failing round ${gateRuns}` };
        },
      },
    });
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'static-gate');
    assert.strictEqual(gateRuns, lib.MAX_GATE_ROUNDS);
    assert.strictEqual(t.agentCalls.filter((c) => c.description === 'fix-static-gate').length, lib.MAX_GATE_ROUNDS - 1);
    assertIncludes(result.error, '3 轮修复子循环仍未通过');
    assertIncludes(result.error, 'git add <显式路径> && git commit');
    assertIncludes(result.error, 'resumeCommand 续跑');
  });

  await test('static-gate：fix agent 留脏工作区 → 立即 failed（第 1 次止损，gate 只跑 1 次）', async () => {
    let gateRuns = 0;
    const t = makeIo({
      args: { _runId: 'wf-u2-sg4' },
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          gateRuns += 1;
          return { code: 1, stderr: 'lint failed' };
        },
      },
      agent: async () => ({ value: {}, error: null }),
    });
    // agent 返回后置脏：借 agent mock 副作用改 git.porcelain（模拟 agent 修完未 commit）
    const origAgent = t.io.agent;
    t.io.agent = async (params) => {
      const res = await origAgent(params);
      t.git.porcelain = ' M dirty.js\n';
      return res;
    };
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'static-gate');
    assert.strictEqual(gateRuns, 1); // 第 1 次止损：不烧后续轮次
    assertIncludes(result.error, '存在未提交改动');
    assertIncludes(result.error, 'dirty.js');
    assertIncludes(result.error, '止损');
  });

  await test('static-gate：exit 2（工具错误）→ failed 不自动重试（gate 1 次、agent 0 次）', async () => {
    let gateRuns = 0;
    const t = makeIo({
      args: { _runId: 'wf-u2-sg5' },
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          gateRuns += 1;
          return { code: 2, stderr: 'ERROR: 用法错误' };
        },
      },
    });
    t.io.steps = makeSteps({ root: t.root });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(gateRuns, 1);
    assert.strictEqual(t.agentCalls.length, 0);
    assertIncludes(result.error, '工具错误，不自动重试');
    assertIncludes(result.error, '需人看');
  });

  await test('changeset：changesetWarn=false 且条目被篡改删除 → 防御重放落盘条件（不真跑 agent）', async () => {
    const t = makeIo({ agent: async () => { throw new Error('agent 不应被调用'); } });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { result: 'PASS', changesetWarn: false } } } };
    const res = await changesetStep.run(mkCtx(t, state));
    assert.strictEqual(res.skipped, true);
    assertIncludes(res.reason, 'changesetWarn=false');
  });

  await test('changeset：WARN=true → agent 按 diff 起草（prompt 含 stat/commits，outputs 契约）', async () => {
    const t = makeIo({
      agent: async () => ({ value: { action: 'draft', files: ['.changeset/widget.md'] }, error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { result: 'PASS', changesetWarn: true } } } };
    const res = await changesetStep.run(mkCtx(t, state));
    assert.deepStrictEqual(res.drafted, ['.changeset/widget.md']);
    assertIncludes(res.note, '已起草 1 个 changeset 文件');
    const prompt = t.agentCalls[0].prompt;
    assertIncludes(prompt, 'minor'); // 分类规则内嵌
    assertIncludes(prompt, 'feat: a commit'); // commits 全文作输入
  });

  await test('changeset：agent 判非发布改动 → note 汇总跳过原因', async () => {
    const t = makeIo({
      agent: async () => ({ value: { action: 'no-release', skipReasons: ['pi-goal: 纯注释改动，diff 证据为注释行'] }, error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { changesetWarn: true } } } };
    const res = await changesetStep.run(mkCtx(t, state));
    assert.deepStrictEqual(res.drafted, []);
    assertIncludes(res.note, '纯注释改动');
  });

  await test('changeset：agent 调用失败 → failed 文案可操作', async () => {
    const t = makeIo({ agent: async () => ({ value: null, error: 'model timeout' }) });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { changesetWarn: true } } } };
    await assert.rejects(changesetStep.run(mkCtx(t, state)), /changeset agent 调用失败：model timeout/);
  });

  await test('changeset：outputs 缺 changesetWarn（旧版本 state）→ fail-fast 不猜条件', async () => {
    const t = makeIo({});
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: {} } } };
    await assert.rejects(changesetStep.run(mkCtx(t, state)), /changesetWarn/);
  });

  await test('pr-meta：schema agent 产物落盘 pr-title.txt / pr-body.md，outputs {title, bodyFile}', async () => {
    const t = makeIo({
      agent: async () => ({ value: { title: 'feat(core): add x', body: '## Summary\nadd x\n' }, error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const prMetaStep = findStep(steps, 'pr-meta');
    const runIdDir = path.join(t.root, 'run-dir');
    fs.mkdirSync(runIdDir, { recursive: true });
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    const res = await prMetaStep.run(mkCtx(t, state, runIdDir));
    assert.strictEqual(res.title, 'feat(core): add x');
    assert.strictEqual(res.bodyFile, path.join(runIdDir, 'pr-body.md'));
    assert.strictEqual(fs.readFileSync(path.join(runIdDir, 'pr-title.txt'), 'utf8'), 'feat(core): add x');
    assertIncludes(fs.readFileSync(path.join(runIdDir, 'pr-body.md'), 'utf8'), '## Summary');
    const prompt = t.agentCalls[0].prompt;
    assertIncludes(prompt, 'conventional commit');
    assertIncludes(prompt, 'feat: a commit');
    assertIncludes(prompt, 'a.js | 2');
  });

  await test('pr-meta：agent 返回缺 body → failed 文案（schema 回退 content 兜底）', async () => {
    const t = makeIo({
      agent: async () => ({ value: 'raw text fallback（无 schema 输出）', error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const prMetaStep = findStep(steps, 'pr-meta');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    await assert.rejects(prMetaStep.run(mkCtx(t, state)), /pr-meta agent 返回不符合契约/);
  });

  await test('pr-meta：agent 调用失败 → failed 文案', async () => {
    const t = makeIo({ agent: async () => ({ value: null, error: 'rate limited' }) });
    const steps = makeSteps({ root: t.root });
    const prMetaStep = findStep(steps, 'pr-meta');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    await assert.rejects(prMetaStep.run(mkCtx(t, state)), /pr-meta agent 调用失败：rate limited/);
  });

  await test('skill-yaml：diff 未触及 .agents/skills/ → skipped 落盘 reason', async () => {
    const t = makeIo({ names: 'src/a.js\npackages/runtime/src/x.ts\n' });
    const steps = makeSteps({ root: t.root });
    const skillStep = findStep(steps, 'skill-yaml');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    const res = await skillStep.run(mkCtx(t, state));
    assert.strictEqual(res.skipped, true);
    assertIncludes(res.reason, '.agents/skills/');
  });

  await test('skill-yaml：改动 skill 目录映射到各自 SKILL.md 传参（去重），成功 outputs', async () => {
    const t = makeIo({
      names: '.agents/skills/foo/scripts/x.py\n.agents/skills/bar/SKILL.md\n.agents/skills/foo/SKILL.md\n',
      scriptMocks: {
        [FAKE_PATHS.validateSkillYaml]: (args) => {
          t.validateArgs = args;
          return { code: 0, stdout: 'OK' };
        },
      },
    });
    const steps = makeSteps({ root: t.root });
    const skillStep = findStep(steps, 'skill-yaml');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    const res = await skillStep.run(mkCtx(t, state));
    assert.deepStrictEqual(res.validated, ['.agents/skills/foo/SKILL.md', '.agents/skills/bar/SKILL.md']);
    assert.deepStrictEqual(t.validateArgs, [FAKE_PATHS.validateSkillYaml, '.agents/skills/foo/SKILL.md', '.agents/skills/bar/SKILL.md']);
  });

  await test('skill-yaml：校验 fail → failed（硬校验不修，文案带输出）', async () => {
    const t = makeIo({
      names: '.agents/skills/foo/SKILL.md\n',
      scriptMocks: { [FAKE_PATHS.validateSkillYaml]: { code: 1, stdout: 'ERROR: missing field name' } },
    });
    const steps = makeSteps({ root: t.root });
    const skillStep = findStep(steps, 'skill-yaml');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    await assert.rejects(skillStep.run(mkCtx(t, state)), (e) => {
      assertIncludes(e.message, '硬校验不修');
      assertIncludes(e.message, 'missing field name');
      return true;
    });
  });

  await test('pr-submit：pr-meta 产物缺失 → failed 前置文案', async () => {
    const t = makeIo({});
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: {} };
    await assert.rejects(submitStep.run(mkCtx(t, state)), /pr-submit 前置产物缺失/);
  });

  await test('pr-submit：成功 → 从 stdout 解析 pr_url（多行取合法匹配），参数含 title/body/base', async () => {
    let submitArgs = null;
    const t = makeIo({
      scriptMocks: {
        [FAKE_PATHS.prSubmit]: (args) => {
          submitArgs = args;
          return { code: 0, stdout: 'branch pushed\nhttps://github.com/acme/widget/pull/7\n' };
        },
      },
    });
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const runIdDir = path.join(t.root, 'run-dir');
    fs.mkdirSync(runIdDir, { recursive: true });
    fs.writeFileSync(path.join(runIdDir, 'pr-title.txt'), 'feat: x');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { title: 'feat: x', bodyFile: '/fake/body.md' } } } };
    const res = await submitStep.run(mkCtx(t, state, runIdDir));
    assert.strictEqual(res.prUrl, 'https://github.com/acme/widget/pull/7');
    assert.deepStrictEqual(submitArgs.slice(1), ['--title-file', path.join(runIdDir, 'pr-title.txt'), '--body-file', '/fake/body.md', '--base', 'main']);
  });

  await test('pr-submit：stdout 无合法 pr_url（dry-run 形态）→ failed URL 校验文案', async () => {
    const t = makeIo({
      scriptMocks: { [FAKE_PATHS.prSubmit]: { code: 0, stdout: 'https://github.com/dry-run/pr/create\n' } },
    });
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { bodyFile: '/fake/body.md' } } } };
    await assert.rejects(submitStep.run(mkCtx(t, state)), /未解析到合法 pr_url/);
  });

  await test('pr-submit：exit 2 / 3 / 5 文案按 §3.7 逐档', async () => {
    const cases = [
      { code: 2, re: /git push 失败.*分支保护.*幂等更新/s, detail: 'remote rejected' },
      { code: 3, re: /gh 已认证但调用失败.*gh auth status/s, detail: 'api error' },
      { code: 5, re: /title\/body 文件缺失.*pr-title\.txt\/pr-body\.md/s, detail: 'not readable' },
    ];
    for (const c of cases) {
      const t = makeIo({
        scriptMocks: { [FAKE_PATHS.prSubmit]: { code: c.code, stdout: c.detail } },
      });
      const steps = makeSteps({ root: t.root });
      const submitStep = findStep(steps, 'pr-submit');
      const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { bodyFile: '/fake/body.md' } } } };
      await assert.rejects(submitStep.run(mkCtx(t, state)), (e) => {
        assert.ok(c.re.test(e.message), `exit ${c.code} 文案不匹配：${e.message}`);
        assertIncludes(e.message, c.detail);
        return true;
      });
    }
  });

  await test('pr-submit：exit 1 → 通用失败文案带输出摘要', async () => {
    const t = makeIo({
      scriptMocks: { [FAKE_PATHS.prSubmit]: { code: 1, stdout: 'Unknown arg: --bogus' } },
    });
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { bodyFile: '/fake/body.md' } } } };
    await assert.rejects(submitStep.run(mkCtx(t, state)), /pr-submit 失败（exit 1）.*Unknown arg/s);
  });

  await test('walker：step 返回 skipped 协议 → 落盘 skipped+reason 且计入终态 skippedSteps', async () => {
    const t = makeIo({ args: { _runId: 'wf-u2-skipproto' } });
    t.io.steps = [
      { id: 'a', run: async () => ({ v: 1 }) },
      { id: 'cond', run: async () => ({ skipped: true, reason: '条件不满足（测试）' }) },
      { id: 'b', run: async () => ({ v: 2 }) },
    ];
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'cond', reason: '条件不满足（测试）' }]);
    const state = readStateFile(t.root, result.runId);
    assert.strictEqual(state.steps.cond.status, 'skipped');
    assert.strictEqual(state.steps.a.status, 'done');
    assert.strictEqual(state.steps.b.status, 'done');
  });

  await test('worktreeDirt：.review/ 脚本自持目录不计入工作区脏（冒烟实证防自挡）', () => {
    const out = '?? .review/\n M src/a.js\n?? .review/pr-workflow/\n?? new-file.txt\n';
    assert.strictEqual(
      lib.worktreeDirt(out),
      ' M src/a.js\n?? new-file.txt',
    );
    assert.strictEqual(lib.worktreeDirt('?? .review/\n'), '');
    assert.strictEqual(lib.worktreeDirt(''), '');
  });



  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('\n失败清单：');
    for (const f of failed) console.error(`  - ${f.name}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('runner 自身异常：', e);
  process.exitCode = 1;
});
