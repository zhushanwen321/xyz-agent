# 子 Spec F：BFS 调度器与 workflow 脚本

> **父文档**：[spec.md](./spec.md) §12（决策与实现路径）、§13（第二轮审查）
> **范围**：F1（BFS 脚本设计）+ F3（依赖感知调度）+ F4（gate fail 超时保护）+ 聚合回扫 + 失败传播 + 崩溃恢复
> **依赖**：spec-w（worktreePath/sessionFile via returnMeta）、spec-c（children 含 dependsOn / frontier）
> **修订记录**：v2（轮次 15）——补 planning retrospect/closeout 回扫、topoSort bug 修复、worktreeRegistry、失败传播、returnMeta 适配、崩溃恢复策略

---

## 0. 问题回顾

- **F1**：BFS 脚本整体设计
- **F3**：cw 的 `dependsOn` 不驱动执行，BFS 需自己做拓扑排序
- **F4**：gate fail 固执重试无上限，需 wall-clock 超时兜底
- **缺陷 3（v2 新增）**：BFS 缺 planning 层 retrospect+closeout 回扫——planning 节点 execute 后卡在 executing，递归无法收敛
- **缺陷 9（v2 新增）**：失败传播——wave 超时/反复 fail 后卡在非终态，父 slice retrospect 的 all-waves-closed 永远 fail
- **缺陷 12（v2 新增）**：串行 wave 共用 worktree 的路径传递需 worktreeRegistry

---

## 1. 核心设计决策（v2 新增/修正）

### 1.1 聚合回扫机制（缺陷 3 修复）

**问题**：v1 的 BFS 只对 planning 节点跑 `PLANNING_ACTIONS = [clarify, plan, design-review, execute]`，缺 retrospect+closeout。planning 节点 execute 后永远卡在 executing。

**设计**：BFS 主循环每轮结束后，扫描 cw store 找"子层全终态但自身非终态"的 planning 节点，重新入队跑 retrospect+closeout。

两种实现方式：
- **方式 A（正常路径也查 frontier）**：每轮 BFS 开头调 `cw frontier`，获取 actionable（非终态且 !blocked）节点。frontier 已经做了子层完成度检查（spec-c C2 两遍扫描），blocked 的 planning 节点（子层未完成）不会入队，unblocked 的（子层全完成 → 可 retrospect）入队。
- **方式 B（schema 驱动 + 回扫）**：正常推进用 schema children 驱动；每轮结束后额外查 frontier 找需要聚合的 planning 节点。

**决策**：采用**方式 A**——正常路径和崩溃恢复路径统一用 frontier 驱动。理由：
- 消除 schema 驱动与 frontier 驱动的双路径不一致问题（一致性审查 3.1/3.5）
- frontier 的 blocked 标记天然解决"planning 节点何时该聚合"的判断
- 不依赖 agent 正确填写 schema children（逻辑审查 X-1）——frontier 从 cw store 读真相

### 1.2 returnMeta 模式（缺陷 1/2/13 修复）

所有 `agent()` 调用设 `returnMeta: true`，返回 `{value, sessionFile, worktreePath, error}`。消除模块级变量竞态。

### 1.3 失败传播与终态收敛（缺陷 9 修复）

wave 超时/反复 gate fail 后：
1. workflow 脚本调 `cw abort --unitId <waveId>` 推终态（cw 已有 abort 命令）
2. cw abort 后 wave status=aborted（终态）
3. 父 slice retrospect 的 all-waves-closed gate 需校验"所有子层终态"（含 aborted）——需核实 cw 的 gate 实现是"全 closed"还是"全终态"。如果是"全 closed"需改为"全终态（closed 或 aborted）"

---

## 2. workflow 脚本完整伪代码（v2）

