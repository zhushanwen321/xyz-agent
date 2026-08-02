# 子 Spec F：BFS 调度器与 workflow 脚本

> **父文档**：[spec.md](./spec.md) §12（决策与实现路径）、§13（第二轮审查）
> **范围**：F1（BFS 脚本设计）+ F3（依赖感知调度）+ F4（gate fail 超时保护）+ 聚合回扫 + 失败传播 + 崩溃恢复
> **依赖**：spec-w（worktreePath/sessionFile via returnMeta）、spec-c（children 含 dependsOn / frontier）
> **修订记录**：v2（轮次 15）——补 planning retrospect/closeout 回扫、topoSort bug 修复、worktreeRegistry、失败传播、returnMeta 适配、崩溃恢复策略；v3（轮次 16）——per-node 调度重构：每 node 一个 agent 跑到阻塞，删除 replanOverride/handleReplan，action 级熔断→node 级熔断

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
  description: "递归拆分问题求解：cw 状态机 + 每 node 一个 agent 跑到阻塞 + frontier 驱动 BFS",
};

const task = $ARGS.task;
const startLayer = $ARGS.startLayer ?? "slice";
const LAYER_DEPTH = { epic: 0, feature: 1, slice: 2, wave: 3 };
const WAVE_DEPTH = 3;
const NODE_TIMEOUT_MS = 60 * 60 * 1000;  // 60 分钟/node：agent 在 session 内连续跑多个 cw action，比 per-action 更耗时

// ── 初始化 ──
phase("init");
const rootUnitId = await createRootUnit(startLayer, task);

// ── BFS（frontier 驱动）──
phase("bfs");
const worktreeRegistry = {};  // unitId → worktreePath（spec-w worktreePath，当前实现 worktree:false 故 registry 暂未启用，代码保留待未来 worktree 启用时用）
const sessionFiles = {};      // unitId → sessionFile（returnMeta 回收，供上层 retrospect 读）
const prevStatus = {};        // unitId → 上一轮 frontier 的 status（跨轮对比判定"node 没推进"）
const nodeRounds = {};        // unitId → status 未推进的连续轮数（node 级熔断用）
const MAX_NODE_ROUNDS = 3;    // 同一 node status 连续 N 轮没推进 → abort

// 不变式：visited 集合已删除。frontier 本身只返回非终态节点，天然保证幂等。
// 节点到终态（closed/aborted）后 frontier 自动不再返回。去重靠 cw status（唯一真相）。
// 防 agent 卡死靠 node 级熔断（detectStuckNodes）+ F4 超时双重保护。
//
// node 级熔断取代 v2 的 action 级熔断（retryCount + prevNextAction + MAX_ACTION_RETRY）：
// - v2 按 `${unitId}:${nextAction}` 累加，对 progressive action（clarify/plan/design-review）有误杀风险，靠 PROGRESSIVE_ACTIONS 豁免补丁。
// - v3 改为按 unitId 跨轮对比 status——status 不动才累加。progressive action 在 session 内连续跑完，
//   不存在 BFS 反复 dispatch 同一个 progressive action 的问题，故豁免机制一并删除。
//
// replanOverride / handleReplan 已删除：v3 下 agent 在 session 内自主连续推进，
// replan→plan→design-review→execute 全部在一个 agent session 内完成，BFS 不需要覆盖 frontier 的 nextAction（见 §5）。

