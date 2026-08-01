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
- 消除 schema 驱动与 frontier 驱动的双路径不一致问题
- frontier 的 blocked 标记天然解决"planning 节点何时该聚合"的判断
- 不依赖 agent 正确填写 schema children——frontier 从 cw store 读真相

**实现优先级声明**（覆盖度审查第 2 点）：v2 的 frontier 驱动让 spec-c C2 从"崩溃恢复专用、可延后"升级为"**BFS 主循环正常运行必需、必须首批实现**"。C2 与 W1/W2 同批完成，不能延后。主 spec §12.2 决策 C 的"降级为崩溃恢复专用"表述已被 v2 推翻。

### 1.2 returnMeta 模式（缺陷 1/2/13 修复）

所有 `agent()` 调用设 `returnMeta: true`，返回 `{value, sessionFile, worktreePath, error}`。消除模块级变量竞态。

### 1.3 失败传播与终态收敛（缺陷 9 修复）

wave 超时/反复 gate fail 后：
1. workflow 脚本调 `cw abort --unitId <waveId>` 推终态（cw 已有 abort 命令）
2. cw abort 后 wave status=aborted（终态）
3. 父 slice retrospect 的 all-waves-closed gate 已确认接受 aborted 终态——cw `retrospect.ts` 的实现是 `childStatuses.filter(s => s !== "closed" && s !== "aborted")`，即只有既非 closed 又非 aborted 才算 nonTerminal。**cw 侧无需改动**（已实测确认，见 §4 allWavesClosed gate 段 + cw 增强设计报告 §2.1 协议 3）

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
const retryCount = {};         // `${unitId}:${nextAction}` → 连续未推进次数（熔断用）
const prevNextAction = {};     // unitId → 上一轮的 nextAction（跨轮对比 status 是否推进）
const MAX_ACTION_RETRY = 3;    // 同一 (unitId, nextAction) 连续 3 次未推进 → abort

// 不变式：visited 集合已删除。frontier 本身只返回非终态节点，天然保证幂等。
// 节点到终态（closed/aborted）后 frontier 自动不再返回。去重靠 cw status（唯一真相）。
// 防 agent 卡死靠 retryCount 熔断 + F4 超时双重保护。
//
// retryCount 累加逻辑（v4 修复致命缺陷）：在主循环里跨轮对比，不在 executeNodeNextAction 内部。
// 因为"agent 是否推进了 status"在当轮无法判定——需要对比上一轮的 nextAction。
//
// 实现注意（第五轮审查建议，非致命）：
// - progressive action（clarify/plan/design-review）合法地反复执行（status 原地不动）。
//   retryCount 会在 3 轮后 abort 反复 progressive 的节点。对复杂任务需多轮 progressive 的场景可能误杀。
//   建议：对 progressive action 调大阈值（5-8）或豁免。实现时 frontier 节点可暴露 progressive 标志。
// - allTerminal 判定可简化为 frontier.nodes.length === 0（语义等价，因 frontier 只返回非终态节点）。