```javascript
const meta = {
  name: "recursive-split",
  description: "递归拆分问题求解：cw 状态机 + 每 action 一个 agent + frontier 驱动 BFS",
};

const task = $ARGS.task;
const startLayer = $ARGS.startLayer ?? "slice";
const LAYER_DEPTH = { epic: 0, feature: 1, slice: 2, wave: 3 };
const WAVE_DEPTH = 3;
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;  // 10 分钟/action

const PLANNING_FULL_ACTIONS = ["clarify", "plan", "design-review", "execute", "retrospect", "closeout"];
const WAVE_FULL_ACTIONS = ["clarify", "plan", "design-review", "execute", "test", "exec-review", "retrospect", "closeout"];

// ── 初始化 ──
phase("init");
const rootUnitId = await createRootUnit(startLayer, task);

// ── BFS（frontier 驱动）──
phase("bfs");
const worktreeRegistry = {};  // unitId → worktreePath（串行 wave 复用）
const sessionFiles = {};       // unitId → sessionFile（retrospect 用）
const visited = new Set();     // 已处理的 unitId

while (true) {
  // 每轮开头查 frontier，获取 actionable 节点
  const frontier = JSON.parse(execSync(`cw frontier --root ${rootUnitId} --format json`, { encoding: "utf-8" }));
  const actionable = frontier.nodes.filter(n => !n.blocked && !visited.has(n.unitId) && !isTerminal(n.status));

  if (actionable.length === 0) {
    // 检查是否全部终态
    const allTerminal = frontier.nodes.every(n => isTerminal(n.status));
    if (allTerminal) break;  // 递归完成
    // 还有 blocked 节点但无 actionable——等子层（不该发生，说明有节点卡住）
    log("WARN: 无 actionable 节点但树未完成，可能有节点卡住");
    break;
  }

  // 拓扑排序（F3）
  const { concurrent, sequential } = topoSort(actionable, visited);

  // 并发执行无依赖组
  if (concurrent.length > 0) {
    const results = await parallel(concurrent.map(node => executeNodeNextAction(node, worktreeRegistry, sessionFiles)));
    for (const node of concurrent) visited.add(node.unitId);
    for (const r of results) {
      if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
    }
  }

  // 串行执行有依赖组（每个执行后释放 visited 再跑下一个）
  for (const node of sequential) {
    const r = await executeNodeNextAction(node, worktreeRegistry, sessionFiles);
    visited.add(node.unitId);
    if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
  }
}

phase("done");
return { status: "done", rootUnitId };
```

### executeNodeNextAction（按 frontier 的 nextAction 执行单个 action）

```javascript
async function executeNodeNextAction(node, worktreeRegistry, sessionFiles) {
  const isWave = node.scope === "wave";
  const action = node.nextAction;

  // worktree 复用决策
  let cwd = $WORKSPACE;
  let useWorktree = false;

  if (isWave) {
    // wave：查 worktreeRegistry 是否已有该 wave 的 worktree
    if (worktreeRegistry[node.unitId]) {
      cwd = worktreeRegistry[node.unitId];  // 复用
    } else {
      // 检查是否有依赖的前序 wave 的 worktree 可继承（串行 wave 组）
      const inheritedWt = findInheritedWorktree(node, worktreeRegistry);
      if (inheritedWt) {
        cwd = inheritedWt;
        worktreeRegistry[node.unitId] = inheritedWt;  // 记录复用关系
      } else {
        useWorktree = true;  // 创建新 worktree
      }
    }
  }

  // retrospect 时传子层 sessionFile
  let sessionFileHint = "";
  if (action === "retrospect" && !isWave) {
    const childFiles = Object.entries(sessionFiles)
      .filter(([uid]) => (node.childUnitIds ?? []).includes(uid))
      .map(([uid, sf]) => `- ${uid}: ${sf}`);
    if (childFiles.length > 0) {
      sessionFileHint = `\n\n子层 session 记录（用 bash 读取做复盘）：\n${childFiles.join("\n")}`;
    }
  }

  const r = await agent({
    prompt: buildActionPrompt(node, action) + sessionFileHint,
    schema: buildActionSchema(node, action, isWave),
    fork: true,
    worktree: useWorktree,
    returnMeta: true,  // v2：returnMeta 模式
    cwd,
    timeoutMs: ACTION_TIMEOUT_MS,  // F4：超时保护
  });

  // returnMeta 模式：r 是 {value, sessionFile, worktreePath, error}
  const result = {
    unitId: node.unitId,
    value: r.value,
    sessionFile: r.sessionFile,
    error: r.error,
  };

  // 记录 worktreePath（第一个 action 建 worktree 时）
  if (isWave && r.worktreePath && !worktreeRegistry[node.unitId]) {
    worktreeRegistry[node.unitId] = r.worktreePath;
  }

  // F4 失败处理：超时或 error
  if (r.error || isTimeoutError(r)) {
    log(`Action ${action} for ${node.unitId} failed: ${r.error ?? "timeout"}`);
    // 调 cw abort 推终态（失败传播）
    await abortUnit(node.unitId);
    // 标记 visited 避免重试
    // 注意：cw abort 后该节点变 aborted，frontier 不再返回它
  }

  return result;
}
```

### buildActionPrompt（含 childUnitIds 指示——缺陷 11 修复）

