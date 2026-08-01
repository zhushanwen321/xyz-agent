# 子 Spec W：Worktree 隔离系统

> **父文档**：[spec.md](./spec.md) §13（第二轮审查发现）
> **范围**：W1（executeAndAwait 补 worktree）+ W2（wave 内 worktree 复用 + returnMeta 模式）+ W3 落地（projectKey）+ W4（依赖管理）
> **go/no-go 前提**：W3 已实测验证通过（spec.md §12.2.1）
> **修订记录**：v2（轮次 15）——改 returnMeta 模式（消除模块级变量竞态）+ 补认领前 3 处改动 + 修正 postAgentResult 改动位置

---

## 0. 问题回顾

递归方案需要 wave 层 agent 在独立 worktree 里写代码（避免并发 `.git/index.lock` 冲突）。两轮审查 + 一致性/逻辑审查发现 worktree 相关阻断：
- **W1**：workflow 的 `agent()` 经 `executeAndAwait`（非 `execute()`），后者不消费 `worktree===true`。改动涉及 **5 处**（前 3 处在 AgentCallOpts→ExecuteOptions 链路，后 2 处在 executeAndAwait 补 worktree 创建）
- **W2**：wave 的 8 个 action agent 无法共享 worktree（WorktreeHandle 不能跨 worker 线程）。需 returnMeta 模式传递 worktreePath
- **W3**：cw store 按 cwd 隔离，worktree 改 cwd → store 断裂（已验证解法：projectKey）
- **W4**：worktree 无 node_modules / npm install 经 symlink 污染主 repo

加上 F2（sessionFile 传递断裂，retrospect 读 jsonl 依赖它）。W2/F2 共用 returnMeta 解法。

---

## 1. W1：让 agent() 支持 worktree（5 处改动）

### 问题

完整链路：`worker agent({worktree:true})` → `AgentCallOpts`（无字段）→ `mapToExecuteOptions`（不透传）→ `ExecuteOptions`（已有字段）→ `SubagentService.executeAndAwait` → `runAndFinalize`（不消费 `worktree===true`）。

5 处断点：
1. `AgentCallOpts`（`orchestration/models/types.ts:70`）无 fork/worktree 字段
2. `_knownFields`（`worker-script-builder.ts:207`）白名单不含 fork/worktree → worker 层过滤
3. `mapToExecuteOptions`（`execute-options-mapper.ts:51-63`）不透传
4. `executeAndAwait`（`subagent-service.ts:505`）无 MF#7 守卫
5. `runAndFinalize`（`subagent-service.ts:668-671`）缺 `worktree===true` 创建分支

### 改动 1：AgentCallOpts 加字段（`orchestration/models/types.ts`）

```typescript
export interface AgentCallOpts {
  // ...现有字段...
  /** 继承父会话上下文（fork 模式）。worktree 隔离要求 fork:true。 */
  fork?: boolean;
  /** 文件系统隔离：true=创建新 git worktree（要求 fork:true）。 */
  worktree?: boolean;
}
```

### 改动 2：_knownFields 放行（`worker-script-builder.ts:207`）

```javascript
const _knownFields = new Set([
  "prompt", "description", "schema", "model", "scene", "label",
  "task", "agent", "phase", "skill", "timeoutMs", "cwd",
  "fork", "worktree",  // 新增
]);
```

注意：agent() 函数体（:184-201）的 `opts = firstArg`（含 prompt 的对象）分支会把整个对象透传，fork/worktree 随对象传到 postMessage。但 `task`/`agent` 分支（:187-198）逐字段提取，会丢 fork/worktree——workflow 脚本必须用 `agent({prompt, worktree:true})` 写法，不能用 `agent({task, worktree:true})`。

### 改动 3：mapToExecuteOptions 透传（`execute-options-mapper.ts:51-63`）

```typescript
return {
  // ...现有映射...
  fork: opts.fork,
  worktree: opts.worktree,
};
```

类型兼容：`AgentCallOpts.worktree?: boolean` → `ExecuteOptions.worktree?: boolean | WorktreeHandle`（boolean 是子集）。

### 改动 4：executeAndAwait 补 MF#7 守卫（`subagent-service.ts:505`）

```typescript
async executeAndAwait(opts, signal, onEvent, stream): Promise<WorkflowAgentResult> {
  this.assertReady();

  // MF#7 守卫（与 execute() :422 对称）
  if (opts.worktree === true && !opts.fork) {
    throw new Error("worktree:true requires fork:true");
  }

  // ...后续不变（步骤 1-6）...
}
```

### 改动 5：runAndFinalize 补 worktree 创建分支（`subagent-service.ts:668-671`）

当前：
```typescript
let worktreeHandle: WorktreeHandle | undefined;
if (typeof opts.worktree === "object") {
  worktreeHandle = opts.worktree;
}
```

