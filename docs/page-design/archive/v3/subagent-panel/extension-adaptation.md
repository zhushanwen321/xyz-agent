# pi-subagent-workflow 扩展适配说明

> 本文档描述 pi-subagent-workflow 扩展需要做的改造，让 xyz-agent GUI 能直接操作 subagent/workflow 的生命周期（cancel/pause/resume/abort）。
>
> **背景**：xyz-agent 在左侧边栏新增了 Agents/Flows tab，可视化展示 subagent/workflow 列表和对话流。列表数据和对话流通过 runtime 直读 JSONL 实现，不依赖扩展。但操作按钮（cancel/pause/resume/abort）是扩展内部状态机操作，必须经扩展执行。
>
> **本文档给负责扩展改造的 agent 使用。**

## 1. 改造范围

| 改造项 | 文件 | 说明 |
|--------|------|------|
| `/subagents` handler 加 RPC 分支 | `src/interface/subagents.ts` | RPC 模式下解析 action（cancel），直接调 service |
| `/workflows` handler 加 RPC 分支 | `src/interface/commands.ts` | RPC 模式下解析 action（pause/resume/abort），直接调 lifecycle 函数 |
| 不改的部分 | TUI 路径、tool 定义、数据存储 | TUI 模式行为不变；tool 仍由 LLM 触发 |

**不需要改的**：
- 数据存储（JSONL / record-store / run-store）—— xyz-agent runtime 直读文件
- tool 定义（subagent/workflow/workflow-script）—— LLM 调用路径不变
- TUI 渲染（WorkflowsView / SubagentsListComponent）—— TUI 模式不变
- GUI 协议 mappers（gui-mappers.ts）—— 本次不用 GuiComponent 通道

## 2. 参考样板：ask-user 扩展的 RPC 适配模式

ask-user 扩展是 xyz-agent 处理 RPC 适配的参考样板。核心模式：

### 2.1 用 `ctx.mode === "rpc"` 判定，不要用 `ctx.hasUI`

```typescript
// ❌ 错误：hasUI 在 TUI 和 RPC 模式都为 true（dialog-capable），无法区分
if (!ctx.hasUI) { ... }

// ✅ 正确：ctx.mode === "rpc" 是唯一可信的 GUI 通道判定
const useRpc = ctx.mode === "rpc";
if (useRpc) {
  // RPC 路径：直接执行操作，不打开 TUI
} else {
  // TUI 路径：打开 overlay（原逻辑）
}
```

ask-user 源码（`extensions/ask-user/src/index.ts:249`）：

```typescript
const useRpc = ctx.mode === "rpc";
let result: Result | null;
try {
  if (useRpc) {
    // RPC 模式（xyz-agent GUI）：走 select 通道 + marker
    result = await runRpcInteraction(questions, signal, ctx);
  } else {
    // TUI 模式：自定义 Component 实时交互
    result = await ctx.ui.custom<Result | null>(
      (tui, theme, _kb, done) => { ... },
    );
  }
} catch (err) {
  // RPC 通道异常 = 真 headless，禁用工具防 LLM 重试
  if (useRpc) {
    pi.setActiveTools(
      pi.getAllTools().map(t => t.name).filter(n => n !== "ask_user"),
    );
  }
  return { ... };
}
```

### 2.2 headless 检查（print/json 模式）

```typescript
// mode 非 tui 非 rpc（print/json）= 无交互通道
if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
  // headless 模式，不能做任何交互
  return;
}
```

## 3. `/subagents` handler 改造

### 当前代码（`src/interface/subagents.ts`）

```typescript
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [<id>]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/subagents requires an interactive UI", "error");
        return;
      }
      const service = getSubagentService();
      if (!service) {
        ctx.ui.notify("subagents execution runtime not ready (session not started)", "error");
        return;
      }
      const args = argsStr.trim().split(/\s+/).filter(Boolean);
      await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);
    },
  });
}
```

**问题**：RPC 模式下 `ctx.hasUI` 为 true（守卫拦不住），走到 `createSubagentsView` → 调 `ctx.ui.custom()` → RPC 模式返回 `undefined` → 命令静默消失，用户无反馈。

### 改造后代码

```typescript
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [<id>] | /subagents cancel <id>",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      const service = getSubagentService();
      if (!service) {
        ctx.ui.notify("subagents execution runtime not ready (session not started)", "error");
        return;
      }

      const args = argsStr.trim().split(/\s+/).filter(Boolean);

      // ── RPC 模式（xyz-agent GUI）：解析 action 直接执行，不打开 TUI ──
      if (ctx.mode === "rpc") {
        const action = args[0];

        if (action === "cancel") {
          const recordId = args[1];
          if (!recordId) {
            ctx.ui.notify("Usage: /subagents cancel <id>", "warning");
            return;
          }
          const ok = service.cancel(recordId);
          ctx.ui.notify(
            ok ? `Cancelled subagent ${recordId}` : `Subagent ${recordId} not found or already finished`,
            ok ? "info" : "warning",
          );
          return;
        }

        // 无 action 或未知 action：提示用户在 GUI 中查看
        // （xyz-agent 前端已屏蔽此 command 出现在 CommandPopover，这里兜底）
        ctx.ui.notify("View subagents in the sidebar Agents tab", "info");
        return;
      }

      // ── print/json 模式（headless）：不可交互 ──
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents requires interactive mode", "error");
        return;
      }

      // ── TUI 模式：打开 list overlay（原逻辑不变）──
      await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);
    },
  });
}
```