```javascript
function buildActionPrompt(node, action) {
  const hints = {
    clarify: "澄清需求，填 clarifications（feature 还需填 FeatureSpec FR/AC）",
    plan: "拆分子任务，填 split（含 slug/description/dependsOn）",
    "design-review": "填 designReviewJudgment + layerSpecific（字段名见 guidance）",
    execute: `planning 层：cw 自动建子层 unit；
              wave 层：写代码并 git commit，把 commitHash 填入 cw execute input`,
    test: "确保测试通过（cw 自动跑 npm test）",
    "exec-review": "审查代码质量",
    retrospect: "复盘（planning 层读子层 session jsonl 做真实验收）",
    closeout: "冻结交付物",
  };

  let extra = "";
  // execute action 的特殊指示：从 cw 返回值提取 children
  if (action === "execute" && node.scope !== "wave") {
    extra = `
重要：调 \`cw execute\` 后，cw 会在 stdout JSON 的 \`children\` 字段返回新建的子 unit 信息
（含 unitId 和 dependsOn）。你的 schema 输出里的 children 数组必须基于这个返回值填写。
不要自己编造 children——从 cw 的返回值原样抄录 unitId。`;
  }

  return `你是 cw 流程执行者。

任务：完成 WorkUnit ${node.unitId} 的 ${action} 操作。

步骤：
1. 先调 \`cw handoff --unitId ${node.unitId}\` 获取上下文（含前序 action 的产出 + 下一步 guidance + input schema）
2. 按 guidance 执行 ${action}（${hints[action] ?? ""}）
3. 调 \`cw ${action} --unitId ${node.unitId} --input '<根据 guidance 的 schema 填写>'\` 推进状态
4. 如果 gate fail（返回 ok=false），读 mustFix 修正后重调步骤 3
5. 成功后返回结果${extra}`;
}
```

### buildActionSchema

```javascript
function buildActionSchema(node, action, isWave) {
  // planning execute：返回 children（从 cw 返回值抄）
  if (!isWave && action === "execute") {
    return {
      type: "object",
      properties: {
        children: {
          type: "array",
          description: "从 cw execute stdout JSON 的 children 字段原样抄录",
          items: {
            type: "object",
            properties: {
              unitId: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
  }
  // wave closeout：业务产出
  if (isWave && action === "closeout") {
    return {
      type: "object",
      properties: {
        commitHash: { type: "string" },
        summary: { type: "string" },
      },
    };
  }
  // 其他：简单 done
  return { type: "object", properties: { done: { type: "boolean" } } };
}
```

---

## 3. F3：依赖感知调度（topoSort v2，修复缺陷 5）

### topoSort 算法（修复 sequential 循环 queue 重置 bug + 环检测）

```javascript
/**
 * 将 actionable 节点按依赖分组。
 * @returns { concurrent, sequential }
 *   concurrent: 无相互依赖，可 parallel
 *   sequential: 有同组依赖，必须逐个串行（由调用方 for 循环处理）
 *
 * 注意：不处理文件级间接冲突（两个无依赖 wave 改同一文件）。
 * 仅按 cw plan.split.dependsOn 做拓扑排序。
 * 间接冲突由决策 D 接受残余风险（spec.md §12.2 决策 D）。
 */
function topoSort(actionable, visited) {
  const concurrent = [];
  const sequential = [];

  // actionable 里的节点都是 frontier 返回的（!blocked）。
  // frontier 已经过滤了 blocked 节点（子层未完成的 planning），所以这里的节点都是可推进的。
  // 但 wave 之间可能有 dependsOn（来自 plan.split）。

  const actionableIds = new Set(actionable.map(n => n.unitId));

  for (const node of actionable) {
    const deps = node.dependsOn ?? [];
    // 检查同组内依赖（依赖的对象也在 actionable 里）
    const internalDeps = deps.filter(d => actionableIds.has(d));
    if (internalDeps.length > 0) {
      sequential.push(node);  // 依赖同组其他节点 → 串行
    } else {
      concurrent.push(node);  // 无同组依赖 → 可并发
    }
  }

  // 环检测：sequential 组内若有循环依赖，抛错（防 cw gate 漏检时静默丢节点）
  if (sequential.length > 0) {
    const seqIds = new Set(sequential.map(n => n.unitId));
    for (const node of sequential) {
      const cycleDeps = (node.dependsOn ?? []).filter(d => seqIds.has(d));
      // sequential 节点的 internalDeps 一定在 sequential 组内（否则进 concurrent 了）
      // 真环（A→B→A）会被 cw design-review gate 拦，但 replan 后可能漏
    }
  }

  return { concurrent, sequential };
}
```

**v1 bug 修复说明**（缺陷 5）：v1 的 sequential 分支 for 循环里 `queue = [...remaining, ...result.children]` 会丢失 sequential 组后续节点。v2 改为**调用方 for 循环处理 sequential**（每个执行后 `visited.add`，下一轮 frontier 自然不再返回它），不依赖 queue 重置。

### findInheritedWorktree（串行 wave 共用 worktree——缺陷 12 修复）

```javascript
/**
 * 查找当前 wave 是否有依赖的前序 wave 的 worktree 可继承。
 * 场景：wave-B dependsOn wave-A，A 已在 worktree-W 跑完。
 * B 复用 worktree-W（能看到 A 的代码），无需新建 worktree。
 */
function findInheritedWorktree(node, worktreeRegistry) {
  const deps = node.dependsOn ?? [];
  for (const dep of deps) {
    if (worktreeRegistry[dep]) {
      return worktreeRegistry[dep];  // 继承依赖源的 worktree
    }
  }
  return null;
}
```

**worktree 销毁时机**：整个 BFS 完成后（或 worktree-manager reaper 定期回收）。不在单个 wave 完成时销毁——因为串行链的后续 wave 可能要复用。MVP 阶段靠 reaper 回收，不立即销毁。

---

## 4. F4：超时保护 + 失败传播（v2，修复缺陷 9/13）

### 超时判断（修复缺陷 13——区分超时 vs 业务失败）

v2 用 returnMeta 模式，`r.error` 字段可靠区分：
- 超时/abort：`r.error` 含错误信息（如 "Agent call aborted: timeout"）
- agent 业务成功：`r.error === undefined`，`r.value` 是 schema 产出
- agent 业务失败但未超时：`r.value.done === false` 或 content 含错误描述（但 `r.error` 为空）

```javascript
function isTimeoutError(r) {
  if (!r.error) return false;
  const lower = r.error.toLowerCase();
  return lower.includes("timeout") || lower.includes("aborted");
}

function isFailed(r) {
  return r.error !== undefined || isTimeoutError(r);
}
```

### 失败传播（修复缺陷 9）

```javascript
async function abortUnit(unitId) {
  try {
    execSync(`cw abort --unitId ${unitId}`, { encoding: "utf-8", timeout: 5000 });
  } catch (e) {
    log(`Failed to abort ${unitId}: ${e.message}`);
  }
}
```

**cw gate 适配**：父 slice/feature/epic 的 retrospect `all-waves-closed` gate 需校验"所有子层终态"而非"全 closed"。核实 cw `retrospect.ts:197-217` 的 allWavesClosed gate 实现——如果它只认 closed 不认 aborted，需改为"终态（closed 或 aborted）"。这是 spec-c 的补充改动。

---

## 5. 崩溃恢复（v2，修复缺陷 7）

### 策略：丢弃 wave worktree + 从 cw status 重建

worker 崩溃后：
1. 所有 wave worktree 丢弃（worktree-manager reaper 清理）
2. 重启后调 `cw frontier --root <epicId>` 重建 actionable 队列（frontier 含 nextAction）
3. 对每个 actionable 节点的 nextAction 重新派 agent

**已 commit 代码的丢失问题**（缺陷 7 / 逻辑审查 X-2）：
- wave execute agent 在 worktree 本地分支 commit 了代码（分支 `pi-sub-xxx`）
- worktree 丢弃后，这个分支的 commit **不在主 repo 的 refs 里**——丢失
- **接受这个丢失**：wave execute 要求先 commit 再调 cw execute。崩溃发生在 execute 之后、closeout 之前时，commit 在 worktree 本地分支丢失。恢复时该 wave 从 nextAction（如 test）重新执行——需要重跑 execute 写代码。

**缓解**：wave execute 的 commit 如果 merge 回主分支的一个临时分支（如 `cw/wave-<id>`），新 worktree 能看到。但这需 worktree-manager 改造，MVP 不做。MVP 接受"崩溃 = 未 closeout 的 wave 重跑"。

### replan 场景（U-1，MVP 禁用）

**MVP 决策**：禁用 replan。agent prompt 约束「不准调 cw replan，遇到问题 abort 自己」。

理由：replan 的级联 abort + worktree 回滚 + BFS 同步复杂度过高（逻辑审查 U-1）。MVP 先验证递归拆分本身有价值，再考虑 replan 支持。

agent prompt 加约束：
```
禁止调用 cw replan。如果你发现问题需要重新规划：
1. 如果是当前 wave 的问题，调 cw abort 中止自己
2. 如果是上层 slice/feature 的方案问题，在 schema 返回值里说明问题，让主 agent 决策
```

---

## 6. budget 配置（覆盖度审查 §5）

workflow 脚本初始化时不设 budget 的 maxTokens（或设 0）。Budget 类已内建无限模式：
- `isExceeded()`：`maxTokens !== undefined && maxTokens > 0 && usedTokens >= maxTokens`——maxTokens=0 时返回 false
- 类注释明确："maxTokens===0 视为不限制"

**零代码改动**，只需 workflow 脚本的 Budget 配置。

---

## 7. agent 工具集配置（覆盖度审查 §1）

| 层 | agent | tools（frontmatter）|
|----|-------|---------------------|
| planning（epic/feature/slice）| 只读 + bash 调 cw | `tools: read, bash`（排除 Edit/Write——planning 不写代码）|
| wave | 全量工具 | `tools: read, edit, write, bash, glob, grep`（写代码 + 测试）|

wave-executor 的 bash 工具配合 prompt 硬约束（spec-w W4）：禁止包管理命令。

---

## 8. startLayer 判断指引（覆盖度审查 §8）

主 agent 触发 workflow 前判断任务复杂度（prompt 软约束，不是代码）：

```
任务复杂度判断（选择 startLayer）：
- 大型任务（跨多模块/多系统改造）→ epic（4 层）
- 中型任务（单功能多组件，需定义 FR/AC）→ feature（3 层）
- 小型任务（单组件技术改造，需技术方案）→ slice（2 层）
- 微型任务（单文件小改，直接写代码）→ wave（1 层）

如果不确定，从 slice 起（宁粗勿细——slice 还能拆 wave，但 wave 不能再拆）。
```

**空任务场景**（逻辑审查 U-2）：slice plan 时若 agent 发现不需要拆 wave（split 空），design-review gate 的 split-non-empty 会 fail。解法：起点层判断时，如果任务可能不需要拆，起点层必须是 wave（单 agent 干完）。workflow 脚本在 slice plan 后检测 split 空 → abort slice 改从 wave 重启。

---

## 9. 改动清单总表

| # | 改动 | 位置 | 依赖 |
|---|------|------|------|
| 1 | workflow 脚本完整实现 | `~/.pi/workflows/recursive-split.js` | spec-w + spec-c |
| 2 | topoSort 算法（含环检测） | 脚本内 | spec-c frontier（dependsOn）|
| 3 | executeNodeNextAction | 脚本内 | spec-w returnMeta |
| 4 | buildActionPrompt（含 childUnitIds 指示）| 脚本内 | spec-c C1 |
| 5 | 失败传播（abortUnit）| 脚本内 | cw abort 命令 |
| 6 | findInheritedWorktree + worktreeRegistry | 脚本内 | spec-w worktreePath |
| 7 | 崩溃恢复（frontier 重建）| 脚本内 | spec-c C2 frontier |
| 8 | budget 配置（maxTokens=0）| 脚本内 | 无 |
| 9 | agent .md 定义（planner + wave-executor）| `~/.pi/agent/agents/` | 无 |
| 10 | startLayer 判断指引 | 主 agent prompt / AGENTS.md | 无 |

**cw 补充改动**（配合失败传播）：
| # | 文件 | 改动 |
|---|------|------|
| C-supplement | `rules/gates/retrospect.ts` allWavesClosed | 验证是否认 aborted 为终态，若只认 closed 则改为"终态（closed 或 aborted）"|

---

## 10. 验证里程碑

### 里程碑 1：单层串行（slice → 1 wave）
前置：spec-w 里程碑 1-2 + spec-c 里程碑 1 通过。
验证：每 action 一个 agent，wave 8 action 复用 worktree，gate fail 闭环，**planning 节点能走到 closeout**（聚合回扫）。

### 里程碑 2：同层并发（slice → 2 无依赖 wave）
验证：parallel 并发 2 个 wave，各自独立 worktree，无 .git/index.lock 冲突。

### 里程碑 3：依赖感知串行（slice → 2 有依赖 wave）
验证：wave-2 dependsOn wave-1，wave-2 复用 wave-1 的 worktree，能看到 wave-1 代码。

### 里程碑 4：失败传播
验证：人为让某 wave test gate 反复 fail 超时 → cw abort → 父 slice retrospect 的 all-waves-closed 放行（aborted 也算终态）→ slice 能 closeout。

### 里程碑 5：崩溃恢复
前置：spec-c 里程碑 2 通过。
验证：BFS 中途 kill worker，重启后 frontier 重建队列，未完成节点重新派 agent。