while (true) {
  // 不变式：queryFrontier 只在轮次边界调（此处 parallel 已全 settle）
  const frontier = queryFrontier(rootUnitId);
  const { actionable, shouldBreak } = selectActionable(frontier);

  // 无 actionable：全终态 → 正常结束；有非终态但全 blocked → 异常（保守 break）
  if (shouldBreak) {
    if (actionable.length === 0 && frontier.nodes.length > 0) {
      const allTerminal = frontier.nodes.every(n => isTerminal(n.status));
      if (!allTerminal) log("WARN: 无 actionable 节点但树未完成，可能有节点永久 blocked");
    }
    break;
  }

  // node 级熔断：同一 node 被 dispatch 多轮 status 没推进 → abort
  const nodesToAbort = detectStuckNodes(actionable, prevStatus, nodeRounds);
  for (const unitId of nodesToAbort) {
    log("Node " + unitId + " stuck (status not progressing for " + MAX_NODE_ROUNDS + " rounds), aborting");
    await abortUnit(unitId);
  }

  // 排除已熔断 abort 的节点
  const dispatchable = actionable.filter(n => !nodesToAbort.includes(n.unitId));
  const { concurrent, sequential } = topoSort(dispatchable);

  // 并发组：无内部依赖的节点全并行（parallel allSettled 语义，单项失败不拖整批）
  if (concurrent.length > 0) {
    const results = await parallel(concurrent.map(node => executeNodeNextAction(node, sessionFiles)));
    // 回收 sessionFile + 记失败原因（agent 在 session 内自己 replan，BFS 不再做 replan 覆盖）
    for (const r of results) {
      if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
      if (r.failedReason) log("BFS: " + r.unitId + " failed: " + r.failedReason);
    }
  }

  // 串行组：有内部依赖的节点逐个执行（保证依赖顺序：被依赖者先完成推进状态机）
  for (const node of sequential) {
    const r = await executeNodeNextAction(node, sessionFiles);
    if (r.sessionFile) sessionFiles[r.unitId] = r.sessionFile;
    if (r.failedReason) log("BFS: " + r.unitId + " failed: " + r.failedReason);
  }
}

phase("done");
return { status: "done", rootUnitId };
```

### 关于 handleReplan / replanOverride（已删除）

v2 的 `handleReplan(r, replanOverride, ...)` 与 `replanOverride` 覆盖机制在 v3 删除。新模型下 agent 在 session 内自主连续推进，`replan → plan → design-review → execute` 全部在一个 agent session 内完成，BFS 不需要覆盖 frontier 的 nextAction。replan 的语义见 §5。

### executeNodeNextAction（每 node 一个 agent 跑到阻塞）

```javascript
/**
 * 执行单节点：派 agent 自主连续推进 cw action 直到阻塞。
 * 不再接收 action 参数——agent 自己从 cw handoff 拿 nextAction。
 * 不再接收 worktreeRegistry / replanOverride。
 * returnMeta:true → 返回 {unitId, value, sessionFile?, failedReason?}。
 * 失败（r.error / 超时）→ abortUnit + 返回 failedReason（不 throw，主循环继续其他节点）。
 * 失败字段命名 failedReason 而非 error，避免被 parallel() 归一化吞掉其他字段。
 */
async function executeNodeNextAction(node, sessionFiles) {
  const r = await agent({
    prompt: buildActionPrompt(node),
    schema: buildActionSchema(node),
    fork: true,
    worktree: false,       // 恒 false：pi worker worktree 生命周期限制（已知限制）。
                           // spec-w 目标态是 worktreePath，当前实现先用 $WORKSPACE——待 pi 支持 worker worktree 后启用。
    returnMeta: true,
    cwd: $WORKSPACE,       // 恒用 $WORKSPACE（worktree:false 故无 per-node cwd）
    timeoutMs: NODE_TIMEOUT_MS,  // 60 分钟：agent session 内连续跑多个 action + gate 重试
  });

  // 失败处理：returnMeta 模式 r.error 检测（agent 失败不 throw）。
  if (r.error || isTimeoutError(r)) {
    log("Node " + node.unitId + " failed: " + (r.error ?? "timeout"));
    await abortUnit(node.unitId);
    return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile, failedReason: r.error };
  }

  // schema 仍含 replanTriggered / abortedChildren 字段供 agent 回报，
  // 但 BFS 不基于它们做覆盖（replan 在 session 内自洽，见 §5）——此处不回收，只记日志。
  // sessionFile 回收供上层 retrospect 读（主循环处理）。

  return { unitId: node.unitId, value: r.value, sessionFile: r.sessionFile };
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

