# ADR-0044: Composer Staging 策略模式（行为层）

**状态**: Accepted
**日期**: 2026-07-29
**关联**: ADR-0043（Composer Staging Mode 模型暂存层）、ADR-0028（模型切换 RPC）

## 背景

ADR-0043 解决了「fork-ask/handoff-ask 创建新 session 时模型不传递」的问题，引入了 Staging Mode 的**模型暂存层**（`useComposerModelThinking` 的 stagingModel/stagingThinking refs）。但 fork-ask/handoff-ask 的**模式状态机 + 行为路由**仍散落在多处，随着功能演进暴露出扩展性问题和体验缺口：

### 散落问题

Composer 的「当前处于哪种 staging 模式」由 3 个独立 boolean 表达（forkMode / handoffMode / isBashMode），导致行为路由散落：

| 散落点 | 问题 |
|--------|------|
| `useComposerModeVisual` boxClass/placeholder | 四级 `||`/`??` 优先级链硬编码（fork > handoff > bash > 默认） |
| `Composer.vue` idle send 按钮 title | 三元嵌套 `forkMode ? forkSend : handoffMode ? handoffSend : send` |
| `Composer.vue` onSend 分流 | if-else 链（fork > handoff > landing > bash > compact > send） |
| fork↔handoff 互斥 | 双向 watch 散落两处（Composer watch forkMode + handoff deps.exitForkMode） |

### 体验缺口

handoff 发送后进行中（源 session 跑 handoff turn 生成文档），Composer 的 stop 按钮调的是 `message.abort`（中断 LLM turn），**不是** `session.abortHandoff`（中断整个 handoff inflight）。用户无法从 Composer 取消 handoff——取消入口原本在已删除的 notice overlay 块上。

用户要求：删除「正在交接…」/「正在生成交接文档…」提示，取消入口移到 composer stop 按钮。这要求 Composer 能区分「普通 LLM turn 进行中」与「handoff inflight 进行中」，按类型路由 abort。

## 决策

引入 **StagingAction 策略接口**（`staging-types.ts`）：把每种 staging type（fork/handoff）的完整行为契约收敛为单个策略对象，Composer 经 `useComposerStaging` 的 `activeStaging` 统一消费，消除散落判断。

### 与 ADR-0043 的层次区分

ADR-0043 管**模型暂存层**（"进入 staging 时快照模型/thinking"），明确「不抽象，用 ref 快照」。**此决策保留不动。**

本 ADR 管**更高一层：模式状态机 + 发送/取消行为路由**。两者是不同层次的抽象，互不冲突：

```
┌─ 行为层（本 ADR / ADR-0044）─────────────────────┐
│  StagingAction 策略：enter/exit/send/abort/visual │
│  useComposerStaging 聚合：activeStaging 路由       │
├─ 模型暂存层（ADR-0043，不变）──────────────────────┤
│  stagingModel/stagingThinking refs                 │
│  enterStagingMode/exitStagingMode/getStagingConfig │
├─ 底层模式 composable（不变）───────────────────────┤
│  useComposerForkMode / useComposerHandoffMode      │
│  （实现 StagingAction 接口，保持 expose 兼容）     │
└────────────────────────────────────────────────────┘
```

### StagingAction 接口契约

```typescript
interface StagingAction {
  type: StagingType  // 'fork' | 'handoff'

  // A 阶段：暂存态（发送前）
  isActive: ComputedRef<boolean>
  enter: (source: StagingSource) => void
  exit: () => void
  send: (text: string, staging: StagingConfig) => Promise<void>
  allowsEmptySend: boolean    // handoff 允许空 reply；fork 必须有 content
  handleEsc: (e: KeyboardEvent) => boolean

  // B 阶段：进行中态（发送后）
  isInProgress: ComputedRef<boolean>   // handoff → isHandingOff；fork → false
  abort?: (sessionId: string) => Promise<void>  // handoff → abortHandoff；fork 无

  // 视觉
  visual: { boxClass, placeholder, chipLabelKey, chipIcon }
}
```

分两阶段对齐 Composer 生命周期：A 阶段（发送前，mode 已开，走 send 分流）；B 阶段（发送后，操作进行中，走 abort 路由）。

### 关键设计决策

1. **保留底层 composable 不拆**：`useComposerForkMode`/`useComposerHandoffMode` 保持原有 ref 状态、channel watch、视觉派生，通过 `asStagingAction()` 方法包装成 StagingAction。不破坏 expose 契约（`vm.enterForkMode` 等保留），现有测试不受影响。

2. **activeStagingType 派生而非独立 ref**：模式可通过多种路径翻转（expose 方法、channel signal、session 切换 exit），独立 ref 无法同步。改为派生 `fork.isActive || handoff.isActive`（fork 优先，对齐原 boxClass 链优先级）。互斥编排在 `enter()` 里显式调旧 action.exit 保证。

3. **send 的 staging 参数兼容**：StagingAction.send 接收外部传入的 staging 配置，但底层 handleXxxSend 内部自取 `deps.getStagingConfig()`。两者来自同一个 `useComposerModelThinking.getStagingConfig`，传参与自取等价。保留双层是为接口对称（未来可能有 staging 配置不来自 useComposerModelThinking 的场景）。

### handoff 体验修复

- **删除两个提示**：「正在交接…」overlay 块（MessageStream.vue）+「正在生成交接文档…」system notice（useChat.ts 的 session.handoffStarted handler）
- **取消入口移到 composer stop 按钮**：handoff 进行中（isHandingOff=true）时，stop 按钮经 `staging.abortIfInProgress` 路由调 `abortHandoff`（session.abortHandoff RPC），而非 `abort`（message.abort）
- **isHandingOff store 状态保留**：chatStore 的 handingOffSessions Set 仍用于 LRU 豁免、clearIndependentTransient 等逻辑控制，只是不再有 UI notice 显示

## 扩展指引

新增 staging type（如未来可能的 `branch-ask` / `compact-ask`）只需：
1. `staging-types.ts` 的 `StagingType` 加枚举值
2. 新建 `useComposerXxxMode.ts` composable（参照 fork/handoff 范式）+ `asStagingAction()` 方法
3. `Composer.vue` 的 `useComposerStaging({ fork, handoff, xxx })` 注册
4. `activeStagingType` 派生链加新 type（按优先级排序）

Composer 的 onSend/onAbort/boxClass/title/mode-chip **无需改动**——它们都经 activeStaging 路由，与具体 type 解耦。

## 不做

- 不拆 useComposerForkMode/useComposerHandoffMode 的内部实现（它们作为 StagingAction 的具体实现保留）
- 不改 ADR-0043 的模型暂存层（stagingModel/stagingThinking refs）
- 不改 useForkActions/useHandoffActions（features 层编排，已是正确的 RPC 调用点）
- 不清理 runtime 的 session.handoffStarted 广播（前端不再消费，但保留无害；删广播超出前端重构范围）

## 标记说明

- `[HISTORICAL]`：本 ADR 记录的是 2026-07-29 的架构决策。散落的 if-else/优先级链是重构前的状态，**不允许回退**。
