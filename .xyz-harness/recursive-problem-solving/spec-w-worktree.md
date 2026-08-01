# 子 Spec W：Worktree 隔离系统

> **父文档**：[spec.md](./spec.md) §13（第二轮审查发现）
> **范围**：W1（executeAndAwait 补 worktree）+ W2（wave 内 worktree 复用）+ W3 落地（projectKey）+ W4（依赖管理）+ F2（sessionFile 传递）
> **go/no-go 前提**：W3 已实测验证通过（spec.md §12.2.1）

---

## 0. 问题回顾

递归方案需要 wave 层 agent 在独立 worktree 里写代码（避免并发 `.git/index.lock` 冲突）。但两轮审查发现 4 个 worktree 相关阻断：
- **W1**：workflow 的 `agent()` 经 `executeAndAwait`（非 `execute()`），后者不消费 `worktree===true`
- **W2**：wave 的 9 个 action agent 无法共享 worktree（WorktreeHandle 不能跨 worker 线程）
- **W3**：cw store 按 cwd 隔离，worktree 改 cwd → store 断裂（已验证解法：projectKey）
- **W4**：worktree 无 node_modules / npm install 经 symlink 污染主 repo

加上 F2（sessionFile 传递断裂，retrospect 读 jsonl 依赖它）。

---

## 1. W1：executeAndAwait 补 worktree 创建

### 问题

`SubagentService` 两个入口：
- `execute()`（subagent-tool 路径，:419-458）——有 MF#7 守卫 + `worktreeManager.create()` ✅
- `executeAndAwait()`（workflow 路径，:505）→ `runAndFinalize()`（:638）——**缺** `worktree===true` 分支 ❌

`runAndFinalize` 的 :668-671 只处理 `typeof opts.worktree === "object"`（预创建 handle），`worktree===true`（boolean）不命中 → worktreeHandle 保持 undefined → spawnCwd 落回 ctx.cwd → 零隔离。

### 改动（3 处）

**改动 1**：`subagent-service.ts` `executeAndAwait` 入口补 MF#7 守卫（在 record 创建之前）

```typescript
// executeAndAwait 方法开头（:505 附近），在 createRecord 之前
if (opts.worktree === true && !opts.fork) {
  throw new Error("worktree:true requires fork:true (worktree isolation only applies to forked sessions).");
}
```

**改动 2**：`subagent-service.ts` `runAndFinalize` 补 worktree 创建分支（:668-671）

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
  // 与 execute() :448-458 对称：worktree===true 时创建新 worktree
  // MF#7 守卫已在 executeAndAwait 入口保证 fork===true
  worktreeHandle = this.worktreeManager.create(this.cwd, record.id);
  record.worktreeHandle = worktreeHandle;
}
```

**改动 3（W2 相关，见下）**：worktree 创建后，worktree 路径需回传给 workflow 脚本（当前不回传）。

### 验证

实现后必须实测：workflow 脚本里 `agent({worktree:true, fork:true})` 是否真的 spawn 到独立 worktree。验证方法：agent prompt 让它跑 `pwd`，检查返回值是否为 tmpdir 下的 worktree 路径（而非主 cwd）。

---

## 2. W2：wave 内 worktree 复用机制（核心难点）

### 问题

决策 A（每 action 一个 agent）+ worktree 隔离粒度冲突：wave 的 9 个 action agent 若每个都 `worktree:true`，则 9 个独立 worktree，互相看不到代码（execute agent 写 worktree-A，test agent 进 worktree-B 看不到代码 → test gate 必败）。

worktree 隔离的正确粒度是**每 wave 一个 worktree**（同 wave 的 9 个 action 共享），不是每 action 一个。

### 设计：worktree-group 复用协议

核心思路：worktree 生命周期绑 wave。第一个 action 创建 worktree 拿到路径，后续 action 复用该路径（作为 `cwd` 传入，不传 `worktree:true`）。

#### 数据流

```
wave 的 9 个 action agent：
  Action 1 (clarify):
    agent({ prompt, schema, fork:true, worktree:true, cwd: $WORKSPACE })
    → SubagentService 创建 worktree-W，spawn cwd = worktree-W
    → agent 在 worktree-W 里跑，返回 schema { ..., __worktreePath: "/tmp/.../worktree-W" }
       ↑ W1 改动 3：agent() 返回值需含 worktree 路径

  Action 2-9 (plan/design-review/execute/test/...):
    agent({ prompt, schema, fork:true, cwd: worktreePath })  // 不传 worktree
    → SubagentService 用传入的 cwd（worktree-W 路径）作为 spawn cwd
    → 所有 agent 在同一个 worktree-W 里工作

  closeout 后:
    workflow 脚本调 cleanupWorktree(worktreePath) 销毁 worktree-W