改为：
```typescript
let worktreeHandle: WorktreeHandle | undefined;
if (typeof opts.worktree === "object") {
  worktreeHandle = opts.worktree;
} else if (opts.worktree === true) {
  // 与 execute() :448-458 对称。MF#7 守卫已在 executeAndAwait 入口保证 fork===true
  worktreeHandle = this.worktreeManager.create(this.cwd, record.id);
  record.worktreeHandle = worktreeHandle;
}
```

### 验证

实现后实测：`agent({worktree:true, fork:true})` 后检查 spawnCwd 是否为 tmpdir 下 worktree 路径（agent prompt 跑 `pwd` 返回验证）。

---

## 2. W2 + F2：returnMeta 模式（worktreePath + sessionFile 传递）

### 问题

wave 的 8 个 action agent 需共享同一 worktree。WorktreeHandle 是主线程不可序列化对象，不能跨 worker 线程传递。需把 worktreePath（字符串）和 sessionFile 传回 worker 脚本。

**v1 方案（模块级变量 `_lastWorktreePath`/`_lastSessionFile`）已废弃**——在 `parallel()` 并发下有竞态（两个 executeNode 几乎同时完成时 `_lastSessionFile` 被覆盖，读到对方的 sessionFile）。且依赖一个未文档化的 Node 消息调度不变式（agent-result handler 同步性），未来加 `await` 就崩。

### 设计：returnMeta 模式（v2，消除竞态）

agent() 增加可选 `returnMeta` 参数。设了返回 `{value, sessionFile, worktreePath, error}`，不设返回单值（向后兼容）。

#### 数据流

```
worker agent({prompt, schema, worktree:true, returnMeta:true})
  → postMessage agent-call（含 returnMeta 标志）
  → 主线程 dispatchAgentCall → executeAgentCall → runner.run → executeAndAwait
    → executeAndAwait 内部 record 创建后，record.worktreeHandle.path 可用
    → executeAndAwait 返回 WorkflowAgentResult（含 sessionFile）
  → postAgentResult 把 call.result（WorkflowAgentResult）发回 worker
    → WorkflowAgentResult 需新增 worktreePath 字段
  → worker agent-result handler：
    → returnMeta===true → resolve({value: parsedOutput??content, sessionFile, worktreePath, error})
    → returnMeta 未设 → resolve(parsedOutput ?? content)  [向后兼容]
```

#### 改动 6：WorkflowAgentResult 加 worktreePath（`orchestration/models/types.ts`）

```typescript
export interface WorkflowAgentResult {
  // ...现有字段（content/parsedOutput/usage/error/sessionFile/toolCalls）...
  /** worktree 路径（worktree 隔离时有值）。由 executeAndAwait 从 record 注入。 */
  worktreePath?: string;
}
```

#### 改动 7：executeAndAwait 注入 worktreePath（`subagent-service.ts:555-558`）

当前：
```typescript
return mapToWorkflowAgentResult(result);
```

改为：
```typescript
const wfResult = mapToWorkflowAgentResult(result);
wfResult.worktreePath = record.worktreeHandle?.path;  // 从 record 注入
return wfResult;
```

**关键**：`executeAndAwait` 内部有 `record` 引用（`:542` createRecordForMode 返回），`record.worktreeHandle` 在 W1 改动 5 后被填充。这是唯一能拿 worktreePath 的位置——`postAgentResult` 拿不到 record（它只接 callId + result）。

#### 改动 8：_knownFields 放行 returnMeta（`worker-script-builder.ts:207`）

```javascript
const _knownFields = new Set([
  ..., "fork", "worktree", "returnMeta",  // 新增
]);
```

#### 改动 9：worker agent() resolve 按 returnMeta 分支（`worker-script-builder.ts:128-145`）

当前：
```javascript
if (msg.type === "agent-result") {
  const pending = _pendingCalls.get(msg.callId);
  if (pending) {
    _pendingCalls.delete(msg.callId);
    pending.resolve(msg.result.parsedOutput ?? msg.result.content);
  }
}
```

改为：
```javascript
if (msg.type === "agent-result") {
  const pending = _pendingCalls.get(msg.callId);
  if (pending) {
    _pendingCalls.delete(msg.callId);
    const value = msg.result.parsedOutput ?? msg.result.content;
    if (pending.returnMeta) {
      // returnMeta 模式：返回带元数据的对象
      pending.resolve({
        value,
        sessionFile: msg.result.sessionFile,
        worktreePath: msg.result.worktreePath,
        error: msg.result.error,
      });
    } else {
      // 向后兼容模式：返回单值
      pending.resolve(value);
    }
  }
}
```