### selectActionable（从 frontier 提取 actionable + 判定 shouldBreak）

```javascript
/**
 * 封装旧的内联 filter + allTerminal 判断。
 * actionable = !blocked && !isTerminal(status)。
 * 返回 { actionable, shouldBreak }。
 * shouldBreak=true 表示无 actionable——BFS 应退出（全终态 = 正常结束，否则 = 异常保守 break）。
 */
function selectActionable(frontier) {
  const nodes = frontier.nodes ?? [];
  const actionable = nodes.filter(n => !n.blocked && !isTerminal(n.status));

  if (actionable.length > 0) {
    return { actionable, shouldBreak: false };
  }

  // 无 actionable：全终态 → 正常结束；有非终态但全 blocked → 异常（保守 break）
  const allTerminal = nodes.length === 0 || nodes.every(n => isTerminal(n.status));
  return { actionable: [], shouldBreak: true, allTerminal };
}
```

### detectStuckNodes（node 级熔断——取代 action 级熔断）

```javascript
/**
 * node 级熔断：遍历 actionable 节点，识别连续 dispatch 但 status 没推进的 node。
 * 替代 v2 的 action 级熔断（retryCount + prevNextAction + MAX_ACTION_RETRY）。
 * progressive action 豁免已删除——agent 在 session 内连续跑 progressive action，
 * 不存在 BFS 反复 dispatch 同一个 progressive action 的问题。
 * 返回 nodesToAbort[]（unitId 列表）。mutation prevStatus / nodeRounds。
 *
 * 注意：实际熔断需 MAX_NODE_ROUNDS 轮——第 1 轮建 prevStatus 基线，
 * 之后连续 N 轮 status 不变才累加到阈值。
 */
function detectStuckNodes(actionable, prevStatus, nodeRounds) {
  const nodesToAbort = [];

  for (const node of actionable) {
    const prev = prevStatus[node.unitId];
    if (prev === node.status) {
      // status 没变——可能是 agent 只做了 progressive action（如 clarify）没前进，或 gate 反复 fail
      nodeRounds[node.unitId] = (nodeRounds[node.unitId] ?? 0) + 1;
      if (nodeRounds[node.unitId] >= MAX_NODE_ROUNDS) {
        nodesToAbort.push(node.unitId);
      }
    } else {
      // status 变了——node 在推进，重置计数
      nodeRounds[node.unitId] = 0;
    }
    prevStatus[node.unitId] = node.status;
  }

  return nodesToAbort;
}
```

### buildActionPrompt（推进到阻塞 prompt——缺陷 11 修复 + per-node 重构）

```javascript
/**
 * 为单节点构建 agent prompt（推进到阻塞模型）。
 * 不再接收 action 参数——agent 在 session 内自主连续推进，直到遇到停止条件。
 * guidance 是唯一导航源（cw-cli skill 约定），prompt 不硬编码 schema 字段名。
 */
function buildActionPrompt(node) {
  const isWave = node.scope === "wave";

  // planning 层 execute 后需把 children 信息抄回 schema（供 topoSort 算依赖）。
  // 条件式：只在"如果推进到了 execute"时才生效——agent 可能提前遇 crossLayer 停下。
  let childrenHint = "";
  if (!isWave) {
    childrenHint = `

