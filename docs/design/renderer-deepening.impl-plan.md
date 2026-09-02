# renderer-deepening 实施计划

基线: c67842c2e | 来源设计: docs/design/renderer-deepening.md（v4, commit fb729ebe3） | 日期: 2026-09-03

## 0 章节映射

| 内容 | 设计文档实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（SCQA + 设计目标 G1-G6 + In-scope/Out-of-scope） |
| 终态/机制 | §3.1 终态（开发者视角六场景 A-F）+ §3.2 整体策略对比 + §3.3 关键决策 D1-D13 |
| 验收场景表 | §4 验收（A1-A8 表 + 各组验收投入映射） |
| 下一层拆分 | §5 下一层拆分（波次表 13 unit 种子 + 文件改动地图 W1-W6） |
| 待验证检查点 | §5 探针清单（P0-a/b/c 已实证 ✅；P1/P2/P3/P4/P5 ⛔ 带失败降级路径） |

对抗式审查证据：`.review/renderer-deepening-review-r1.md`（R1 全量 + R2 聚焦复审，R2 总结论 **0 must-fix**）。

## 1 目标快照（逐字摘录）

- **G1 一处改**：Session 切入链、seq 协议、入站路由知识各有唯一代码载体——改一处即全效，不靠注释跨文件同步。
- **G2 一个 SSOT**：command/fileSearch 双轨收口；新增 server-push 消息类型 = 一行声明式条目 + 一个 effect 函数。
- **G3 诚实接口**：接口不宣告不存在的能力（死面清零）；chat store 消费方只学自己那面。
- **G4 测试面 = 调用面**：use-connection / seq 协议的测试经 seam 注入，不再 mock 四个模块内部。
- **G5 零行为回归**：除 §3.3 D4（切入链时序纠正）与 D13（branchSummary entry 化）两处显式声明的行为变化外，全部改动行为等价。
- **G6 每波独立可交付、可回滚**（沿用逐域绞杀纪律）。

**Out-of-scope（摘录）**：mock 轨与 real 轨语义对齐（Card 9，挂起 P3）；core root barrel 公共面治理（P6）；settings/compat-fields.ts 归位；new-task-search flow.ts 聚合返回面收窄；mobile 壳对接 core bootstrap。

