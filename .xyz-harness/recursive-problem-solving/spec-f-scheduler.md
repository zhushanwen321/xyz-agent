# 子 Spec F：BFS 调度器与 workflow 脚本

> **父文档**：[spec.md](./spec.md) §12（决策与实现路径）、§13（第二轮审查）
> **范围**：F1（BFS 脚本设计）+ F3（依赖感知调度）+ F4（gate fail 超时保护）
> **依赖**：spec-w-worktree（worktree 复用机制）、spec-c-cw-enhancements（childUnitIds / frontier / handoff）

---

## 0. 问题回顾

- **F1**：BFS 脚本整体设计（§12.4 有框架，但需与 W2/C1 定稿后细化）
- **F3**：cw 的 `dependsOn` 只用于判环，不驱动执行。BFS 伪代码无拓扑排序。有依赖的 wave 并发会产出不可合并结果（§13 问题 G）
- **F4**：gate fail 时 agent 可能固执重试无上限（§11 新2），budget 无限（§12.2 回应 5）后唯一刹车是 wall-clock 超时

---

## 1. F1：BFS 脚本设计

### 整体结构

```javascript
// recursive-split.js
const meta = {
  name: "recursive-split",
  description: "递归拆分问题求解：cw 状态机 + 每 action 一个 agent + BFS 层级遍历",
  phases: ["init", "bfs", "done"]
};

const task = $ARGS.task;
const startLayer = $ARGS.startLayer ?? "slice";  // 决策 B：起点层
const LAYER_DEPTH = { epic: 0, feature: 1, slice: 2, wave: 3 };
const WAVE_DEPTH = 3;

phase("init");
const rootUnitId = await createRootUnit(startLayer, task);

phase("bfs");
const results = await bfsLoop(rootUnitId, LAYER_DEPTH[startLayer]);

phase("done");
return { status: "done", rootUnitId };
```

### BFS 主循环

```javascript
async function bfsLoop(rootUnitId, startDepth) {
  // 初始队列：根节点
  let queue = [{ unitId: rootUnitId, depth: startDepth, prompt: task, dependsOn: [] }];
  const visited = new Set();

  while (queue.length > 0) {
    // F3：拓扑排序，分出可并发组和必须串行的节点
    const { concurrent, sequential, remaining } = topoSort(queue, visited);

    // 可并发组（无相互依赖）：parallel 执行
    if (concurrent.length > 0) {
      const batchResults = await parallel(concurrent.map(node =>
        executeNodeActions(node)
      ));
      // 收集子节点
      queue = remaining.concat(extractChildren(batchResults));
    }

    // 必须串行的节点：逐个执行
    for (const node of sequential) {
      const result = await executeNodeActions(node);
      queue = remaining.concat(extractChildren([result]));
    }
  }
}

async function executeNodeActions(node) {
  const isWave = node.depth >= WAVE_DEPTH;
  const actions = isWave ? WAVE_ACTIONS : PLANNING_ACTIONS;
  let waveWorktreePath = null;
  let children = [];

  for (const action of actions) {
    const opts = {
      prompt: buildActionPrompt(node, action),
      schema: buildActionSchema(node, action, isWave),
      fork: true,
      timeoutMs: ACTION_TIMEOUT_MS,  // F4：超时保护
    };

    if (isWave) {
      if (action === actions[0] && !waveWorktreePath) {
        // wave 第一个 action：创建 worktree（W2）
        opts.worktree = true;
        opts.cwd = $WORKSPACE;
      } else {
        // 后续 action：复用 worktree（W2）
        opts.cwd = waveWorktreePath;
      }
    } else {
      // planning 层：共享主 cwd
      opts.cwd = $WORKSPACE;
    }

    const result = await agent(opts);

    // 第一个 action 后拿 worktree 路径（W2）
    if (isWave && action === actions[0]) {
      waveWorktreePath = worktreePath();
    }

    // execute 后拿子 unit id（C1）
    if (action === "execute" && result.children) {
      children = result.children;
    }
  }

  return { unitId: node.unitId, children, waveWorktreePath };
}
```

### Action prompt 构建

```javascript
function buildActionPrompt(node, action) {
  return `你是 cw 流程执行者。

任务：完成 WorkUnit ${node.unitId} 的 ${action} 操作。

步骤：
1. 先调 \`cw handoff --unitId ${node.unitId}\` 获取上下文（含前序 action 的产出 + 下一步 guidance + input schema）
2. 按 guidance 执行 ${action}（${actionHint(action)}）
3. 调 \`cw ${action} --unitId ${node.unitId} --input '<根据 guidance 的 schema 填写>'\` 推进状态
4. 如果 gate fail（返回 ok=false），读 mustFix 修正后重调步骤 3
5. 成功后返回结果

${actionSpecificHint(action, node)}`;
}