如果你推进到了 planning 层的 execute：
- 调 \`cw execute\` 后，检查 stdout JSON 的 \`children\` 字段。
- 如果有 children（含 [{unitId, dependsOn}]）：从中原样抄录 unitId 和 dependsOn 填入你的 schema 输出。
- 如果没有 children：调 \`cw tree --unitId ${node.unitId}\` 收集子 unitId（无 dependsOn → 全并发）。
- execute 后 cw 返回 crossLayer.descend（指向第一个子 unit），这是你的停止条件——子层交给主调度器。`;
  }

  return `你是 cw 流程执行者。

任务：推进 WorkUnit ${node.unitId} 尽可能远，直到遇到以下停止条件之一：
1. \`cw handoff\` 或 \`cw <action>\` 返回的 nextAction 含 crossLayer（action 为 undefined）——需要跳到另一个 WorkUnit，这是你的停止信号
2. 同一 action 连续 gate fail 超过 3 次——返回说明哪个 action 反复 fail、mustFix 内容
3. 你判断无法继续（如需要外部决策）——返回说明原因

方法：
1. 调 \`cw handoff --unitId ${node.unitId}\` 获取上下文 + guidance + input schema
2. 按 guidance 的命令行执行当前 action（copy guidance 的"命令"那行，不要自己拼——cw 的 --input 是文件路径语义，字面 JSON 串会报错；execute 用 --commitHash flags，其他 action 用 --input 文件路径或 stdin）
3. 如果 gate fail（返回 ok=false），读 mustFix 修正后重调同一个 action
4. gate pass 后不要返回——继续调 \`cw handoff\` 拿下一步 guidance，重复步骤 2-3
5. 直到遇到上述停止条件才返回${childrenHint}

关键提示：
- clarify 是 progressive action——调一次 \`cw clarify\` 后如果需求已清晰，**立即调 \`cw plan\` 前进**，不要重复 clarify
- test action：为本 wave 的代码**产出 vitest 测试文件**（如果还没有测试的话），覆盖 plan 声明的 testCases，跑 \`npx vitest run\` 确认全绿后才调 \`cw test\`——不要只用 testJudgment 文字判定
- execute（wave 层）：写代码后 \`git add -A && git commit\`，拿到 commitHash 后调 \`cw execute --unitId ${node.unitId} --commitHash <hash>\``;
}
```

### buildActionSchema（统一 schema——per-node 重构）

```javascript
/**
 * 为单节点构建 agent schema（推进到阻塞模型）。
 * 不再接收 action 参数（仍按 node.scope === "wave" 判断 isWave）。
 * 统一 base schema，不再按 action 类型分支——agent 在 session 内连续跑多个 action。
 */