```

#### 改动

**改动 3（W1 延续）**：agent() 返回值需含 worktree 路径。

当前 `worker-script-builder.ts:144`：`pending.resolve(msg.result.parsedOutput ?? msg.result.content)`。

agent() 返回的是 AgentResult 的子集。worktree 路径不在 AgentResult 里——它在 `record.worktreeHandle.path`（主线程的 record 上）。要让 worker 脚本拿到 worktree 路径，需要：

方案 A（推荐）：在 `postAgentResult`（主线程发回 worker 的消息）里附加 `worktreePath` 字段。

```typescript
// error-recovery.ts 或 dispatchAgentCall 里，agent-result 消息增加字段
postAgentResult(callId, {
  ...result,
  worktreePath: record.worktreeHandle?.path,  // 新增
});
```

worker 侧（`worker-script-builder.ts:128-145`）改为：
```typescript
if (msg.type === "agent-result") {
  const pending = _pendingCalls.get(msg.callId);
  if (pending) {
    _pendingCalls.delete(msg.callId);
    // 仍 resolve 单值（向后兼容），但把 worktreePath 挂到特殊属性
    const value = msg.result.parsedOutput ?? msg.result.content;
    _lastWorktreePath = msg.result.worktreePath;  // 模块级变量，供 worktreePath() 读取
    pending.resolve(value);
  }
}
```

新增全局函数（与 agent/parallel 同级注入）：
```javascript
function worktreePath() { return _lastWorktreePath; }
```

workflow 脚本用法：
```js
const r1 = await agent({..., worktree:true});
const wtPath = worktreePath();  // 拿到 worktree 路径
// 后续 action 用 cwd: wtPath
const r2 = await agent({..., cwd: wtPath});
```

方案 B（备选）：agent() 返回值改为对象 `{value, worktreePath}`，破坏兼容。不推荐。

**改动 4**：workflow 脚本的 wave 执行模板（spec.md §12.4 阶段二伪代码修正）

```js
// wave 的 9 个 action
const waveActions = ["clarify", "plan", "design-review", "execute", "test", "exec-review", "retrospect", "closeout"];
let waveWorktreePath = null;

for (const action of waveActions) {
  const agentOpts = {
    prompt: `完成 unitId=${child.unitId} 的 ${action}...`,
    schema: ...,
    fork: true,
  };
  
  if (action === waveActions[0]) {
    // 第一个 action：创建 worktree
    agentOpts.worktree = true;
    agentOpts.cwd = $WORKSPACE;
  } else {
    // 后续 action：复用 worktree
    agentOpts.cwd = waveWorktreePath;
  }
  
  const result = await agent(agentOpts);
  if (action === waveActions[0]) {
    waveWorktreePath = worktreePath();  // 拿到 worktree 路径
  }
}
```

**改动 5**：worktree cleanup。closeout 后销毁 worktree。

worktree-manager 现有 `cleanup(handle)` 方法（worktree-manager.ts）。workflow 脚本在 wave 的所有 action 完成后调 cleanup。但 worker 脚本没有 handle 对象（只有路径字符串）。需要：
- 新增全局函数 `cleanupWorktree(path)`，worker 发消息给主线程，主线程按 path 找到 handle 并 cleanup
- 或：不立即 cleanup，靠 worktree-manager 的 reaper（已有孤儿清理机制，按 pid 死活判孤儿）定期回收

**简化方案**（推荐 MVP）：不立即 cleanup，靠 reaper 回收。代价是 worktree 短暂堆积，但避免跨线程 cleanup 协议的复杂度。

---

## 3. W3 落地：cw store per-project（projectKey）

### 已验证（spec.md §12.2.1）

`git rev-parse --git-common-dir` 的 dirname（用 `fs.realpathSync` 解析符号链接后）在所有 worktree 场景下一致。

### 改动（cw 侧）

**改动 6**：`schema.ts` 新增 `resolveProjectKey`

```typescript
import { execSync } from "node:child_process";
import { realpathSync, dirname } from "node:path";

