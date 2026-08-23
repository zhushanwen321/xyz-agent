# 护栏 G2：「switch ≡ snapshot」等价性测试设计

> 父文档：[context-consistency-design.md](./context-consistency-design.md) §3.3 D5。本文档深入等价性断言的形态、测试分层与实现要点，粒度到可直接实现。

**一句话结论**：为 context 用量状态建立「任意时刻切走再切回，消费方读到的值 ≡ owner 快照」的等价断言，分两层——renderer 纯逻辑属性测试（随机交错序列，与 useContextUsage 同包，快）+ journey 断言（真实链路端到端）+ runtime w10 等价测试族扩展；不另起测试体系。

## 1. 等价断言的形态

messages 状态的「live ≡ reload」是本项目已验证的等价范式（live 帧与 reload 走同一 `applyEntry` reducer，等价性构造性成立，测试守卫）。context 用量照搬该范式声明不变量：

```
不变量（switch ≡ snapshot）：
对任意 session S 与任意时刻 T，
  消费方在 T 时刻切到 S 读到的分区值（经恢复腿或分区缓存）
  ≡ runtime owner 在 T 时刻的 usage 快照投影（get_session_stats → 三字段，无值 = no-value）
```

拆成三个可测命题（每个对应一类故障模式）：

| 命题 | 挡的故障 | 对应根因层 |
|---|---|---|
| P1 单调收帧：分区只被「消息所属 sid == 分区 sid」的帧写入 | 串台（B 帧污染 A 分区） | 层 3 |
| P2 恢复完备：每次切入某 sid 视图必触发恢复拉取（in-flight 去重后至少一次），resolve 后分区收敛（ok/no-value 二选一）；RPC 往返期显示分区缓存值（无闪横线），RPC 失败不降级缓存值 | 丢失（切回无重喂 → 横线） | 层 2 |
| P3 空值保真：0 基线帧不可能写入分区（源头不发 + 哨兵双保险）；「无值」以 no-value 态保真传递，永不退化为 0 | 未知被编码为 0 | 层 1 |

## 2. 测试分层

### 层 1：composable 单元属性测试（`useContextUsage` 纯逻辑）

**位置**：`packages/renderer/src/__tests__/composables/use-context-usage.test.ts`（vitest，与 composable 同包；fake timers 覆盖 in-flight 窗口）。

**形态**：model-based 属性测试。把被测系统抽象为状态机，用伪随机序列驱动（种子固定可复现，不引入 fast-cross 依赖——项目测试策略以定向用例为主，属性测试此处仅一条）：

```
驱动事件集（每步随机选一）：
  E1 收帧(ok 值, sid∈{A,B})           → 模拟 context.update
  E2 收帧(无值占位, sid∈{A,B})         → 模拟无值帧
  E3 收帧(全 0, sid∈{A,B})            → 模拟 0 基线残帧（防御纵深）
  E4 切换当前视图 sid（A↔B，含快速来回）
  E5 getContext RPC resolve(ok 值|无值|失败, sid)
  E6 session 清理(deleteSession → triggerSessionCleanups)
  E7 断连重连（清订阅簿记 → resubscribeAll 重放 stateSnapshot）

不变量断言（每步后全查）：
  I1 对每个未清理的 sid：分区值 == 该 sid 最后一次「合法帧/RPC resolve」确定的值
  I2 当前视图 sid 的分区 status ≠ 'unknown'（恢复腿必已触发或 in-flight）
  I3 全 0 帧后：所有分区值不变（E3 是 no-op）
  I4 清理后的 sid：分区不存在（无泄漏）
```

**mock 边界**：`session.getContext` RPC mock 掉（transport 层不在本层职责），`events.dispatchSession` 用真实通道（测的是 composable 对真实分发形态的响应）。

**定向用例补充**（属性测试之外，每条一个故障模式回归锚点）：

