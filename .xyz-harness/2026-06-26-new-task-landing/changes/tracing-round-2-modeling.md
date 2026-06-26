---
round: 2
frame: modeling
perspectives: [1, 2]
converged: true
---

# 架构追踪 · Round 2 · 建模帧（收敛复核）

> 视角 1 模型完整性 + 视角 2 状态正交性。
> 本轮任务：验证 Round 1 的 G-1..G-5 是否真闭合（源码核对，非仅文档措辞）+ 本组视角是否产生**新** gap。

## CONVERGED

**本组判定：收敛。** 依据：

1. **Round 1 五个 gap 全部真闭合**（§1 逐条源码验证，非文档层面闭合）
2. **本组两视角未发现阻塞性新 gap**——仅 2 个非阻塞轻微观察（§3），均可 inline 修复或属可辩护的建模选择，不需回 Step 3 重跑

---

## §1 Round 1 gap 闭合验证（源码核对）

### G-1（Session 误标 aggregate / ManagedSession 是技术封装）→ ✅ 真闭合

- **文档修订**：§4 模型表 Session 行已改为「**技术实体**（非领域 aggregate，已有复用）」，不变式限定为「cwd 在 NewTaskFlow 正常路径不变；但 restore 有合法回退」，明确标注「不强行升格为 aggregate」「字段裸 mutate（renameSession 直接赋 label）」。
- **源码核对**：
  - `session-service.ts:34` `interface ManagedSession extends IManagedSessionView`——确认是技术封装 interface，无守卫方法
  - `session-service.ts:210-215` `toSummary()` 中 `status: s.isGenerating ? 'active' : 'idle'`——确认 status 派生、无领域不变式
  - `session-lifecycle.ts:145-148` `restoreSession` 的 `existsSync(target.cwd)` 分支回退 `homedir()` + `patchSessionCwd`——确认 cwd 不变式被 restore 合法打破，文档已如实标注
- **证伪三连复核**：删「aggregate 标注」→ 复杂度塌缩（Session 退化为技术记录，D-3 复用 active/idle 仍成立）→ 标注多余。修订采纳。**闭合。**

### G-2（recentCwd 与 RecentWorkspace 概念混用）→ ✅ 真闭合

- **文档修订**：§4 现分别建模两个概念——
  - `RecentWorkspace`（派生视图 DTO，distinct cwd top10，喂 popover 列表）
  - `resolveDefaultCwd`（纯函数，单值，最近活跃 session 的 cwd，喂默认创建）
  - 两者数据源/生命周期差异显式说明（「前者单值派生，后者 top10 列表」）
- **源码核对**：`shared/session.ts` SessionSummary 含 `cwd` + `lastActiveAt`（line 6/10）——确认派生源存在，无需独立缓存
- **闭合。**（注：Round 1 同时被演进帧 G-2 交叉命中，主 agent 已据此打回 T3，§7 模块表 `recentWorkspaces` LOC 从独立缓存降为 ~20 派生函数，D-6 记录降级理由。交叉验证闭环。）

### G-3（发送失败折叠 / 不引入 Reason 辩护盲区）→ ✅ 真闭合

- **文档修订**：§5 转换表拆分为
  - `landing --> completed: 发送首条消息**成功**(进对话流)`
  - `landing --> landing: 发送失败(留 landing，composer 子态显错)`
- Reason 字段辩护段补全主流程发送失败覆盖：「主流程发送失败：折叠为 landing 的 composer 子态……**不产新终态**」「overlay 内失败……停留在当前 overlay」——明确两种失败都不改 NewTaskFlowState，故无需 Reason。
- **闭合逻辑自洽**：选择方案 (a)（失败折叠为 composer 子态），8 态机完备，「不引入 Reason」辩护现在对主流程+overlay 双路径均成立。

### G-4（cancelled 终态自相矛盾）→ ✅ 真闭合