function actionHint(action) {
  const hints = {
    clarify: "澄清需求，填 clarifications（feature 还需填 FeatureSpec FR/AC）",
    plan: "拆分子任务，填 split（含 slug/description/dependsOn）",
    "design-review": "填 designReviewJudgment + layerSpecific（字段名见 guidance）",
    execute: "planning 层：cw 自动建子层 unit；wave 层：写代码并 git commit",
    test: "确保测试通过（cw 自动跑 npm test）",
    "exec-review": "审查代码质量",
    retrospect: "复盘（planning 层读子层 session jsonl 做真实验收）",
    closeout: "冻结交付物",
  };
  return hints[action] ?? "";
}
```

### Action schema 构建

```javascript
function buildActionSchema(node, action, isWave) {
  // execute 后返回 children（planning 层）或业务字段（wave closeout）
  if (!isWave && action === "execute") {
    return {
      type: "object",
      properties: {
        children: {
          type: "array",
          items: {
            type: "object",
            properties: {
              unitId: { type: "string", description: "cw 自动创建的子 unit id（从 cw execute 返回值拿）" },
              prompt: { type: "string", description: "给下一层 agent 的执行 prompt" },
              dependsOn: { type: "array", items: { type: "string" }, description: "依赖的兄弟 unitId" },
            },
          },
        },
      },
    };
  }
  if (isWave && action === "closeout") {
    return {
      type: "object",
      properties: {
        commitHash: { type: "string" },
        summary: { type: "string" },
      },
    };
  }
  // 其他 action：简单 done 标记
  return { type: "object", properties: { done: { type: "boolean" } } };
}
```

---

## 2. F3：依赖感知调度

### 问题

cw 的 `Split.dependsOn` 只用于 design-review gate 判环（`design-review.ts:399` DFS 三色标记），不驱动执行。BFS 若把同层所有节点 parallel，有依赖的节点（B dependsOn A）会并发执行——B 的 worktree 看不到 A 的代码。

### 依赖信息从哪来

planning agent 的 execute action 返回的 schema children 含 `dependsOn` 字段（agent 从 cw 的 plan.split 抄过来）。BFS 脚本消费它做拓扑排序。

```javascript
// execute 后的 children 数据结构
[
  { unitId: "wave:xxx::w1", prompt: "...", dependsOn: [] },
  { unitId: "wave:xxx::w2", prompt: "...", dependsOn: ["wave:xxx::w1"] },  // w2 依赖 w1
  { unitId: "wave:xxx::w3", prompt: "...", dependsOn: [] },
]
```

### 拓扑排序算法

```javascript
/**
 * 将待执行队列按依赖关系分组。
 * - concurrent: 无相互依赖的节点，可 parallel 执行
 * - sequential: 必须串行的节点（依赖前一组的产出）
 * - remaining: 依赖尚未满足的节点（等后续轮次）
 */
function topoSort(queue, visited) {
  // 按依赖分组：Kahn 算法变体
  const ready = [];        // 依赖全部已 visited 的节点
  const waiting = [];      // 依赖未全部满足的节点

  for (const node of queue) {
    const deps = node.dependsOn ?? [];
    const allDepsVisited = deps.every(d => visited.has(d));
    if (allDepsVisited) {
      ready.push(node);
    } else {
      waiting.push(node);
    }
  }

  // ready 组内进一步检查相互依赖（避免 A depsOn B 且都在 ready 里时并发）
  // 实际上 ready 组内的依赖一定是"已 visited 的外部依赖"，
  // ready 组内的相互依赖（A depsOn B 且 B 也在 ready）意味着 B 还没 visited
  // → 矛盾，重新分类
  const concurrent = [];
  const sequential = [];
  const readyIds = new Set(ready.map(n => n.unitId));

  for (const node of ready) {
    const internalDeps = (node.dependsOn ?? []).filter(d => readyIds.has(d));
    if (internalDeps.length > 0) {
      sequential.push(node);  // 依赖同组其他节点 → 串行
    } else {
      concurrent.push(node);  // 无同组依赖 → 可并发
    }
  }

  // concurrent 组标记为"本轮将 visited"
  // sequential 组的 visited 标记推迟到实际执行后
  return { concurrent, sequential, remaining: waiting };
}

