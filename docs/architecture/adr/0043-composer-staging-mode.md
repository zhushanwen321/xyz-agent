# ADR-0043: Composer Staging Mode（暂存模式）

**状态**: Accepted
**日期**: 2026-07-29
**关联**: ADR-0042（MessageBus 架构）、ADR-0028（模型切换 RPC + 乐观更新编排）

## 背景

Composer 的 fork-ask 和 handoff-ask 功能创建新 session 时，用户在 composer 工具条选中的模型不传递给新 session。

**根因有三层**：

1. **临时态无状态隔离**：fork-mode/handoff-mode composable 只管"模式开关 + 来源锚点"，不保存/恢复模型 chip 状态。用户在临时态下切换模型 chip 会直接调 `switchModel(sessionId, ...)` RPC 改当前源 session 的模型，而非为新 session 指定模型。

2. **RPC payload 不含模型信息**：`session.fork` 和 `session.handoff` 的 ClientMessageMap payload 没有 `modelOverride`/`thinkingOverride` 字段。

3. **Runtime 创建新 session 时不消费 override**：`forkSession` 的 `buildPresetClientOptions` override 参数硬编码为 `undefined`（继承源 preset）；`HandoffService.runHandoff` 创建新 session 时连 options 都不传（纯全局默认模型）。

## 决策

引入 **Composer Staging Mode（暂存模式）**：composer 进入 fork-ask / handoff-ask 时进入暂存态，为即将创建的新 session 暂存模型/thinking 配置 + 输入文本，退出时恢复常规态。

### 命名选择

**Staging Mode（暂存模式）**——强调"为新 session 准备配置"的语义。备选方案 Transient Mode（瞬态）和 Overlay Mode（覆盖）被否决：前者过于抽象，后者暗示 UI 层叠加而非状态隔离。

### 架构

```
┌─ Composer 常规态 ─────────────────────────────────┐
│  currentModelId → 读 session/landing 真值          │
│  onModelSelect  → switchModel RPC（改源 session）   │
└───────────────────────────────────────────────────┘
         │ enterStagingMode()
         ▼
┌─ Composer 暂存态（Staging Mode）───────────────────┐
│  currentModelId → 读 stagingModel 快照             │
│  onModelSelect  → 只写 stagingModel（不改源 session）│
│  getStagingConfig → { modelOverride, thinkingOverride } │
└───────────────────────────────────────────────────┘
         │ exitStagingMode()
         ▼
┌─ Composer 常规态恢复 ──────────────────────────────┐
│  currentModelId → 读 session/landing 真值（源模型不变）│
└───────────────────────────────────────────────────┘
```

### 模型传递链路

```
Composer Staging Mode              Runtime
─────────────────────              ─────────
enterStagingMode()
  └→ 快照 currentModelId
     到 stagingModel ref

用户切模型 chip
  └→ onModelSelect
     └→ 只写 stagingModel
        （不调 switchModel RPC）

handleHandoffSend/handleForkSend
  └→ getStagingConfig()
     └→ { modelOverride, thinkingOverride }
        └→ sessionApi.handoff/fork(payload含override)
           └→ runtime handler
              └→ sessionService.create({ modelOverride, thinkingOverride })
                 └→ buildPresetClientOptions(resolution, modelOverride, thinkingOverride)
                    └→ pi 启动参数（C-RL-6 优先级：Staging > preset > 默认）

exitStagingMode()
  └→ 清空 stagingModel
     └→ chip 恢复读源 session 模型
```

### 关键约束

1. **源 session turn 不受 staging 影响**：handoff 文档生成（源 session 的 `srcClient.prompt`）始终用源 session 自身模型。staging override 只作用于新 session 创建。

2. **C-RL-6 优先级不变**：`buildPresetClientOptions` 的优先级链（Staging override > preset 字段 > 全局默认）与 Landing Chip 一致，复用现有逻辑。

3. **复用现有 composer 组件**：不新建组件实例，staging 状态是 `useComposerModelThinking` 内的 ref 快照。enter 时快照，exit 时清空，`currentModelId` computed 自动切换数据源。

4. **幂等安全**：`enterStagingMode`/`exitStagingMode` 可多次调用，staging refs 覆盖写。

## 改动范围

### Protocol（shared）
- `session.fork` payload 增加 `modelOverride?`/`thinkingOverride?`
- `session.handoff` payload 增加 `modelOverride?`/`thinkingOverride?`

### Runtime
- `session-message-handler.ts`：fork/handoff handler 透传 override
- `session-service.ts` + `session-lifecycle.ts`：forkSession 透传 override 到 `buildPresetClientOptions`
- `handoff-service.ts`：runHandoff 接收 override，create 新 session 时传入
- `interfaces.ts`：ISessionService.forkSession opts 类型扩展

### Renderer
- `api/domains/session.ts`：fork()/handoff() 签名增加 override 参数
- `useForkActions.ts`/`useHandoffActions.ts`：接收 staging config 透传
- `useComposerModelThinking.ts`：新增 staging refs + enter/exit/getStagingConfig
- `useComposerForkMode.ts`/`useComposerHandoffMode.ts`：enter/exit/send 调用 staging 方法
- `Composer.vue`：解构 staging 方法 + 注入 fork/handoff deps

## 用户体验流程

1. 用户在 session A 对话，点 handoff-ask 按钮
2. Composer 进入 Staging Mode（视觉 accent 边框 + placeholder）
3. 模型 chip 显示当前模型（快照自 session A）
4. 用户可选切换模型 chip → **只改暂存值，不影响 session A**
5. 用户输入 "请继续帮我" 并发送
6. runtime 用 session A 的模型生成 handoff 文档
7. runtime 用 **staging 模型** 创建新 session + 注入文档
8. 跳转到新 session，使用 staging 选定的模型
9. Composer Staging Mode 退出，源 session A 的模型不变