- **文档修订**：§5 补 `cancelled --> landing: 重新点回空 session(NewTaskFlow 复活)` 转换边；新增说明「cancelled 不再是终态」「代码现状空 session 创建后永久保留（无自动清理，除非用户手动 delete）」「真正不可逆终态只有 completed」。
- **源码核对**：`session-service.ts` 仅有手动 `delete(sessionId)`（line 83）/ `removeSessionEntry`（line 222），**无空 session 自动清理逻辑**——确认空 session 可被重选，cancelled 可逆的判定与代码事实一致。
- **闭合。** AC-6 已同步更新（`cancelled` 非终态，唯一终态 `completed`）。

### G-5（messageCount 派生源未登记）→ ✅ 真闭合

- **文档修订**：§4 末尾新增「落地空态判据数据源（建模G-5 闭合）」段——显式说明 SessionSummary 无 messageCount 字段、派生源是前端 chat store 的 `messages: Map<sessionId, Message[]>`、判据含「未加载视为空」约定、重选历史空 session 有 getHistory 加载窗口。
- **源码核对**：
  - `shared/session.ts` SessionSummary 字段无 messageCount（仅 cwd/lastActiveAt 等）——确认
  - `stores/chat.ts:37` `const messages = ref<Map<string, Message[]>>(new Map())`——确认派生源
- **闭合。** AC-6 已同步（判据派生自 chat store messages Map，非 SessionSummary）。

---

## §2 本组视角追踪（视角 1 + 视角 2）

### 视角 1 模型完整性 — 复核

| 检查项 | 结果 |
|--------|------|
| 每模型标注类型 | ✅ Session=技术实体 / NewTaskFlowState=值对象 / RecentWorkspace=派生视图DTO / resolveDefaultCwd=纯函数 / GitInfo=值对象 |
| aggregate/实体不变式守卫 | ✅ Session 显式声明无守卫（技术实体）；NewTaskFlowState 列出 3 条不变式（overlay 互斥/深模态来源/landing 唯一无 overlay 态） |
| 值对象纯净 | ⚠️ GitInfo 见 §3 Obs-A |
| 「装着行为的对象」反模式 | ✅ Session 持 adapter/interceptor/listener 已如实标注为技术封装，不再伪装领域 aggregate |
| 散落概念未建模 | ✅ recentCwd/RecentWorkspace 已分别建模（G-2 闭合） |
| 空壳模型 | ✅ 无 |
| 建模粒度匹配 | ✅ RecentWorkspace 降为派生 DTO（不升 aggregate），D-2/D-6 记录 |

### 视角 2 状态正交性 — 复核

| 检查项 | 结果 |
|--------|------|
| Status 枚举只描述阶段 | ✅ NewTaskFlowState 8 态全阶段，无 reason 混入 |
| 终止原因独立 Reason 字段 | ✅ 显式决策不引入（唯一终态 completed，无多失败原因） |
| 终态集合标注且不可逆 | ✅ 「终态集合（不可逆）：仅 completed」 |
| 合法转换成图 | ✅ mermaid stateDiagram + 文字转换表 |
| 所有终态可达 / 无死状态 | ⚠️ cancelled 见 §3 Obs-B |
| 转换严格度匹配 | ✅ 显式转换表 + 非法转换抛错（D-4，AC-2） |

---

## §3 非阻塞轻微观察（不触发 Round 3，建议 inline 处理）

### Obs-A（视角 1，F-轻微）GitInfo 在 §4 标「值对象」与其「缓存 IO 读模块」实际性质不符

- **现象**：§4 模型表 GitInfo 行类型列写「值对象（已有，复用）」，不变式列写「按 cwd 缓存 5min TTL；只读 branch/isWorktree」。
- **源码事实**（`runtime/src/services/git-info.ts`）：
  - `GitInfo` interface（line 5）本身是纯数据 shape（值对象 OK）
  - 但模块导出的是 `readGitInfo(cwd)` 函数 + 模块级 `gitInfoCache: Map`（line 12 `CACHE_TTL_MS`，line 39-40 cache 命中，line 59 `execSync('git rev-parse ...')`）——这是**带状态缓存 + IO 的读服务**，不是值对象