// 执行后标记 visited
function markVisited(nodes, visited) {
  for (const n of nodes) visited.add(n.unitId);
}
```

### 串行 wave 的 worktree 创建策略（§12.5 R2）

有依赖的 wave 串行执行时，B 的 worktree 应从 A 的 commit 创建（B 能看到 A 的代码）。

但 worktree-manager 的 `create` 是 `git worktree add HEAD`（从当前 HEAD），不从指定 commit 创建。**这是一个限制。**

**解法**（MVP 简化）：串行 wave 共用同一个 worktree。
- wave A 在 worktree-W 执行（第一个 action 建，9 个 action 复用）
- wave A closeout 后，不销毁 worktree-W
- wave B 复用 worktree-W（B 的 agent cwd = worktree-W 路径）
- wave B 看到的是 A 的产出 + 自己的改动（worktree 是同一个工作区）

**这等于"有依赖的 wave 在同一 worktree 里串行写"**——退化为同 cwd 串行，但限定在有依赖的 wave 组内。无依赖的 wave 组各自独立 worktree 并发。

**代价**：有依赖的 wave 组共享 worktree，如果 A 的代码有问题导致 B 也出错，B 的 worktree 是"脏"的。但这是正确的——B 本来就依赖 A，A 有问题 B 也该暴露。

### 并发上限

实际并发受 ConcurrencyGate 限制（maxConcurrency=4，§13 新6）。workflow 的 `parallel()` 会自动排队，无需脚本额外控制。

---

## 3. F4：gate fail 超时保护

### 问题

budget 无限（§12.2 回应 5）后，gate fail 时 agent 固执重试无上限。cw 的"5 次建议 abort"是软引导不阻断。需要 wall-clock 超时兜底。

### 设计

`agent()` 已有 `timeoutMs` 字段（`AgentCallOpts.timeoutMs`）。workflow 脚本给每个 agent 调用设超时：

```javascript
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;  // 10 分钟/action（覆盖 gate 重试）

// executeNodeActions 里
const opts = {
  prompt: ...,
  schema: ...,
  fork: true,
  timeoutMs: ACTION_TIMEOUT_MS,
};
```

`execute-options-mapper.ts:76-105` 的 `mergeTimeoutSignal` 会把 timeoutMs 合并进 AbortSignal。超时后 agent call 被 abort → `executeAgentCall` 收到 signal.aborted → 返回 failed result → workflow 脚本的 `agent()` resolve 失败结果。

### 超时后的处理

```javascript
const result = await agent(opts);
// agent() 失败时 resolve 失败值（parsedOutput 为空，content 含错误信息）
// workflow 脚本判断失败
if (!result || result.error || (typeof result === "string" && result.includes("aborted"))) {
  // 超时或失败：记录并跳过（或 abort 整个 BFS）
  log(`Action ${action} for ${node.unitId} timed out or failed`);
  // MVP：跳过该节点，继续 BFS（cw 状态停在非终态，可后续手动恢复）
  // 或：标记该节点为 failed，cw abort
}
```

### 超时值

| 层 | action | 建议超时 |
|----|--------|---------|
| planning | clarify/plan/design-review/execute | 5 分钟 |
| wave | clarify/plan/design-review | 5 分钟 |
| wave | execute（写代码）| 15 分钟 |
| wave | test | 10 分钟（含 npm test 运行）|
| wave | exec-review/retrospect/closeout | 5 分钟 |

MVP 阶段统一用 10 分钟，后续按 action 类型细化。

---

## 4. 崩溃恢复（与 frontier 配合）

### 正常路径（schema 驱动）

BFS 由 schema children 驱动，不查 frontier。agent 调 cw execute → cw 建子层 → agent 返回 children → BFS 入队。

### 崩溃路径（frontier 重建）

worker 重启后，schema 内存态丢失。调 `cw frontier`（spec-c C2）重建队列：

```javascript
async function recoverFromCrash(rootUnitId) {
  const frontier = JSON.parse(execSync(`cw frontier --root ${rootUnitId} --format json`));

  // 过滤掉 blocked 节点（等子层的，本轮不派）
  const actionable = frontier.nodes.filter(n => !n.blocked);

  // 重建 BFS queue
  const queue = actionable.map(n => ({
    unitId: n.unitId,
    depth: LAYER_DEPTH[n.scope],
    nextAction: n.nextAction,
    prompt: reconstructPrompt(n),  // 从 cw handoff 重建
  }));

  return bfsLoop(rootUnitId, ...);  // 从重建的 queue 继续
}
```

### 边界：worktree 脏数据

崩溃时 wave worktree 里可能有写到一半的代码（未 commit）。恢复时该 wave 重新派 agent，agent 进同一 worktree 看到脏数据。

**MVP 策略**：崩溃后丢弃 wave worktree（worktree-manager reaper 清理），重新从 HEAD 创建。代价是崩溃时未 commit 的代码丢失——但 cw 的 wave execute 要求先 commit 再调 cw execute，所以"已 execute 的 wave"的代码在 commit 里（不丢），"未 execute 的"代码确实丢（可接受，重跑）。

---

## 5. workflow 脚本完整伪代码

```javascript
// recursive-split.js
const meta = { name: "recursive-split", description: "..." };