/**
 * 从 cwd 反查项目级 key（所有 worktree 共享同一 key）。
 * 用 git common-dir 的父目录，fs.realpathSync 解析符号链接。
 * 非 git 目录降级为 cwd 本身（per-cwd 隔离）。
 */
export function resolveProjectKey(cwd: string): string {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd, encoding: "utf-8", timeout: 5000,
    }).trim();
    if (!commonDir) return realpathSync(cwd);
    const absCommon = realpathSync(resolve(cwd, commonDir));
    return dirname(absCommon);
  } catch {
    return realpathSync(cwd);  // 非 git 目录降级
  }
}
```

**改动 7**：`schema.ts` `getCwJsonPath` 改用 projectKey

```typescript
export function getCwJsonPath(cwd: string): string {
  const projectKey = resolveProjectKey(cwd);
  return join(getCwHome(), encodeCwd(projectKey), "store.json");
}
```

**改动 8**：lockfile 路径跟随 store（`cw-store.ts`）

lockfile 当前路径基于 store 路径。`getCwJsonPath` 改了，lockfile 自动跟随（如果 lockfile 是 `storePath + ".lock"`）。验证 lockfile 的构造逻辑，确保它用 projectKey 编码后的路径，不是裸 cwd。

### 不改的部分

- `CwDeps.workspacePath`：仍用 cwd（worktree 路径），testRunner/gitValidator 在 worktree 跑
- `repoMeta.worktreePath`：仍记录各自 cwd

### 迁移

旧 store 路径 `~/.cw/<encodeCwd(cwd)>/`，新路径 `~/.cw/<encodeCwd(projectKey)>/`。主 repo 的 cwd == projectKey（普通 repo），迁移无影响。worktree 场景下旧 store 可能为空（之前根本不工作），无需迁移。建议 `getCwJsonPath` 检测旧路径存在时打印 migration 提示。

---

## 4. W4：依赖管理（node_modules）

### 问题

worktree 是 `git worktree add HEAD`（新 checkout），无 node_modules。worktree-manager 有 symlink 主 repo node_modules 的 best-effort 逻辑（:97），但引入新依赖时主 repo 也没有。

### 策略：分层处理

**策略 A（推荐 MVP）：worktree-manager 现有 symlink + agent prompt 约束**

- worktree 创建时 symlink 主 repo node_modules（已有逻辑）
- agent prompt 约束："新增依赖先在主 worktree（$WORKSPACE）执行 `pnpm add xxx`，再在 wave worktree 里使用"
- 依赖安装不是 wave 的职责，是"前置准备"——由主 agent 或 workflow 脚本在派发 wave 前执行

**策略 B（备选）：worktree 内独立 npm install**

- 每个 worktree 自己 `npm install`（不 symlink）
- 代价：每个 worktree 重复装依赖，慢 + 磁盘
- 优点：完全隔离，主 repo 不被污染

**决策**：MVP 用策略 A。worktree-manager 已有 symlink 逻辑，只需在 wave agent prompt 里加约束。

### npm install 污染问题（§13 问题 H）

worktree 的 node_modules 是主 repo 的 symlink。wave agent 在 worktree 里 `npm install winston` 实际改主 repo node_modules。

**缓解**：agent prompt 约束"不要在 wave worktree 里 npm install，依赖在主 repo 装"。如果 agent 违规（在 worktree 里装了），影响是主 repo 多了依赖——不是致命的（主 repo 本来也要装这个依赖）。最坏情况是并发 wave 装了冲突版本的依赖，但概率低。

---

## 5. F2：sessionFile 传递通道（retrospect 读 jsonl 的前提）

### 问题

`worker-script-builder.ts:144`：`pending.resolve(msg.result.parsedOutput ?? msg.result.content)`——丢弃了 AgentResult.sessionFile。

### 设计：worktreePath 模式的推广

W2 改动 3 已经在 agent-result 消息里附加了 `worktreePath`。用同样的模式附加 `sessionFile`：

```typescript
// postAgentResult 消息增加字段
postAgentResult(callId, {
  ...result,
  worktreePath: record.worktreeHandle?.path,
  sessionFile: result.sessionFile,  // 新增
});
```

worker 侧新增全局函数：
```javascript
let _lastSessionFile = null;
// agent-result 消息处理里
_lastSessionFile = msg.result.sessionFile;