pending 需存 returnMeta 标志（在 agent() 发 agent-call 消息时从 opts 读取）：
```javascript
// agent() 函数体内（:226 附近），发消息时
_pendingCalls.set(callId, { resolve, reject, returnMeta: opts.returnMeta === true });
_safePost({ type: "agent-call", callId, opts, phase: _effectivePhase }, "agent-call");
```

#### 改动 10：postAgentResult 透传 worktreePath（`error-recovery.ts`）

`postAgentResult(run, callId, result, cached)` 当前发的 result 是 `call.result`（WorkflowAgentResult）。改动 7 让 WorkflowAgentResult 含 worktreePath，所以 postAgentResult **无需改动**——它已透传整个 result 对象。worker 侧（改动 9）从 `msg.result.worktreePath` 读取。

#### workflow 脚本用法

```javascript
// wave 第一个 action：建 worktree
const r1 = await agent({
  prompt: "...", schema: {...},
  fork: true, worktree: true, returnMeta: true,
  cwd: $WORKSPACE,
});
// r1 是 {value, worktreePath, sessionFile, error}
const waveWorktreePath = r1.worktreePath;
const waveSessionFile = r1.sessionFile;

// 后续 action：复用 worktree
const r2 = await agent({
  prompt: "...", schema: {...},
  fork: true, returnMeta: true,
  cwd: waveWorktreePath,  // 不传 worktree，用已有路径
});
// r2.sessionFile 是这个 agent 自己的 session
```

**消除竞态**：每次 agent() 返回的对象携带自己的 worktreePath/sessionFile，不依赖模块级共享变量。parallel() 下多个 executeNode 各自拿到自己的元数据。

---

## 3. W3 落地：cw store per-project（projectKey）

### 已验证（spec.md §12.2.1）

`git rev-parse --git-common-dir` 的 dirname（`fs.realpathSync` 解析符号链接后）在所有 worktree 场景下一致。resolveProjectKey 只读 git 元数据，与 worktree-manager 的写操作通过 git 内部锁串行化，无冲突。

### 改动 11：cw `schema.ts` 新增 resolveProjectKey

```typescript
import { execSync } from "node:child_process";
import { realpathSync, dirname, resolve, isAbsolute } from "node:path";

export function resolveProjectKey(cwd: string): string {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd, encoding: "utf-8", timeout: 5000,
    }).trim();
    if (!commonDir) return realpathSync(cwd);
    const absCommon = isAbsolute(commonDir)
      ? realpathSync(commonDir)
      : realpathSync(resolve(cwd, commonDir));
    return dirname(absCommon);
  } catch {
    return realpathSync(cwd);  // 非 git 目录降级
  }
}
```

### 改动 12：getCwJsonPath 改用 projectKey（`schema.ts:130`）

```typescript
export function getCwJsonPath(cwd: string): string {
  const projectKey = resolveProjectKey(cwd);
  return join(getCwHome(), encodeCwd(projectKey), "store.json");
}
```

### 改动 13：lockfile 路径验证（`cw-store.ts`）

验证 lockfile 构造逻辑——它应基于 store 路径（getCwJsonPath 的目录），自动跟随 projectKey。如果 lockfile 独立构造（用裸 cwd 编码），需改为复用 getCwJsonPath 的目录。

### 不改的部分

- `CwDeps.workspacePath`：仍用 cwd（worktree 路径），testRunner/gitValidator 在 worktree 跑
- `repoMeta.worktreePath`：仍记录各自 cwd

---

## 4. W4：依赖管理（node_modules）

### 问题

worktree 是 `git worktree add HEAD`（新 checkout），无 node_modules。worktree-manager 有 symlink 主 repo node_modules 的 best-effort 逻辑，但引入新依赖时主 repo 也没有。worktree 的 node_modules 是主 repo 的 symlink——wave agent 在 worktree 里 `pnpm add` 会改主 repo。

### 策略：agent prompt 硬约束 + wave 工具集限制

**MVP 策略 A（推荐）**：
- worktree-manager 现有 symlink 主 repo node_modules（已有逻辑）
- **wave-executor agent 的 prompt 硬约束**：「禁止执行任何包管理命令（npm install / pnpm add / yarn add）。如需新依赖，在 wave plan 阶段记录依赖清单，由主 agent 在派发 wave 前在主 repo 批量安装」
- 依赖安装不是 wave 的职责——由主 agent（或 workflow 脚本）在 BFS 开始前统一执行

**为什么"概率低"的表述是错的**（上一版 v1 的判断被逻辑审查推翻）：多 wave 改同依赖不同版本时，symlink 让并发 `pnpm add` 互相覆盖主 repo package.json/lockfile，不是"概率低"而是"多 wave 依赖场景必然冲突"。