const PLANNING_ACTIONS = ["clarify", "plan", "design-review", "execute"];
const WAVE_ACTIONS = ["clarify", "plan", "design-review", "execute", "test", "exec-review", "retrospect", "closeout"];
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;
const LAYER_DEPTH = { epic: 0, feature: 1, slice: 2, wave: 3 };

const task = $ARGS.task;
const startLayer = $ARGS.startLayer ?? "slice";

// ── 初始化 ──
phase("init");
const rootUnitId = await agent({
  prompt: `调 cw create ${startLayer} --slug ... --objective "${task}"，返回 unitId`,
  schema: { unitId: "string" },
  cwd: $WORKSPACE,
  timeoutMs: ACTION_TIMEOUT_MS,
}).then(r => r.unitId);

// ── BFS ──
phase("bfs");
let queue = [{ unitId: rootUnitId, depth: LAYER_DEPTH[startLayer], prompt: task, dependsOn: [] }];
const visited = new Set();
const sessionFiles = {};  // unitId → sessionFile（供 retrospect 用）

while (queue.length > 0) {
  const { concurrent, sequential, remaining } = topoSort(queue, visited);

  // 并发组
  if (concurrent.length > 0) {
    const results = await parallel(concurrent.map(node => executeNode(node)));
    markVisited(concurrent.map(n => n.unitId), visited);
    const newChildren = results.flatMap(r => r.children ?? []);
    queue = [...remaining, ...sequential, ...newChildren];
    // 记录 sessionFile
    results.forEach(r => { if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile; });
  } else if (sequential.length > 0) {
    // 串行组
    for (const node of sequential) {
      const result = await executeNode(node);
      visited.add(node.unitId);
      queue = [...remaining, ...(result.children ?? [])];
      if (result.sessionFile) sessionFiles[result.unitId] = result.sessionFile;
    }
  } else {
    // 全是 remaining（依赖未满足）——不应该发生（topoSort 保证 ready 组非空）
    break;
  }
}

// ── 完成 ──
phase("done");
return { status: "done", rootUnitId };

// ── 执行单个节点（含所有 action）──
async function executeNode(node) {
  const isWave = node.depth >= 3;
  const actions = isWave ? WAVE_ACTIONS : PLANNING_ACTIONS;
  let waveWorktreePath = null;
  let children = [];

  for (const action of actions) {
    const opts = {
      prompt: buildActionPrompt(node, action),
      schema: buildActionSchema(node, action, isWave),
      fork: true,
      timeoutMs: ACTION_TIMEOUT_MS,
    };

    if (isWave) {
      if (!waveWorktreePath) {
        opts.worktree = true;
        opts.cwd = $WORKSPACE;
      } else {
        opts.cwd = waveWorktreePath;
      }
    } else {
      opts.cwd = $WORKSPACE;
    }

    // retrospect 时传子层 sessionFile（F2）
    if (action === "retrospect" && !isWave) {
      const childSessionFiles = (node.children ?? [])
        .map(c => sessionFiles[c.unitId])
        .filter(Boolean);
      opts.prompt += `\n子层 session 记录：\n${childSessionFiles.map(f => `- ${f}`).join("\n")}`;
    }

    const result = await agent(opts);

    if (isWave && !waveWorktreePath) waveWorktreePath = worktreePath();
    if (action === "execute" && result.children) children = result.children;
  }

  return {
    unitId: node.unitId,
    children,
    sessionFile: lastSessionFile(),
  };
}
```

---

## 6. 验证里程碑

### 里程碑 1：单层串行（slice → 1 wave）

一个 slice 拆 1 个 wave，全串行走完。验证：
- 每个 action 一个 agent，agent 读 handoff 拿前序产出
- wave 的 9 个 action 复用同一 worktree
- gate fail 闭环（人为制造 test fail，验证 agent 修正重调）

### 里程碑 2：同层并发（slice → 2 无依赖 wave）

2 个无依赖的 wave parallel 执行。验证：
- parallel() 并发 2 个 agent
- 各自独立 worktree
- 并发写无 .git/index.lock 冲突

### 里程碑 3：依赖感知串行（slice → 2 有依赖 wave）

wave-2 dependsOn wave-1。验证：
- wave-1 先执行，wave-2 等待
- wave-2 复用 wave-1 的 worktree（看到 wave-1 的代码）

### 里程碑 4：崩溃恢复

BFS 执行中途 kill worker，重启后 frontier 重建队列继续。验证：
- frontier 正确标记 blocked 节点
- 未完成的 wave 重新派 agent
- 已完成的 wave 不重跑