function lastSessionFile() { return _lastSessionFile; }
```

workflow 脚本用法：
```js
const r = await agent({...});
const sf = lastSessionFile();  // 拿到该 agent 的 session 文件路径
// retrospect 时传给 retrospect agent
```

### 兼容性

`worktreePath()` / `lastSessionFile()` 是新增全局函数，不影响现有 workflow 脚本（它们不调这些函数）。agent() 的返回值仍为单值（parsedOutput/content），向后兼容。

### retrospect agent 怎么用 sessionFile

retrospect agent 的 prompt 含子 wave 的 sessionFile 路径列表：
```
你是 slice 的 retrospect agent。子 wave 的执行记录在以下 session 文件中：
- wave-xxx: /path/to/session.jsonl
- wave-yyy: /path/to/session.jsonl
请用 bash 读取这些文件，复盘子 wave 的执行质量，填写 childUnitIdsEvidence。
```

agent 用 bash 工具（cat/jq）读 jsonl，提取 tool 调用轨迹，做真实复盘。

---

## 6. 改动清单总表

| # | 文件 | 改动 | 关联 |
|---|------|------|------|
| 1 | `subagent-service.ts` executeAndAwait | 补 MF#7 守卫 | W1 |
| 2 | `subagent-service.ts` runAndFinalize :668-671 | 补 `worktree===true` 创建分支 | W1 |
| 3a | error-recovery.ts postAgentResult | agent-result 消息附加 worktreePath + sessionFile | W2/F2 |
| 3b | worker-script-builder.ts | 新增 `worktreePath()` / `lastSessionFile()` 全局函数 | W2/F2 |
| 4 | （workflow 脚本模板）| wave 内复用 worktree 路径 | W2 |
| 5 | worktree-manager（可选）| reaper 回收 wave worktree | W2 |
| 6 | cw `schema.ts` | 新增 `resolveProjectKey` | W3 |
| 7 | cw `schema.ts` getCwJsonPath | 改用 projectKey | W3 |
| 8 | cw `cw-store.ts` lockfile | 验证跟随 store 路径 | W3 |

**pi/subagent-workflow 侧**：改动 1-3（3 个文件）
**cw 侧**：改动 6-8（2 个文件）
**workflow 脚本**：改动 4-5（脚本模板）

---

## 7. 验证里程碑

### 里程碑 1：W1 验证（worktree 真的创建了吗）

```js
// workflow 脚本
const r = await agent({
  prompt: "跑 pwd 并返回结果",
  schema: { path: "string" },
  fork: true,
  worktree: true,
  cwd: $WORKSPACE
});
console.log("worktree path:", worktreePath());
console.log("agent pwd:", r.path);
// 验证：worktreePath() 非 null，r.path 等于 worktreePath()
```

### 里程碑 2：W2 验证（wave 内 worktree 复用）

```js
// 两个 agent 复用同一 worktree
const r1 = await agent({ prompt: "echo hello > test.txt", fork:true, worktree:true, cwd:$WORKSPACE });
const wt = worktreePath();
const r2 = await agent({ prompt: "cat test.txt 返回内容", schema:{content:"string"}, fork:true, cwd: wt });
// 验证：r2.content === "hello"（agent-2 看到了 agent-1 写的文件）
```

### 里程碑 3：W3 验证（cw store 跨 worktree 共享）

```bash
# 在主 repo 创建 wave
cw create wave --slug test --objective "..."
# 在 wave worktree 里 cw tree 能看到该 wave
cd /tmp/.../wave-worktree && cw tree
```

### 里程碑 4：端到端（单 wave 完整流程）

一个 wave 的 9 个 action 在同一 worktree 里走完，test gate pass。