**残余风险**：即使 prompt 约束，LLM 可能违规。缓解：wave-executor 的 tools 白名单排除包管理（如果 pi 支持 tool 级限制）；或 worktree 内的 `pnpm add` 失败（删除 symlink 改为独立 node_modules——策略 B）。

**策略 B（备选，隔离干净但慢）**：worktree 内独立 npm install（不 symlink），每个 worktree 重复装依赖。代价：磁盘 + 时间。但隔离干净，主 repo 不被污染。适用于"多 wave 改依赖"的高冲突场景。

---

## 5. 改动清单总表

| # | 文件 | 改动 | 关联 | 工作量 |
|---|------|------|------|--------|
| 1 | `types.ts` AgentCallOpts | 加 fork/worktree 字段 | W1 | 小 |
| 2 | `worker-script-builder.ts` _knownFields | 放行 fork/worktree/returnMeta | W1/W2 | 小 |
| 3 | `execute-options-mapper.ts` mapToExecuteOptions | 透传 fork/worktree | W1 | 小 |
| 4 | `subagent-service.ts` executeAndAwait | 补 MF#7 守卫 | W1 | 小 |
| 5 | `subagent-service.ts` runAndFinalize | 补 `worktree===true` 创建分支 | W1 | 小 |
| 6 | `types.ts` WorkflowAgentResult | 加 worktreePath 字段 | W2 | 小 |
| 7 | `subagent-service.ts` executeAndAwait :558 | 注入 record.worktreeHandle.path | W2 | 小 |
| 8 | （已含在改动 2）| _knownFields 放行 returnMeta | W2 | — |
| 9 | `worker-script-builder.ts` agent-result handler | returnMeta 分支 resolve | W2/F2 | 小 |
| 10 | （无需改动）| postAgentResult 自动透传 result | W2 | — |
| 11 | cw `schema.ts` | 新增 resolveProjectKey | W3 | 小 |
| 12 | cw `schema.ts` getCwJsonPath | 改用 projectKey | W3 | 小 |
| 13 | cw `cw-store.ts` lockfile | 验证跟随 store 路径 | W3 | 小 |

**pi/subagent-workflow 侧**：改动 1-9（4 个文件：types.ts / worker-script-builder.ts / execute-options-mapper.ts / subagent-service.ts）
**cw 侧**：改动 11-13（2 个文件：schema.ts / cw-store.ts）

### W1 回归验证（mandatory extension 影响面）

W1 改动的是共享代码路径（subagent-service / worker-script-builder），所有 subagent 调用都经过。验证：
- 跑现有 pi-subagent-workflow 测试套件
- 手动验证非递归 subagent 调用（普通 `subagent` 工具）仍正常工作
- 改动设计上已考虑兼容（新增分支/字段/函数，不传 worktree 时行为不变）

---

## 6. 验证里程碑

### 里程碑 1：W1 验证（worktree 真的创建了吗）

```js
const r = await agent({
  prompt: "跑 pwd 并返回结果", schema: { path: "string" },
  fork: true, worktree: true, returnMeta: true, cwd: $WORKSPACE,
});
// 验证：r.worktreePath 非 null，r.value.path 等于 r.worktreePath
```

### 里程碑 2：W2 验证（wave 内 worktree 复用）

```js
// 两个 agent 复用同一 worktree
const r1 = await agent({
  prompt: "echo hello > test.txt",
  fork:true, worktree:true, returnMeta:true, cwd:$WORKSPACE,
});
const r2 = await agent({
  prompt: "cat test.txt 返回内容", schema:{content:"string"},
  fork:true, returnMeta:true, cwd: r1.worktreePath,
});
// 验证：r2.value.content === "hello"（agent-2 看到了 agent-1 写的文件）
```

### 里程碑 3：W3 验证（cw store 跨 worktree 共享）

```bash
# 在主 repo 创建 wave
cw create wave --slug test --objective "..."
# 在 wave worktree 里 cw tree 能看到该 wave
cd /tmp/.../wave-worktree && cw tree
```

### 里程碑 4：returnMeta 并发安全验证

```js
// 并发两个 agent（各自建 worktree），验证不交叉
const [r1, r2] = await parallel([
  agent({ prompt:"echo A", fork:true, worktree:true, returnMeta:true, cwd:$WORKSPACE }),
  agent({ prompt:"echo B", fork:true, worktree:true, returnMeta:true, cwd:$WORKSPACE }),
]);
// 验证：r1.worktreePath !== r2.worktreePath（各自独立 worktree）
// 验证：r1.sessionFile !== r2.sessionFile（各自独立 session）
```

### 里程碑 5：端到端（单 wave 完整流程）

一个 wave 的 8 个 action 在同一 worktree 里走完，test gate pass。验证 fork 深度 ≤ 4（远低于 MAX_FORK_DEPTH=10）。