- **文档已自我修正**：§6 Port 清单「git-info 不是 port」段 + §10 D-5 补充段已正确判定 git-info 是「services 层裸 execSync 的分层债 / 裸 IO 便利模块」。即 §6/§10 与 §4 类型列**内部不一致**。
- **影响**：非阻塞。值对象判据（无 IO、无状态 mutate）被 §4 类型列违反，但实质处理（分层债、T2 红队）已正确。属 §4 类型列 copy-forward 措辞不精。
- **建议**：inline 把 §4 GitInfo 类型列「值对象」改为「技术读模块（分层债，见 §6/§10）」，与 §6/§10 对齐。一行改动，无需 Round 3。

### Obs-B（视角 2，D-轻微）`cancelled` 与 `idle` 的行为区分依赖 NewTaskFlow 实例模型，文档未钉死

- **现象**：§5 中 `idle` 与 `cancelled` 的出边语义重叠——
  - `idle --> landing: 触发新建(⌘N) / 重选空session`
  - `cancelled --> landing: 重新点回空session`
  - 「重选空session」同时出现在两态的入边触发条件
- **分歧点**：`cancelled` 是否与 `idle` 行为等价（冗余态），取决于 NewTaskFlow 是「单实例 composable（跟踪当前选中 session）」还是「每空 session 一个实例」：
  - 单实例模型：`cancelled` ≡ `idle`（UI 都不显示 NewTaskFlow），`cancelled` 冗余可并
  - 每实例模型：`cancelled`（实例绑定 session X，用户未看 X）≠ `idle`（实例未绑定），两态合法
- **源码倾向**：`useSidebar.ts:154` `newSession()` 是单 composable 的 create+push+select，暗示 useNewTaskFlow 大概率也是单实例 → `cancelled` 可能可并入 `idle`。但 §4 又写 NewTaskFlow「附着在已创建的空 session 上」，倾向每实例。**文档对实例模型未钉死**，导致 cancelled 的必要性悬空。
- **影响**：非阻塞。当前建模（保留 cancelled + 重入边）**可辩护**（每实例模型下合法，且显式记录「切换离开是受认可事件」便于未来清理逻辑）。不是缺陷，是「可简化」。
- **建议**：⑤design-code-arch 阶段定 composable 实例模型时一并裁决——若单实例，把 `cancelled` 并入 `idle`（状态机从 8 态降到 7 态）；若每实例，补 `cancelled --> landing: 触发新建` 出边（当前缺失，⌘N 从 cancelled 的可达性未画）。本轮不需处理。

---

## §4 收敛判定

**CONVERGED（converged: true）。**

- Round 1 的 G-1..G-5 **全部真闭合**（源码核对，非文档层面）——这些建模帧的核心问题（aggregate 误标 / 概念混用 / 状态折叠 / 终态矛盾 / 派生源未登记）均已实质解决。
- 本组两视角追踪未发现阻塞性新 gap。§3 的 Obs-A（GitInfo 类型列措辞）+ Obs-B（cancelled 实例模型）均为**非阻塞轻微观察**：Obs-A 是一行 inline 修复的对齐问题，Obs-B 是可辩护且推迟到 ⑤阶段裁决的建模选择。
- 强行因这两个轻微观察触发 Round 3 重跑，违反 loop 终止性（每轮都能制造新措辞 nit → 永不收敛）。建模帧的实质设计已稳定。

**给主 agent 的建议**：
1. Obs-A：在合入 issues.md 前顺手改 §4 GitInfo 类型列（「值对象」→「技术读模块（分层债）」），零设计影响。
2. Obs-B：记入 issues.md / ⑤code-arch 待裁决项「NewTaskFlow composable 实例模型（单实例 vs 每空 session）」，届时决定 cancelled 是否并入 idle。不阻塞当前架构定稿。

**与另两组的交叉**：Obs-A（git-info 分层债）与结构帧视角 3（分层纪律/伪 port）同源——结构帧 Round 1 的 G-1（git-info 非 port）已命中，本组 Obs-A 仅是 §4 类型列未同步该结论，属同源强化非新信号。