**两处显式行为变化（G5 例外）**：D4 统一链采壳版时序（panel 先于 hydrate，影响面 = core.selectSession 三处消费路径）；D13 branchSummary entry 化（live 'Branched' → 与 reload `rawSummary ?? ''` 收敛一致）。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u1.1 | D10 不变量工厂化 + 常量 SSOT + barrel 回引去环 | `core/src/transport/api/request.ts`、`core/src/transport/use-connection.ts`、`core/src/extension-host/message-bus-bridge.ts`、`renderer/src/composables/shell/useExtensionHostBridge.ts`、`core/src/domain/chat/{lru,changeset,timers}.ts`、`core/src/transport/mock/`（grep `@xyz-agent/core` 自回引处）+ 相关测试 | — | plain | ① core+renderer typecheck/test 绿；② grep：`Object.assign(new Error` + disconnected 组合零命中（4 处归工厂）；③ EXTENSION_BRIDGE_TYPES 单点定义（core 导出，壳 import）；④ core src 内自 barrel 回引零命中 |
| u1.2 | D11 死面删除 + dormant 注释 | `core/src/transport/api/events.ts`、`core/src/transport/use-connection.ts`（toast 字段）、`renderer/src/composables/useConnection.ts`（useToast 注入）、`core/src/platform/port.ts`、`renderer/src/platform/desktop-platform.ts`、`mobile-renderer/src/platform/mobile-platform-adapter.ts`（+ mobile-shell.spec.ts）、`core/src/extension-host/builtin/tasks/`（删整目录）、`core/src/domain/session/effects/panel-orchestration.ts`（并入 api-port.ts）、`core/src/domain/session/api-port.ts`、`core/src/extension-host/activation-manager.ts` + 相关测试 | u1.1 | plain | ① core+renderer typecheck/test 绿；② grep：events.dispatch 别名 / PlatformPort.ipc / builtin/tasks / panel-orchestration 独立文件零命中；③ activation-manager 头注含 dormant 标记 |
| u1.3 | D9 ensureDispatcher 可选注入 + 动态 import 回直 + 测试改写 | `core/src/transport/use-connection.ts`（ensureDispatcher 签名）、`core/src/coordination/route-inbound.ts`（:351-363 回静态）、`core/src/transport/__tests__/use-connection-reconnect-resubscribe.test.ts`、`core/src/transport/__tests__/use-connection-clear-pending.test.ts` | u1.2 | plain | ① core test 绿；② 上述测试 vi.mock 模块数 ≤1（仅 ws-client）+ dispatcher 注入；③ route-inbound.ts 无 `await import` 的 subscribe 动态解析；④ renderer 测试全绿（P5 探针：受影响测试全量跑，失败则保留动态 import 其余照做） |
| u2.1 | D7 command/fileSearch 双轨收口（P1 前置） | `renderer/src/composables/features/search/{useSearch,useSearchJump,useFileSearch}.ts`、`renderer/src/stores/command.ts`（删）、`renderer/src/stores/fileSearch.ts`（删）、`renderer/src/composables/features/command/useCommandStore.ts`（如需壳适配微调）、壳对应测试（dev 时 grep 定位）、`core/src/domain/new-task-search/`（P1 差集补齐） | u1.3 | plain | ① P1 对等核对清单落盘（194 vs 277 差集逐条定性：core 新增 / 壳独有→先补齐）；② 壳两 store 文件不存在；③ renderer test 绿；④ grep：`stores/command`、`stores/fileSearch` import 零命中 |
| u3.1 | ComposerInputInstance 窄契约定性收敛（P2 前置一半） | `core/src/domain/composer/types.ts`、`dispatch/{send,submit,fork-mode,handoff-mode}.ts`、`context/{injection,context-chips}.ts` | u1.3 | plain | ① 窄契约定性清单落盘（6 处逐条：有意→Pick/字段级 import + 意图注释 / 漂移→删）；② core typecheck/test 绿 |
| u3.2 | D8 createStagingMode 泛化（P2 前置另一半） | `core/src/domain/composer/dispatch/{fork-mode,handoff-mode}.ts`、`core/src/domain/composer/dispatch/staging-mode.ts`（新）、`core/src/domain/composer/types.ts`（配置类型如需） | u3.1 | plain | ① P2 差异清单落盘（25% 差异逐条定性可配置性，不可配→部分泛化）；② fork/handoff 现有测试全绿不改断言（行为等价）；③ staging-mode.ts 存在且两 mode 消费 |
| u4.1 | D1 seq 协议归位 subscription-state | `core/src/coordination/subscription-state.ts`、`core/src/coordination/seq-gap.ts`（并入后删）、`core/src/coordination/__tests__/`（seq-gap/subscription-state 测试合并 + MF-3 接口级新测试） | u1.3 | plain | ① seq-gap.ts 文件不存在（判定表纯函数逐字内嵌）；② route-inbound 的 applySeqGap 缩为 gate 调用 + reconcile 触发（此步只改调用不改结构，route-inbound 主体留 u4.2）；③ core test 绿含新增 MF-3 接口级用例（feed gap → reconcile 意图 + 簿记；reconcile 失败 → 基线原位） |
| u4.2 | D2 route-inbound 声明式归一（两 commit：骨架 → error 合并） | `core/src/coordination/route-inbound.ts`、`core/src/coordination/__tests__/route-inbound.test.ts` | u4.1 | plain | ① ROUTE_TABLE 条目为声明式 `{sessionEffect?, globalEffect?, crossSession?, payloadGuard?}`；② 'error' 单条目（sessionEffect=onSessionError + globalEffect 含 `!msg.id` 守卫）；③ CROSS_SESSION_TYPES 删（8 条 `crossSession: true` 声明）；④ 守卫两类分置：跳过型入 payloadGuard、整形型（:276 'Unknown error'）留 sessionEffect 参数构造；⑤ 坏形状锁定测试（:293-305/:348-351 等价迁移）绿 |
| u5.1 | D3/D4 sessionEntry 端口束 + core 切入链全链化 + 时序纠正 | `core/src/domain/session/use-session.ts`、`core/src/domain/session/api-port.ts`（类型）、`core/src/domain/session/__tests__/`（12 步顺序断言新增） | u4.2 | plain | ① UseSessionDeps 含 sessionEntry 端口束（全可选缺省 no-op）；② 统一链 = 壳版时序（sync/navigation 先于 hydrate）；③ 12 步顺序接口级断言（记录型 fake 端口回放调用序）绿；④ core test 绿 |
| u5.2 | D5 前半：生产切换 + 隔离入口型测试改指 + 术语登记 | `renderer/src/composables/features/sidebar/useSidebarNew.ts`（代理化）、`renderer/src/composables/panel/useChatViewDeps.ts`、`renderer/src/composables/features/trace/useTraceJump.ts`、测试 7 文件（fg6-overview / useSidebar-delete-empty-state / focused-session-id / app-bootstrap / initapp-default-cwd-session / list-load-error / session-trace/useTraceJump）、`docs/architecture/context.md` | u5.1 | plain | ① grep：useChatViewDeps/useTraceJump 无 legacy import；② resetAppBootstrap 引用零命中（改指 resetSidebarNewForTest）；③ context.md 含「Session 切入链」条目；④ renderer test 绿 |
| u5.3 | D5 后半：mock/动态型 10 测试改指 + legacy 删除 | `renderer/src/composables/features/sidebar/useSidebar.ts`（删）、mock/动态型 9 测试（MessageStream.wire / MessageStream-kind / MessageStream-subagent-force-working / SubagentDirectiveStream / use-fork-notice-stream / useHandoffEffect / use-chat-view-deps / fork-entry-behavior / subagent-tab） | u5.2 | plain | ① useSidebar.ts 文件不存在；② 全仓 grep（静态+动态+mock 三口径）`sidebar/useSidebar'` 零命中；③ renderer test 绿 |
| u6.1 | D6 chat store 剪枝 + facet 类型 + taste-lint 规则（A8） | `core/src/domain/chat/store.ts`、`core/src/domain/chat/index.ts`（facet 导出）、`taste-lint/`（新规则 + 注册）、`renderer/src/__tests__/useChat.test.ts`、`renderer/src/__tests__/stores/chat-dispose-session.test.ts` | u5.3 | plain | ① timer 三件套入 testInternals 命名空间（return 面无顶层导出），2 测试改指；② ChatStoreReaders/ChatStoreOps facet 类型导出；③ A8：临时 fixture 误用 ops 字段 → lint 报错指向 facet 文件，移除后复绿（fixture 不入库）；④ core+renderer test 绿 + `pnpm lint` 绿 |
| u6.2 | D13 branchSummary entry 化 + effects 骨架 helper + apply-entry builder | `core/src/domain/chat/effects/registry.ts`、`core/src/domain/chat/effects/bash-effects.ts`、`core/src/domain/chat/apply-entry.ts` + 相关测试 | u5.3 | plain | ① branchSummary live 链路 entry 化投影（fallback 与 reducer 收敛一致）；② live ≡ reload 新增等价用例（branch 后两路投影一致）绿；③ applyEntryFrameWithOverlay helper 存在且 ≥3 处消费；④ core test 绿；独立 commit（行为变化） |

