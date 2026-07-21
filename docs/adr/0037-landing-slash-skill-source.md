# ADR-0037：landing 态 slash 命令源按 variant 分支 + skill 路由前缀归一化

- **状态**：Accepted
- **日期**：2026-07-21

## 背景（Context）

新建任务页（Landing）composer 敲 `/`，slash 浮层不显示项目维度 skill（如 `code-review`、`cw-cli`），只显示 pi extension 命令（`/goal` 等）或空。

### 根因链路

1. `CommandPopover.vue` 的 `slashCommands` computed 是**互斥双源分支**，判定条件是 `if (props.sessionId)`：
   - 有 sessionId → 走 `commandStore.getCommands(sessionId)`（pi `get_commands` 返回的 extension/prompt/skill 命令）
   - 无 sessionId → 走 `settingsStore.skills`（config 层全局扫描的 skill 列表）

2. `Landing.vue:70` 给 Composer 传的 sessionId（composerSid）= `flow.currentSessionId.value ?? props.sessionId ?? sessionStore.publicSessionId`：
   - `flow.currentSessionId.value`：延迟 create 设计下恒为 null（见 `landing-precreate-session.test.ts`）
   - `props.sessionId`：Panel 主 session，新建任务态可能非空
   - `sessionStore.publicSessionId`：runtime 启动期 `app.info` 广播的公共 session id，**model 配置好即非空（常态）**

3. 因此 landing 态 composerSid **几乎总是非空**，CommandPopover 永远走 commandStore 分支 → `settingsStore.skills` 完全读不到 → 项目维度 skill 消失。

### 测试脱节

`command-popover-landing.test.ts` L1-L4 用 `sessionId: undefined` mount 模拟 landing 态，与现实运行（composerSid 非空）脱节，测试全绿但 bug 照出。

### 潜伏 bug

修复"显示不出来"后，landing 态选中 skill 会激活一个潜伏 bug：

- CommandPopover onSelect 对 skill 类走 `skillDisplayName`（去前缀），session 态 pi 返回的 `skill:cw-cli` 归一化成 `/skill:cw-cli`（pi 认）。
- 但 landing 态 `settingsStore.skills` 的 name 是裸名 `cw-cli`，归一化后 `/cw-cli`（**pi 不认**）。
- pi 源码（`agent-session.ts:1210`）：`if (!text.startsWith("/skill:")) return text` —— skill 命令必须带 `/skill:` 路由前缀。
- 当前因"显示不出来"导致 landing 选中 skill 从未触发，bug 一直潜伏。

## 决策（Decision）

CommandPopover 的 slash 命令源**按 `variant` 分两个明确分支**（替代按 `sessionId` 互斥分支），landing 分支内部合并两份互补真源；同步修潜伏的 skill 路由前缀 bug。

### 分支结构

```
landing 态（variant==='landing'）：
  slashCommands = commandStore.getCommands(sessionId)   // publicSession 拉到的 pi extension 命令（/goal 等）
                ∪ settingsStore.skills                  // config 层全局扫描的项目+全局 skill
  不含 compact（landing 无上下文可压缩）

session 态（variant==='panel' && sessionId）：
  slashCommands = compact + commandStore.getCommands(sessionId)   // pi 是唯一真源
  不并入 settingsStore.skills
```

### 判定范式统一

landing 判定从「sessionId 有无」改为「`variant === 'landing'`」，与 `Composer.vue:280` 已有范式（`if (props.variant === 'landing')`）对齐。消除「landing 判定一会儿用 variant、一会儿用 sessionId」的不一致。

### skill 路由前缀归一化

landing 态从 `settingsStore.skills` 取的 skill，name 归一化为 `/skill:<name>`（而非裸名 `/<name>`），与 session 态 pi 返回的 skill 命令格式一致，保证选中后 pi 能正确路由。

### 数据源语义不混淆

session 态**不合并** `settingsStore.skills`。理由：
- `settingsStore.skills` 是**配置态**（config 层全局扫描，扫 `.xyz-agent/skills` + `~/.pi/agent/skills` 等固定目录）
- `commandStore.getCommands(sid)` 是**运行态**（pi 对该 session 实际 `get_commands`，根据 cwd、`--approve` 信任状态、项目级 `.pi/agent/skills` 动态决定）
- 合并会导致 session A 看到 session B 才有的项目 skill（命令泄露）、选中后 pi 不认（skill 未加载）

## 替代方案（Alternatives）

### A. Landing 不传 publicSessionId（方案 B）

`Landing.vue` 不再把 `sessionStore.publicSessionId` 作为 composerSid 兜底，强制 landing 态 sessionId=null。

- **优点**：改动最小（一行）
- **缺点**：牺牲 landing 态显示 pi extension 命令（`/goal` 等）的能力，与 `Landing.vue:66-69` 注释设计意图冲突；`useSidebar.ts:83-93` 专门为 landing 拉 publicSession 命令的逻辑变废
- **否决理由**：砍能力换简单不是长期方案

### B. 把 settingsStore.skills 塞进 commandStore（方案 C）

landing 态把 skills 手动 applyCommands 到 commandStore 的 publicSessionId 分区。

- **优点**：CommandPopover 不用改分支
- **缺点**：两套数据源（config 扫描 vs pi get_commands）混进一个 store，污染 session 命令语义；未来扩展（如 landing 专属 builtin 命令）无处安放
- **否决理由**：污染 store 语义

### C. session 态也合并 settingsStore.skills（早期方案 A 草稿）

session 态把 `settingsStore.skills` 作为"补充"并入 `commandStore` 命令。

- **否决理由**：配置态/运行态混淆（见 Decision §数据源语义不混淆）

## 后果（Consequences）

**正面**：
- 项目维度 skill 在 landing 态正确显示
- landing 判定范式与 Composer.vue 统一（variant）
- 修复潜伏的 skill 路由前缀 bug（选中即能用）
- 数据源语义清晰（配置态 vs 运行态不混淆）
- publicSessionId 设计自洽（landing 显示 `/goal` 能力保留）

**负面**：
- CommandPopover 新增 `variant` prop，调用方（Composer）需透传
- 测试需同步修正（`command-popover-landing.test.ts` 改用真实场景 mount）