| # | 用例 | 断言 |
|---|---|---|
| U1 | A 有值，订阅 B 期间 B 发 ok 帧，切回 A | A 分区仍为原值（P1） |
| U2 | 分区 unknown，getContext resolve 无值 | status='no-value'；再次切入同 sid 重新拉取（无条件恢复腿）；同视图停留期不重复拉（in-flight 去重 + resolve 即清条目，父文档 D3 机制约束） |
| U3 | 双实例（模拟 split panel）同时 watch 同 sid | getContext 只发一次（in-flight 去重） |
| U4 | 全 0 帧到达已有 ok 值的分区 | 值不变 + console.warn（P3 + D4） |
| U5 | deleteSession | 分区清理（I4） |

### 层 2：runtime↔renderer 契约等价（扩展 w10 测试族）

**位置**：`packages/runtime/src/__tests__/equivalence/w10-usage-switchmodel-race.test.ts`（现有文件，测 switchModel 竞态下 usage 投影一致性——Phase 1 协议改动需先适配它）。

**扩展断言**（Phase 1 的 1.4 单元一并落）：

| # | 断言 | 对应命题 |
|---|---|---|
| W1 | 任意触发路径（播种/失效重拉/switchModel/30s poll）产出的 `session.state_changed` 帧永不包含 usage 三字段（协议不变量，序列化后断言 key 不存在） | P3 源头 |
| W2 | `context.update` 帧要么含全部三字段（真值），要么只含 sessionId（无值占位）——不存在部分字段或全 0 | P3 |
| W3 | `session.getContext` reply 与最近一次 `context.update` 帧的 usage 字段一致（reply ≡ last-value，投影一次原则） | P2 恢复腿数据源 |
| W4 | pi 重启重建（removeSessionEntry → restore 重播种）后，stateSnapshot 的 context last-value 与新实例快照一致 | P2 的 pi 重启场景 |

### 层 3：journey 断言（真实链路端到端）

**位置**：`packages/renderer/src/__tests__/panel/fast-fork-e2e-journeys.test.ts` 模式旁新增（或并入该文件，若其 harness 支持 selectSession 流程）——用 mock ws 层驱动完整 `selectSession → subscribe → stateSnapshot 回放 → live 帧` 序列，断言 DOM。

**核心 journey**（父文档 A1 的自动化版本）：

```
J1: mount Composer(sessionId=A) → 喂 stateSnapshot(context.update ok 值)
    → 断言按钮显示 "2.1万 · 3.5%"
    → selectSession(B)（B 的 stateSnapshot 含无值占位帧）→ 断言显示 "—"
    → selectSession(A) → RPC 往返期间即显示 "2.1万 · 3.5%"（分区缓存初值，无闪横线）
    → getContext(A) resolve 新值后更新为 "3.0万 · 5.0%"（后台 turn 产生的增量，父文档 A7）
J2: A 视图下喂全 0 帧 → 断言显示不变 + warn（D4 的 journey 级验证）
```

三视角（TEST-STRATEGY §3）：J1 是使用者黑盒视角（断言 DOM 文本）；U1-U5 是构建者白盒；W1-W4 是观察者形态（帧序列形状）。

## 3. 与既有测试体系的关系

- **不新建测试文件体系**：层 1 落 renderer `__tests__`（vitest 约定），层 2 扩展现有 equivalence 目录文件，层 3 并入 journey 测试——全部走既有 runner 与目录约定。
- **w10 适配是 Phase 1 的门**：协议改动（删 usage 字段）会让 w10 现有断言红——先改断言（新契约）再合协议改动，防止中间态全仓红。
- **属性测试种子**：固定种子（如 `42`）保证 CI 可复现；不用随机种子跑长序列（项目无此基建，收益不抵成本）。

## 4. 验收（对齐父文档 A5.2）

1. 红蓝验证：把 `updateFor(sid, ...)` 临时改成 `update(...)`（注入切 sid 竞态）→ 层 1 属性测试 I1 红灯；把 D4 哨兵删掉 → U4/J2 红灯；恢复后全绿。
2. `pnpm --filter @xyz-agent/renderer test` 与 `pnpm --filter @xyz-agent/runtime test` 全绿（含新用例）。
3. CI 全量跑一次无 flake（fake timers 用例不真等时间）。