**u-foundation 缺席声明**：各单元的契约（payloadGuard schema / sessionEntry 端口 / facet 类型 / staging config）均在其领地内就地定义并被后续单元消费（串行边承载），无并行单元共编的共享契约文件，故不设 u-foundation 根节点。

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1 组1 transport 清扫]
    U11["u1.1 工厂化+常量SSOT+去环<br/>领地: request.ts/use-connection.ts/bridge×2/chat三件/mock"]
    U12["u1.2 死面删除+dormant<br/>领地: events.ts/port×3/tasks删/panel-orch"]
    U13["u1.3 seam注入+import回直<br/>领地: use-connection/route-inbound/2测试"]
  end
  subgraph W23[Wave2∥3 组2+组3]
    U21["u2.1 双轨收口(P1)<br/>领地: search×3/壳store×2删/core补齐"]
    U31["u3.1 窄契约定性收敛<br/>领地: composer 7文件"]
    U32["u3.2 staging泛化(P2)<br/>领地: fork/handoff/staging-mode新"]
  end
  subgraph W4[Wave4 组4 coordination]
    U41["u4.1 seq归位<br/>领地: subscription-state/seq-gap删"]
    U42["u4.2 路由声明式归一<br/>领地: route-inbound+测试"]
  end
  subgraph W5[Wave5 组5a session 切入链]
    U51["u5.1 端口束+全链+时序纠正<br/>领地: use-session/api-port"]
    U52["u5.2 生产切换+隔离型6+1测试<br/>领地: sidebarNew/2生产/7测试/context.md"]
    U53["u5.3 mock型9测试+legacy删<br/>领地: useSidebar删/9测试"]
  end
  subgraph W6[Wave6 组5b chat 接口]
    U61["u6.1 剪枝+facet+taste-lint<br/>领地: store/index/taste-lint/2测试"]
    U62["u6.2 branchSummary entry化+helpers<br/>领地: registry/bash-effects/apply-entry"]
  end
  U11 -->|"use-connection.ts 同文件共改"| U12
  U12 -->|"use-connection.ts 同文件共改（toast 删除后测改写）"| U13
  U13 -->|"route-inbound 静态 import 依赖 u1.3 回直形态"| U21
  U13 -->|"composer 不依赖 u1 但按 D12 波次序（W1 先行清场）"| U31
  U31 -->|"同文件后改（窄契约定性后泛化）"| U32
  U13 -->|"route-inbound.ts u4.2 在 u1.3 终态（动态 import 保留，P5 回退）基础上动同文件"| U41
  U41 -->|"gate 函数接口被 applySeqGap 调用点消费"| U42
  U42 -->|"按 D12：组5 依赖组4 完成"| U51
  U51 -->|"core 全链先行，壳代理化消费其接口"| U52
  U52 -->|"删除必须等全部消费方改指完成"| U53
  U53 -->|"按 D6：LRU 四件套被吸收后再分层"| U61
  U53 -->|"组5b 同波，registry 的 ctx 接线与 store 面改动保守串行"| U62