while (true) {
  const frontier = queryFrontier(rootUnitId);
  const actionable = frontier.nodes.filter(n => !n.blocked && !isTerminal(n.status));

  if (actionable.length === 0) {
    const allTerminal = frontier.nodes.every(n => isTerminal(n.status));
    if (allTerminal) break;
    log("WARN: 无 actionable 节点但树未完成，可能有节点永久 blocked");
    break;
  }

  // retryCount 熔断检查 + 累加（跨轮对比）
  const nodesToAbort = [];
  for (const node of actionable) {
    const retryKey = `${node.unitId}:${node.nextAction}`;
    const prevAction = prevNextAction[node.unitId];
    if (prevAction === node.nextAction) {
      // nextAction 没变 = 上一轮的 agent 没推进 status → 累加
      retryCount[retryKey] = (retryCount[retryKey] ?? 0) + 1;
      if (retryCount[retryKey] >= MAX_ACTION_RETRY) {
        log(`Node ${node.unitId} stuck at ${node.nextAction} for ${MAX_ACTION_RETRY} rounds, aborting`);
        nodesToAbort.push(node.unitId);
      }
    } else {
      // nextAction 变了 = status 推进了 → 重置
      retryCount[retryKey] = 0;
    }
    prevNextAction[node.unitId] = node.nextAction;
  }

  // 熔断的节点调 cw abort（不派 agent）
  for (const unitId of nodesToAbort) {
    await abortUnit(unitId);
  }

  // 过滤掉已 abort 的节点（它们在本轮不派 agent）
  const dispatchable = actionable.filter(n => !nodesToAbort.includes(n.unitId));

  // 拓扑排序（F3）
  const { concurrent, sequential } = topoSort(dispatchable);

  // 并发执行无依赖组
  if (concurrent.length > 0) {
    const results = await parallel(concurrent.map(node => executeNodeNextAction(node, worktreeRegistry, sessionFiles)));
    for (const r of results) {
      if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
    }
  }

  // 串行执行有依赖组
  for (const node of sequential) {
    const r = await executeNodeNextAction(node, worktreeRegistry, sessionFiles);
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

  // retryCount 熔断已移到 BFS 主循环（跨轮对比 prevNextAction），此处不再检查。

  // worktree 复用决策
  let cwd = $WORKSPACE;
  let useWorktree = false;

  if (isWave) {
    if (worktreeRegistry[node.unitId]) {
      cwd = worktreeRegistry[node.unitId];
    } else {
      const inheritedWt = findInheritedWorktree(node, worktreeRegistry);
      if (inheritedWt) {
        cwd = inheritedWt;
        worktreeRegistry[node.unitId] = inheritedWt;
      } else {
        useWorktree = true;
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

  // 空任务检测：planning 层 plan 后若 split 为空（design-review gate 会因 split-non-empty fail）
  // agent 会在 gate fail 闭环里反复重试，retryCount 熔断会在 3 次后 abort。
  // 父流程检测到该节点 aborted 且是 planning 层 → 以 wave 层重启（见主循环外层逻辑）

  const r = await agent({
    prompt: buildActionPrompt(node, action) + sessionFileHint,
    schema: buildActionSchema(node, action, isWave),
    fork: true,
    worktree: useWorktree,
    returnMeta: true,
    cwd,
    timeoutMs: ACTION_TIMEOUT_MS,
  });

  const result = {
    unitId: node.unitId,
    value: r.value,
    sessionFile: r.sessionFile,
    error: r.error,
  };

  if (isWave && r.worktreePath && !worktreeRegistry[node.unitId]) {
    worktreeRegistry[node.unitId] = r.worktreePath;
  }

  // 失败处理
  if (r.error || isTimeoutError(r)) {
    log(`Action ${action} for ${node.unitId} failed: ${r.error ?? "timeout"}`);
    await abortUnit(node.unitId);
    return result;
  }

  // 成功返回。retryCount 累加/重置在主循环跨轮对比（prevNextAction），此处不处理。

  return result;
}
```

### queryFrontier（封装 execSync + timeout + 轮次边界不变式）

```javascript
function queryFrontier(rootUnitId) {
  // 不变式：frontier 只在 BFS 轮次边界调用（parallel() 全部 settle 后），
  // 不在 parallel() 进行中调用。否则 execSync 阻塞 worker 线程，
  // 导致 agent-result 消息延迟（虽不丢失但补投递在阻塞结束后）。
  return JSON.parse(execSync(
    `cw frontier --root ${rootUnitId} --format json`,
    { encoding: "utf-8", timeout: 30000 }  // 30s timeout 防 cw hang
  ));
}
```

**execSync 阻塞说明**（覆盖度审查第 4 点实测确认）：worker 线程在 execSync 期间不处理消息（agent-result 排队），但**不丢失**——阻塞结束后一次性补投递。正常路径下 frontier 只在轮次边界调（parallel settle 后），进行中的 agent 不受影响。timeout 30s 防 cw 进程 hang。

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
function topoSort(actionable) {
  const concurrent = [];
  const sequential = [];

  const actionableIds = new Set(actionable.map(n => n.unitId));

  for (const node of actionable) {
    const deps = node.dependsOn ?? [];
    const internalDeps = deps.filter(d => actionableIds.has(d));
    if (internalDeps.length > 0) {
      sequential.push(node);
    } else {
      concurrent.push(node);
    }
  }

  // 环检测：sequential 组内若有循环依赖（A→B→A），抛错
  // 正常情况 cw design-review gate 的 splitDagValid 会拦环，但 replan 后可能漏
  if (sequential.length > 0) {
    const seqIds = new Set(sequential.map(n => n.unitId));
    for (const node of sequential) {
      const cycleDeps = (node.dependsOn ?? []).filter(d => seqIds.has(d));
      if (cycleDeps.length > 0) {
        // 简单环检测：如果 node 依赖的 sequential 节点也依赖回 node（直接环），抛错
        for (const dep of cycleDeps) {
          const depNode = sequential.find(n => n.unitId === dep);
          if (depNode && (depNode.dependsOn ?? []).includes(node.unitId)) {
            throw new Error(`Circular dependency detected: ${node.unitId} ↔ ${dep}`);
          }
        }
      }
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

**allWavesClosed gate 已验证无需改动**（覆盖度审查第 1 点实测确认）：cw `retrospect.ts:206` 的 allWavesClosed gate 本就接受 aborted 为终态——`childStatuses.filter(s => s !== "closed" && s !== "aborted")`，即只有既非 closed 又非 aborted 才算 nonTerminal。**C-supplement 是空操作，无需任何 cw 改动。**

---

## 5. 崩溃恢复（v2，修复缺陷 7）

### 策略：丢弃 wave worktree + 从 cw status 重建

worker 崩溃后：
1. 所有 wave worktree 丢弃（worktree-manager reaper 清理）
2. 重启后调 `cw frontier --root <epicId>` 重建 actionable 队列（frontier 含 nextAction）
3. 对每个 actionable 节点的 nextAction 重新派 agent

**worktreeRegistry 丢失的边界**（覆盖度审查第 7 点）：
- worktreeRegistry / sessionFiles / retryCount 都是 worker 进程内存态，崩溃后清空
- findInheritedWorktree 查空 registry 返回 null → 串行 wave B 建新 worktree（不复用 A 的）
- **接受**：崩溃恢复后串行 wave 的 worktree 复用断裂。B 从 HEAD 新建 worktree，看不到 A 的产出（A 的 worktree 已丢弃）。B 的 execute 需重跑（A 已 closeout 的代码也在 worktree 本地分支丢失）。这与"崩溃=重跑"取舍一致。

**已 commit 代码的丢失问题**（缺陷 7）：
- wave execute agent 在 worktree 本地分支 commit 了代码（分支 `pi-sub-xxx`）
- worktree 丢弃后，这个分支的 commit **不在主 repo 的 refs 里**——丢失
- **接受**：崩溃发生在 execute 之后、closeout 之前时，commit 丢失。恢复时该 wave 从 nextAction 重新执行——需重跑 execute 写代码。
- **缓解**（未来改造）：wave execute 的 commit 如果 merge 回主分支临时分支（如 `cw/wave-<id>`），新 worktree 能看到。需 worktree-manager 改造，MVP 不做。

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

**cw 侧无额外改动**：allWavesClosed gate 已验证接受 aborted 为终态（retrospect.ts:206），C-supplement 是空操作已删除。

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