### 改动要点

1. **新增 RPC 分支**：`ctx.mode === "rpc"` 时解析 `cancel` action，直接调 `service.cancel(recordId)`
2. **headless 兜底**：`ctx.mode !== "tui" && ctx.mode !== "rpc"`（print/json）提示不可交互
3. **TUI 路径不变**：`createSubagentsView` 只在 TUI 模式调用
4. **`service.cancel` 是同步方法**，签名 `cancel(id: string): boolean`，返回是否成功

## 4. `/workflows` handler 改造

### 当前代码（`src/interface/commands.ts`）

```typescript
export function registerWorkflowsCommand(
  api: ExtensionAPI,
  getRuns: () => Map<string, WorkflowRun>,
  deps: LauncherDeps,
): void {
  api.registerCommand("workflows", {
    description: "Open workflow interactive panel. /workflows [runId] to open a specific run.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflows requires interactive mode", "error");
        return;
      }
      // ... runId 匹配 + ctx.ui.select 选择 + openView ...
    },
  });
}
```

**问题**：同 `/subagents`——RPC 模式 `hasUI=true`，走到 `openView` → `createWorkflowsView` → `ctx.ui.custom()` → 返回 undefined。

### 改造后代码

```typescript
export function registerWorkflowsCommand(
  api: ExtensionAPI,
  getRuns: () => Map<string, WorkflowRun>,
  deps: LauncherDeps,
): void {
  api.registerCommand("workflows", {
    description: "Open workflow panel. /workflows [runId] | /workflows pause|resume|abort <runId>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // ── RPC 模式（xyz-agent GUI）：解析 action 直接执行 ──
      if (ctx.mode === "rpc") {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const action = parts[0];

        // 生命周期操作
        if (action === "pause" || action === "resume" || action === "abort") {
          const runId = parts[1];
          if (!runId) {
            ctx.ui.notify(`Usage: /workflows ${action} <runId>`, "warning");
            return;
          }
          try {
            // deps 是 LauncherDeps，与 LifecycleDeps 兼容（LauncherDeps extends LifecycleDeps）
            if (action === "pause") await pauseRun(runId, deps);
            else if (action === "resume") await resumeRun(runId, deps);
            else await abortRun(runId, deps);
            ctx.ui.notify(`Workflow ${runId}: ${action}d`, "info");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to ${action} workflow ${runId}: ${msg}`, "warning");
          }
          return;
        }

        // 无 action 或 runId：提示用户在 GUI 中查看
        ctx.ui.notify("View workflows in the sidebar Flows tab", "info");
        return;
      }

      // ── print/json 模式（headless）：不可交互 ──
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/workflows requires interactive mode", "error");
        return;
      }

      // ── TUI 模式：打开交互面板（原逻辑不变）──
      const directRunId = args.trim();
      if (directRunId) {
        const all = sortedRuns(getRuns());
        const exact = all.find((r) => r.runId === directRunId);
        if (exact) {
          await openView(exact, ctx.ui.theme, ctx, deps);
          return;
        }
        const matched = all.filter((r) => r.runId.startsWith(directRunId));
        if (matched.length === 1) {
          await openView(matched[0], ctx.ui.theme, ctx, deps);
          return;
        }
        ctx.ui.notify(`Workflow '${directRunId}' not found`, "error");
        return;
      }

      const all = sortedRuns(getRuns());
      if (all.length === 0) {
        ctx.ui.notify("No workflows in current session.", "info");
        return;
      }
      if (all.length === 1) {
        await openView(all[0], ctx.ui.theme, ctx, deps);
        return;
      }
      const entries = all.map(
        (r) => `${r.spec.scriptName} [${r.state.status}] (${r.runId.slice(0, RUNID_SHORT)})`,
      );
      const selected = await ctx.ui.select("Select workflow:", entries);
      if (!selected) return;
      const idx = entries.indexOf(selected);
      if (idx === -1) return;
      await openView(all[idx], ctx.ui.theme, ctx, deps);
    },
  });
}
```

### 改动要点

1. **新增 RPC 分支**：解析 `pause`/`resume`/`abort` action，直接调 lifecycle 函数
2. **lifecycle 函数签名**：
   - `pauseRun(runId: string, deps: LifecycleDeps): Promise<void>` — 抛错：runId 不存在 / status !== "running"
   - `resumeRun(runId: string, deps: LifecycleDeps): Promise<void>` — 抛错：runId 不存在 / status !== "paused"
   - `abortRun(runId: string, deps: LifecycleDeps, reason?: string, doneReason?: DoneReason): Promise<void>` — 抛错：runId 不存在 / status 既非 running 也非 paused（done 状态 no-op 不抛）
3. **`deps` 兼容性**：handler 接收的 `deps` 是 `LauncherDeps`，`LauncherDeps extends LifecycleDeps`，可直接传给 lifecycle 函数
4. **错误处理**：lifecycle 函数会抛（状态不合法 / runId 不存在），catch 后 notify warning
5. **TUI 路径不变**：runId 匹配 + select 选择 + openView 只在 TUI 模式执行
6. **import 需要加**：确保 `pauseRun`/`resumeRun`/`abortRun` 已从 `../orchestration/lifecycle.ts` import（当前 `commands.ts` 已 import 了这三个函数用于 `openView` 的 ViewActions，不需要额外 import）

## 5. xyz-agent 侧的调用方式

扩展改造完成后，xyz-agent runtime 通过 `client.prompt()` 发 slash command 触发操作：

```typescript
// 取消 subagent
await client.prompt(`/subagents cancel ${recordId}`);