function buildActionSchema(node) {
  const isWave = node.scope === "wave";

  const baseProps = {
    done: { type: "boolean", description: "是否推进到了停止条件" },
    stopReason: {
      type: "string",
      description: "停止原因：crossLayer / gateFailed / blocked / cannotProceed",
    },
    lastStatus: { type: "string", description: "最后查到的 cw status" },
    // replan 信号字段保留——供 agent 回报 + BFS 记日志，但 BFS 不基于它们做覆盖（见 §5）
    replanTriggered: { type: "boolean", description: "如果调了 cw replan 设为 true" },
    abortedChildren: {
      type: "array",
      items: { type: "string" },
      description: "被级联 abort 的子 unitId 列表（replan 时从 cw replan stdout 抄录）",
    },
  };

  // planning 层需要 children（execute 后供 topoSort 算依赖）
  if (!isWave) {
    return {
      type: "object",
      required: ["done"],
      properties: {
        ...baseProps,
        children: {
          type: "array",
          description: "planning execute 后从 cw stdout 或 cw tree 抄录的子 unitId + dependsOn",
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

  // wave 层：统一 base schema（不再有 closeout 专用的 commitHash/summary 分支）
  return { type: "object", required: ["done"], properties: baseProps };
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
1. 所有 wave worktree 丢弃（worktree-manager reaper 清理；注：当前实现 `worktree:false` 故实际无 per-wave worktree）
2. 重启后调 `cw frontier --root <epicId>` 重建 actionable 队列（frontier 含 nextAction）
3. 对每个 actionable 节点重新派 agent（每 node 一个 agent 跑到阻塞）

**内存态丢失的边界**（覆盖度审查第 7 点，v3 更新）：
- sessionFiles / prevStatus / nodeRounds 都是 worker 进程内存态，崩溃后清空
- nodeRounds 清空 = 熔断基线丢失：恢复后第 1 轮重建 prevStatus 基线，需再连续 MAX_NODE_ROUNDS 轮不推进才熔断（接受——崩溃=重跑取数）
- findInheritedWorktree 查空 registry 返回 null → 串行 wave B 建新 worktree（不复用 A 的；当前实现 worktree:false 无此问题）
- **接受**：崩溃恢复后串行 wave 的 worktree 复用断裂。B 从 HEAD 新建 worktree，看不到 A 的产出（A 的 worktree 已丢弃）。B 的 execute 需重跑（A 已 closeout 的代码也在 worktree 本地分支丢失）。这与"崩溃=重跑"取舍一致。

**已 commit 代码的丢失问题**（缺陷 7）：
- wave execute agent 在 worktree 本地分支 commit 了代码（分支 `pi-sub-xxx`）
- worktree 丢弃后，这个分支的 commit **不在主 repo 的 refs 里**——丢失
- **接受**：崩溃发生在 execute 之后、closeout 之前时，commit 丢失。恢复时该 wave 从 nextAction 重新执行——需重跑 execute 写代码。
- **缓解**（未来改造）：wave execute 的 commit 如果 merge 回主分支临时分支（如 `cw/wave-<id>`），新 worktree 能看到。需 worktree-manager 改造，MVP 不做。

### replan 场景（v3：删除 replanOverride 机制）

**决策**：仍支持 replan（不做 MVP 禁用）。replan 是真实开发的常见场景（"做着做着发现方案要改"），禁用它等于遇到方案错误时只能放弃整个节点。

**v3 简化：不再需要 replanOverride 机制**。v2 维护 `replanOverride: Map<unitId, "plan">`，是为了在"每 action 一个 agent"模型下，覆盖 frontier 的 status→action 映射（frontier 看到 status=executing 仍映射到 retrospect，但 replan 后 cw 要求回 plan 重走 design-review）。

v3 改为"每 node 一个 agent 跑到阻塞"后：
- agent 在 session 内自主连续推进——`replan → plan → design-review → execute` 全部在一个 agent session 内一口气跑完
- cw replan handler 返回的 `nextAction.action='plan'`（`epic/replan.ts:16`）直接被 agent 的下一次 `cw handoff` 读到，agent 自己跟着走，不需要 BFS 介入覆盖
- BFS 全程只按 status + blocked 调度，不需要覆盖 frontier 的 nextAction

**agent schema 仍保留 replan 信号字段**：
- `replanTriggered` + `abortedChildren` 字段保留（供 agent 回报 + BFS 记日志）
- BFS 不基于它们做覆盖——agent 已经在 session 内把 replan 后续流程跑完了

**如果 agent replan 后没跑完就返回**（如 gate fail 超 3 次、或遇 crossLayer 中断）：
- cw replan handler 会 append statusHistory `action='replan'`，frontier C2 扫描会反映新的 status / nextAction
- BFS 下一轮 frontier 自然反映新状态，BFS 按 status + blocked 继续调度
- 不需要覆盖 nextAction——agent 在下一轮被重新 dispatch 时，`cw handoff` 会拿到当前真实的 nextAction（可能就是 replan 之后的 plan）

**wave 层 replan**（同样不需要 replanOverride）：
- wave 的 replan 改自己的 plan 条目（testCases/tasks/files/contracts），**无级联 abort**（wave 是叶子，computeImpactCascade 恒空）
- replan 后 wave status 不变，agent 在 session 内自己跟着 cw 的 nextAction 回 planning 重走 design-review

**abort 竞态**（保留 v2 的兜底）：
- replan 级联 abort 子节点时，那些子节点的 agent 可能还在跑（pi 子进程没被 kill）
- v3 下被 abort 的子节点 agent 进程靠 timeout 兜底（超时后返回 error，但该节点已 abort → frontier 不返回 → 无害）
- 未来改进：abort 后主动 kill agent 进程（returnMeta 加 pid）

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
| 1 | workflow 脚本完整实现（每 node 一个 agent 跑到阻塞） | `.pi/workflows/recursive-split.js` + `.pi/workflows/recursive-split-utils.cjs` | spec-w + spec-c |
| 2 | topoSort 算法（含环检测 + Kahn 排序） | utils.cjs | spec-c frontier（dependsOn）|
| 3 | executeNodeNextAction（每 node 一个 agent 跑到阻塞） | 脚本内 | spec-w returnMeta |
| 4 | buildActionPrompt（推进到阻塞 prompt + clarify-advance/test-file-production hint）| utils.cjs | spec-c C1 |
| 5 | 失败传播（abortUnit）| 脚本内 | cw abort 命令 |
| 6 | detectStuckNodes（node 级熔断，MAX_NODE_ROUNDS=3）+ selectActionable | utils.cjs | cw status（跨轮对比）|
| 7 | 崩溃恢复（frontier 重建）| 脚本内 | spec-c C2 frontier |
| 8 | budget 配置（maxTokens=0）| 脚本内 | 无 |
| 9 | agent .md 定义（planner + wave-executor）| `.pi/agent/agents/` | 无 |
| 10 | startLayer 判断指引 | 主 agent prompt / AGENTS.md | 无 |

**v3 已删除的机制**（per-node 重构后不再需要）：
- ~~findInheritedWorktree + worktreeRegistry~~：当前实现 `worktree:false`（pi worker worktree 生命周期限制），registry 代码保留待未来启用
- ~~handleReplan / replanOverride~~：agent 在 session 内自洽，BFS 不再覆盖 frontier 的 nextAction（见 §5）
- ~~action 级熔断（retryCount + prevNextAction + MAX_ACTION_RETRY + PROGRESSIVE_ACTIONS 豁免）~~：被 node 级熔断（detectStuckNodes）取代

**cw 侧无额外改动**：allWavesClosed gate 已验证接受 aborted 为终态（retrospect.ts:206），C-supplement 是空操作已删除。

---

## 10. 验证里程碑

### 里程碑 1：单层串行（slice → 1 wave）
前置：spec-w 里程碑 1-2 + spec-c 里程碑 1 通过。
验证：每 node 一个 agent 跑到阻塞，agent 在 session 内连续推进多个 cw action 直到 crossLayer，gate fail 闭环，**planning 节点能走到 closeout**（聚合回扫）。
**E2E 已验证通过**：3 次 agent 调用 vs 旧模型 21 次，0 次 clarify 循环，5 个真实测试文件全绿，10.4 分钟 vs 43 分钟。重构 commit `a279f46e7`。E2E 验证记录见 `tests/e2e-report.md`。

### 里程碑 2：同层并发（slice → 2 无依赖 wave）
验证：parallel 并发 2 个 wave（每个一个 agent 跑到阻塞），各自独立推进，无 .git/index.lock 冲突。

### 里程碑 3：依赖感知串行（slice → 2 有依赖 wave）
验证：wave-2 dependsOn wave-1，topoSort 排成 sequential，wave-2 在 wave-1 完成后调度，能看到 wave-1 代码。
（注：当前实现 `worktree:false`，wave 共用 $WORKSPACE；待 pi 支持 worker worktree 后启用 per-wave worktree，见 §2 executeNodeNextAction。）

### 里程碑 4：失败传播
验证：人为让某 wave test gate 反复 fail 超 3 次（agent session 内）→ agent 返回 / node 级熔断 → cw abort → 父 slice retrospect 的 all-waves-closed 放行（aborted 也算终态）→ slice 能 closeout。

### 里程碑 5：崩溃恢复
前置：spec-c 里程碑 2 通过。
验证：BFS 中途 kill worker，重启后 frontier 重建队列，未完成节点重新派 agent（每 node 一个 agent 跑到阻塞）。