```

## 4 测试策略

**增量（单元开发期，从对应子包目录运行）**：
- core：`cd packages/core && pnpm typecheck && pnpm test`（vitest run）
- renderer：`cd packages/renderer && pnpm typecheck && pnpm test`
- 触 mobile（仅 u1.2）：root `pnpm test` 覆盖或 `pnpm --filter ./packages/mobile-renderer test`
- lint 类（u6.1）：root `pnpm lint`（taste-lint 经 eslint.config.mjs 挂载）

**全量（收尾阶段 5 Gate A）**：root `pnpm test` + `pnpm lint --max-warnings 0` + core/renderer typecheck。

**Gate B（阶段 5 真实场景）**：A1-A8 按 §4 验收表逐行签收（dev app 实跑；A1-A4/A6 需真实 runtime，必要时 CDP 取证）。

## 5 合理偏差登记表

| # | 偏差 | 定性 | 处理 |
|---|------|------|------|
| 1 | 设计 §5 原文「u1.1 与 u1.2 无文件交集可并行」——实际两者领地都含 use-connection.ts（D10① 工厂 vs D11 toast 删） | 计划级修正 | W1 内三单元全串行（u1.1→u1.2→u1.3），已在 DAG 边标注原因 |
| 2 | 设计 u5.2 原为单单元（6 测试改指+删除）；v4 修正消费面后为 2 生产+16 测试，超单 subagent 规模 | 计划级拆分（v4 已回写设计） | 拆 u5.2（生产+隔离型 7 测试）/u5.3（mock 型 9 测试+删除） |
| 3 | u1.3 ③ 动态 import 回直：P5 探针失败（renderer api 层 8 文件 39 用例红——静态图解析绕开 ws-client mock 拦截） | 设计预授权降级（D9 联动条款 + §5 P5 行） | 回退保留动态 import，:358 [HISTORICAL] 注释记录实证与失败清单；u4.1/u4.2 DAG 边原因改为「route-inbound.ts u4.2 在 u1.3 终态（动态 import 保留）基础上动同文件」 |
| 4 | u1.3 clear-pending 测试的 pending 消 mock 用 vi.spyOn(rejectAll) 而非注入 | 实现级合理偏差：use-connection 对 pendingApi.rejectAll 是顶层直接调用，注入消不掉 | spyOn 透传真实实现，断言语义 100% 保持，vi.mock 计数仍 ≤1 |

## 6 状态表

| Unit | 状态 | 轮次 | 证据指针 |
|------|------|------|----------|
| u1.1 | committed | 1 | commit 8fa0ac7d1（u1.1）；core 1280 绿 + renderer 3601 绿；grep b/c/d 全过（自回引残余 1 处为注释文本非 import） |
| u1.2 | committed | 1 | commit 8795046ba（u1.2）；core 1275 绿 + renderer 3601 绿 + mobile 21 绿；死面 grep 零命中；计划路径笔误修正（shell/useConnection → composables/useConnection）；连带授权：builtin-contributions.ts 注释锚点、mock-ws 第三 ipc 注入点 |
| u1.3 | committed | 1 | commit 6f5759e19（u1.3）；core 1275 绿 + renderer 3601 绿；vi.mock 各文件 1 处；③ P5 探针失败走设计预授权降级（动态 import 保留 + route-inbound.ts:358 [HISTORICAL] 实证），u4.x 以动态 import 保留形态为基线 |
| u2.1 | pending | 0 | — |
| u3.1 | pending | 0 | — |
| u3.2 | pending | 0 | — |
| u4.1 | pending | 0 | — |
| u4.2 | pending | 0 | — |
| u5.1 | pending | 0 | — |
| u5.2 | pending | 0 | — |
| u5.3 | pending | 0 | — |
| u6.1 | pending | 0 | — |
| u6.2 | pending | 0 | — |

## 7 残留风险与变更历史

**残留风险**：
- P1（command 语义对等）：核对不通过 → 本波只做 fileSearch，command 部分挂起升级（设计已备降级）
- P2（staging 差异可配置性）：不可配 → 部分泛化（共享骨架 + 差异段保留）
- P5（renderer ws-client mock 链）：失败 → 保留动态 import 其余照做
- Gate B 场景（A1-A6）依赖 dev app + 真实 runtime，阶段 5 集中执行；单元期只跑命令级验收
- D4/D13 两处行为变化由专项验收（A2/A1 时序观察、A4 branch 段）兜底

**变更历史**：
- 2026-09-03 v1：初版计划（13 单元 / 6 波次 / DAG 含边原因）。来源：设计 v4（含实施前复核修正 D5 消费面）。