// 暂停 workflow
await client.prompt(`/workflows pause ${runId}`);

// 恢复 workflow
await client.prompt(`/workflows resume ${runId}`);

// 终止 workflow
await client.prompt(`/workflows abort ${runId}`);
```

**关键确认：不经 LLM。** pi 的 `session.prompt()` 检测到 `/` 开头会调 `_tryExecuteExtensionCommand`，匹配到扩展注册的 command 就执行 handler 并 return（不走 agent loop / LLM）。所以这些操作是即时的，不消耗 token，不依赖 LLM 响应。

**操作反馈链路**：
```
xyz-agent 前端点 Cancel 按钮
  → runtime: client.prompt("/subagents cancel bg-xxx")
  → pi: session.prompt() → _tryExecuteExtensionCommand("subagents", "cancel bg-xxx")
  → 扩展 handler: ctx.mode === "rpc" → service.cancel("bg-xxx")
  → RecordStore 状态变 cancelled → 写 .cancelled tombstone
  → runtime fs.watch 检测文件变更 → WS 推 subagent.list 更新
  → 前端列表项变为 cancelled 态，Cancel 按钮消失
```

## 6. 不需要扩展做的事

| 能力 | 实现方式 | 扩展参与？ |
|------|----------|-----------|
| subagent 列表数据 | runtime 读 JSONL 文件 | 不参与 |
| subagent 对话流渲染 | runtime 读 JSONL → Message[] | 不参与 |
| subagent 对话流实时更新（message 级） | runtime fs.watch JSONL 增量解析 | 不参与 |
| 重启后恢复列表和历史 | JSONL 文件持久化，runtime 重扫 | 不参与 |
| workflow 列表数据 | runtime 读 workflow-state/*.jsonl | 不参与 |
| workflow phase/agent call 列表 | runtime 读 workflow-state JSONL | 不参与 |
| /subagents /workflows 从 CommandPopover 屏蔽 | xyz-agent 前端 commandStore 过滤 | 不参与 |
| 逐字 streaming（token 级） | 未来增量：扩展 onEvent → runtime | **未来需要** |

## 7. 验证方法

扩展改造完成后，可用以下方式验证：

### 7.1 手动验证（TUI 模式不受影响）

```bash
# 启动 pi TUI，输入 /subagents 和 /workflows，确认 TUI overlay 正常打开
pi
> /subagents       # 应打开列表 overlay
> /workflows       # 应打开 workflow 面板
```

### 7.2 RPC 模式验证

```bash
# 启动 pi RPC 模式，发 slash command
pi --mode rpc
# 发送 prompt: "/subagents cancel test-id"
# 预期：handler 走 RPC 分支，调 service.cancel，返回 notify（不打开 TUI）
```

### 7.3 xyz-agent 集成验证

1. 启动 xyz-agent，发起一个 background subagent
2. 在 Agents tab 看到该 subagent（running 态）
3. 点 Cancel 按钮
4. 预期：subagent 状态变为 cancelled，Cancel 按钮消失

## 8. 注意事项

1. **`ctx.hasUI` 不能用于区分 RPC 和 TUI**。两个模式 `hasUI` 都为 true。必须用 `ctx.mode === "rpc"`。

2. **`service.cancel` 是同步的**，返回 `boolean`。不需要 await，但包在 RPC handler 里用 `ctx.ui.notify` 反馈结果即可。

3. **lifecycle 函数是异步的**（`async`），会抛异常（状态不合法 / runId 不存在）。handler 里用 `try/catch` 包裹，catch 后 `ctx.ui.notify(msg, "warning")`。

4. **不要在 RPC 分支调 `ctx.ui.custom()`**。RPC 模式下该方法返回 `undefined`，会导致 handler 卡住或静默失败。

5. **TUI 路径不要改**。直接跑 pi CLI 的用户仍需要 TUI overlay。改造只加 RPC 分支，不删 TUI 分支。

6. **`deps` 类型兼容**。`commands.ts` 的 handler 接收 `deps: LauncherDeps`，传给 `pauseRun/resumeRun/abortRun` 时不需要类型转换（`LauncherDeps extends LifecycleDeps`）。
