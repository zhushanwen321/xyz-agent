'use strict';
/*
 * pr-lifecycle 状态核心单测（lib.cjs 头注释声明的 test/run-tests.js）。
 * 纯 node 直跑（对齐仓内红线：本目录不是 vitest 子包，workflow 自持资产不依赖
 * workspace 测试基建）：node test/run-tests.js，全绿 exit 0。
 * 全部外部效应经 mock io 注入（内存 fs + 路由式 sh），不依赖真实 git/shell。
 */

const assert = require('node:assert');
const path = require('node:path');
const lib = require(path.join(__dirname, '..', 'lib.cjs'));

/* ── mock 基建 ────────────────────────────────────────────────────────── */

// 内存 fs：覆盖 lib 用到的同步子集；openSync 'wx' 语义 = 已存在则抛 EEXIST
function createMemFs() {
  const files = new Map();
  const E = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    readFileSync: (p) => {
      if (!files.has(p)) throw E('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, String(data)); },
    renameSync: (from, to) => {
      if (!files.has(from)) throw E('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync: (p) => {
      if (!files.has(p)) throw E('ENOENT');
      files.delete(p);
    },
    openSync: (p, flag) => {
      if (flag === 'wx' && files.has(p)) throw E('EEXIST');
      const fd = { p, closed: false };
      files.set(p, '');
      return fd;
    },
    writeSync: (fd, data) => { files.set(fd.p, String(data)); },
    closeSync: (fd) => { fd.closed = true; },
    readdirSync: (p) => { throw E('ENOENT'); },
    realpathSync: (p) => p,
  };
}

// 路由式 sh：按 [cmd, ...args] 前缀查 handlers；未命中返回 code 127
function createSh(routes) {
  const calls = [];
  const sh = (cmd, args) => {
    calls.push([cmd, ...args]);
    for (const [prefix, handler] of routes) {
      if (cmd === prefix[0] && prefix.slice(1).every((a, i) => args[i] === a)) {
        const r = typeof handler === 'function' ? handler(args) : handler;
        return { code: 0, stdout: '', stderr: '', ...r };
      }
    }
    return { code: 127, stdout: '', stderr: `unrouted: ${cmd} ${args.join(' ')}` };
  };
  sh.calls = calls;
  return sh;
}

const REPO = '/repo/x';
const BRANCH = 'feat-x';
const HEAD = 'h1';

// 标准 git/gh/fallow 路由（stateDir 隔离用 path.relative 判 .review 前缀）
function standardGitRoutes(overrides = {}) {
  return [
    [['git', 'rev-parse', '--show-toplevel'], { stdout: `${REPO}\n` }],
    [['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: `${BRANCH}\n` }],
    [['git', 'rev-parse', 'HEAD'], { stdout: `${HEAD}\n` }],
    [['git', 'rev-parse', 'main^{commit}'], { stdout: 'bh1\n' }],
    [['git', 'status', '--porcelain'], { stdout: '' }],
    [['git', 'log'], overrides.gitLog || { stdout: 'abc1 commit msg\n' }],
    [['git', 'check-ignore', '--quiet'], { code: 1 }],
    [['gh', 'auth', 'status'], {}],
    [['fallow', '--version'], {}],
  ];
}

// 组装最小 io（steps 由用例注入）
function makeIo({ routes, steps, args = {} } = {}) {
  const logs = [];
  return {
    args,
    repoRoot: REPO,
    pid: 4321,
    fs: createMemFs(),
    sh: createSh(routes || standardGitRoutes()),
    readEngineState: () => ({ ok: false, reason: 'test: no engine state' }),
    probePid: () => 'dead',
    homedir: () => '/home/tester',
    log: (...m) => logs.push(m.join(' ')),
    logs,
    now: () => new Date(2026, 0, 2, 3, 4, 5), // 本地时区构造，与 RUN_ID 常量一致
    randomToken: () => 'aaaa',
    steps: steps || [],
  };
}

const stateDir = path.join(REPO, '.review', 'pr-workflow');
const stateFileOf = (runId) => path.join(stateDir, runId, 'state.json');
const RUN_ID = 'prw-20260102-030405-aaaa';

// 可编程 step 注册表：{ id, behavior: 'ok' | 'fail' | 'skipReason 字符串' }，可中途改 behavior
function makeSteps(defs) {
  return defs.map((d) => ({
    id: d.id,
    run: async () => {
      d.calls = (d.calls || 0) + 1;
      if (d.behavior === 'fail') throw new Error(`${d.id} boom`);
      if (typeof d.behavior === 'string' && d.behavior.startsWith('skip:')) {
        return { skipped: true, reason: d.behavior.slice(5) };
      }
      return { ok: true };
    },
  }));
}

/* ── 断言收集 ─────────────────────────────────────────────────────────── */

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL - ${name}\n  ${(e && e.stack) || e}`);
  }
}

/* ── 纯函数单测 ───────────────────────────────────────────────────────── */

async function main() {

await test('resolveRepoRoot：$ARGS.repo 优先 → $WORKSPACE → cwd 兜底', () => {
  assert.strictEqual(lib.resolveRepoRoot({ repo: '/a/b' }, '/w'), path.resolve('/a/b'));
  assert.strictEqual(lib.resolveRepoRoot({}, '/w'), path.resolve('/w'));
  assert.strictEqual(lib.resolveRepoRoot({ repo: '  ' }, '/w'), path.resolve('/w'));
  assert.strictEqual(lib.resolveRepoRoot({}, null), path.resolve('.'));
  assert.strictEqual(lib.resolveRepoRoot(null, null), path.resolve('.'));
});

await test('resolveRepoRoot 守卫链：runPipeline 对非仓库根 fail-fast', async () => {
  const routes = [
    [['git', 'rev-parse', '--show-toplevel'], { stdout: '/elsewhere\n' }],
  ];
  const io = makeIo({ routes });
  const res = await lib.runPipeline(io);
  assert.strictEqual(res.status, 'failed');
  assert.ok(res.error.includes('不是仓库根') || res.error.includes('toplevel') || /repo/i.test(res.error),
    `error 应指向 repoRoot 守卫：${res.error}`);
  // fail-fast 先于任何落盘：stateDir 不应被创建（内存 fs 下无该目录文件）
  assert.strictEqual([...io.fs.files.keys()].filter((p) => p.startsWith(stateDir)).length, 0);
});

await test('makeRunId/isValidRunId：格式与校验互逆', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5); // 本地时区构造，避免 TZ 相关断言漂移
  const pad = (n) => String(n).padStart(2, '0');
  const expect = `prw-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-zz09`;
  const id = lib.makeRunId(() => d, () => 'zz09');
  assert.strictEqual(id, expect);
  assert.ok(lib.isValidRunId(id));
  assert.ok(!lib.isValidRunId('prw-20260102-030405-ZZ09'));
  assert.ok(!lib.isValidRunId('xxx-1'));
});

await test('createState：字段顺序 = STATE_FIELDS（写盘契约）', () => {
  const state = lib.createState({
    runId: RUN_ID, repo: REPO, branch: BRANCH, base: 'main', baseHash: 'bh1',
    pid: 1, engineRunId: null, params: {}, head: HEAD,
  });
  assert.deepStrictEqual(Object.keys(state), lib.STATE_FIELDS);
  assert.strictEqual(state.status, 'running');
  assert.strictEqual(state.baseHash, 'bh1');
});

await test('createPrSteps：注册表 id 全序（§3.3 十二 step）', () => {
  const steps = lib.createPrSteps({ repoRoot: REPO });
  assert.deepStrictEqual(steps.map((s) => s.id), [
    'preflight', 'static-gate', 'changeset', 'pr-meta', 'skill-yaml', 'pr-submit',
    'constraints', 'coverage-1', 'metrics-1', 'cr-fix', 'simplify', 'final-gates',
  ]);
});

await test('constraints step：--base 传 baseHash（非 base ref 名）', async () => {
  const sh = createSh([
    [['git', 'rev-parse', '--show-toplevel'], { stdout: `${REPO}\n` }],
    [['git', 'status', '--porcelain'], { stdout: '' }],
    [['node', '/repo/x/scripts/select-constraints.mjs'], { stdout: 'ok\n' }],
  ]);
  const fsMock = createMemFs();
  fsMock.writeFileSync(path.join(REPO, '.review', 'constraints.md'), 'x');
  const steps = lib.createPrSteps({ repoRoot: REPO });
  const ctx = {
    state: { base: 'main', baseHash: 'bh99' },
    io: { sh, fs: fsMock, repoRoot: REPO },
    saveCheckpoint() {},
  };
  const out = await steps.find((s) => s.id === 'constraints').run(ctx);
  assert.ok(out.constraintsFile.endsWith('constraints.md'));
  const call = sh.calls.find((c) => c[0] === 'node');
  assert.ok(call, 'select-constraints 应被调用');
  assert.strictEqual(call[call.indexOf('--base') + 1], 'bh99', `--base 应传 baseHash，实际 ${call.join(' ')}`);
});

/* ── walker：fresh / resume / skipSteps（mock io 驱动状态机） ─────────── */

await test('fresh 全绿：终态 awaiting-push，state/latest 落盘，锁已删', async () => {
  const defs = [{ id: 'a', behavior: 'ok' }, { id: 'b', behavior: 'ok' }];
  const io = makeIo({ steps: makeSteps(defs) });
  const res = await lib.runPipeline(io);
  assert.strictEqual(res.status, 'awaiting-push');
  assert.strictEqual(res.runId, RUN_ID);
  assert.ok(io.fs.existsSync(stateFileOf(RUN_ID)));
  assert.strictEqual(io.fs.readFileSync(path.join(stateDir, 'latest'), 'utf8').trim(), RUN_ID);
  assert.ok(!io.fs.existsSync(path.join(stateDir, 'lock')), '终态应释放互斥锁');
  const state = JSON.parse(io.fs.readFileSync(stateFileOf(RUN_ID), 'utf8'));
  assert.strictEqual(state.status, 'awaiting-push');
  assert.strictEqual(state.steps.a.status, 'done');
});

await test('step 失败 → failed 终态带 resumeCommand；resume 从断点续跑且 done step 不重跑', async () => {
  const defs = [
    { id: 'a', behavior: 'ok' },
    { id: 'b', behavior: 'fail' },
    { id: 'c', behavior: 'ok' },
  ];
  const io1 = makeIo({ steps: makeSteps(defs) });
  const res1 = await lib.runPipeline(io1);
  assert.strictEqual(res1.status, 'failed');
  assert.strictEqual(res1.failedStep, 'b');
  assert.ok(res1.resumeCommand && res1.resumeCommand.includes('--runId'), '失败终态必含可复制 resumeCommand');
  const state1 = JSON.parse(io1.fs.readFileSync(stateFileOf(RUN_ID), 'utf8'));
  assert.strictEqual(state1.steps.a.status, 'done');
  assert.strictEqual(defs[0].calls, 1);

  // resume：b 修复（behavior 改 ok），共享同一份 fs 状态
  defs[1].behavior = 'ok';
  const io2 = makeIo({ args: { runId: RUN_ID }, steps: makeSteps(defs) });
  io2.fs = io1.fs;
  const res2 = await lib.runPipeline(io2);
  assert.strictEqual(res2.status, 'awaiting-push');
  assert.strictEqual(defs[0].calls, 1, 'done step 不得重跑（语义 2）');
  assert.strictEqual(defs[1].calls, 2, 'failed step resume 应整体重跑（语义 3）');
  const state2 = JSON.parse(io2.fs.readFileSync(stateFileOf(RUN_ID), 'utf8'));
  assert.strictEqual(state2.steps.b.status, 'done');
});

await test('resume 无效 runId：守卫 1 fail-fast（绝不悄悄新建）', async () => {
  const io = makeIo({ args: { runId: 'prw-19990101-000000-none' }, steps: makeSteps([{ id: 'a', behavior: 'ok' }]) });
  const res = await lib.runPipeline(io);
  assert.strictEqual(res.status, 'failed');
  assert.ok(res.error.includes('prw-19990101-000000-none'));
  assert.strictEqual(io.logs.length, 0);
});

await test('skipSteps 逃生舱：只标未完成 step，done 不动，终态逐项披露', async () => {
  const defs = [
    { id: 'a', behavior: 'ok' },
    { id: 'b', behavior: 'fail' },
  ];
  const io1 = makeIo({ steps: makeSteps(defs) });
  await lib.runPipeline(io1);
  assert.strictEqual(defs[0].calls, 1);

  const io2 = makeIo({
    args: { runId: RUN_ID, skipSteps: ['b'] },
    steps: makeSteps(defs),
  });
  io2.fs = io1.fs;
  const res = await lib.runPipeline(io2);
  assert.strictEqual(res.status, 'awaiting-push');
  assert.deepStrictEqual(res.skippedSteps, [{ step: 'b', reason: 'user-ack' }]);
  assert.strictEqual(defs[0].calls, 1, 'skipSteps 不得触碰已完成 step');
  assert.strictEqual(defs[1].calls, 1, '被 skip 的 step 不执行 run');
});

await test('resume 守卫 5：脏工作区拒绝续跑', async () => {
  const defs = [{ id: 'a', behavior: 'ok' }, { id: 'b', behavior: 'fail' }];
  const io1 = makeIo({ steps: makeSteps(defs) });
  await lib.runPipeline(io1);
  assert.strictEqual(defs[1].calls, 1);
  const dirtyRoutes = standardGitRoutes().map((r) => (
    r[0].join(' ') === 'git status --porcelain' ? [r[0], { stdout: ' M src/dirty.ts\n' }] : r
  ));
  const io2 = makeIo({ routes: dirtyRoutes, args: { runId: RUN_ID }, steps: makeSteps(defs) });
  io2.fs = io1.fs;
  const res = await lib.runPipeline(io2);
  assert.strictEqual(res.status, 'failed');
  assert.ok(res.error.includes('未提交改动'), `应拦截脏工作区：${res.error}`);
});

await test('条件 step run 内判定 skipped：带 reason 落盘并透传终态', async () => {
  const defs = [
    { id: 'a', behavior: 'ok' },
    { id: 'cond', behavior: 'skip:条件不满足（演示）' },
  ];
  const io = makeIo({ steps: makeSteps(defs) });
  const res = await lib.runPipeline(io);
  assert.strictEqual(res.status, 'awaiting-push');
  assert.deepStrictEqual(res.skippedSteps, [{ step: 'cond', reason: '条件不满足（演示）' }]);
  const state = JSON.parse(io.fs.readFileSync(stateFileOf(RUN_ID), 'utf8'));
  assert.strictEqual(state.steps.cond.status, 'skipped');
});

await test('全部 done 且 HEAD 未变：幂等回放既有终态（不重跑任何 step）', async () => {
  const defs = [{ id: 'a', behavior: 'ok' }];
  const io1 = makeIo({ steps: makeSteps(defs) });
  await lib.runPipeline(io1);
  const io2 = makeIo({ args: { runId: RUN_ID }, steps: makeSteps(defs) });
  io2.fs = io1.fs;
  const res = await lib.runPipeline(io2);
  assert.strictEqual(res.status, 'awaiting-push');
  assert.strictEqual(defs[0].calls, 1, '回放不得重跑 step');
});

/* ── exit ─────────────────────────────────────────────────────────────── */

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall tests passed');
}

}

main().catch((e) => { console.error(e); process.exitCode = 1; });
