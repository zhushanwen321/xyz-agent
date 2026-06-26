---
round: 2
frame: evolution
perspectives: [5, 6]
converged: true
---

# 演进帧追踪 · Round 2（收敛复核）

> 视角 5（变化轴）+ 视角 6（行为契约）。fresh context 独立复核。
> 本轮任务：(1) 验证 Round 1 的 G-1~G-7 在修订稿中是否真闭合；(2) 核实 G-7 误报判断；
> (3) 按本组 2 视角扫描**新** gap。
>
> **结论：CONVERGED。** Round 1 gap 全部闭合或正确处置，无新 gap。

---

## 一、Round 1 gap 闭合验证

| Gap | 类型 | Round 1 主张 | 修订稿处置 | 闭合验证 | 源码核实 |
|-----|------|------------|-----------|---------|---------|
| **G-1** | D | useNewTaskFlow 变化轴描述过窄（单一轴）+ LOC ~120 偏低 | §7 改述为「UI 交互流程变化（编排中心，承担状态机/overlay/IPC 调度子轴）」，LOC 上调至 ~200 | ✅ **闭合** | — |
| **G-2** | D | RecentWorkspaceCache 边界未做 deletion test | §1 T3 标`打回`；§4 RecentWorkspace 降为「派生视图（DTO）」；§7 改为 `recentWorkspaces(sessions)` 派生函数 ~20 LOC；D-6 给出 deletion test 结论 | ✅ **闭合** | SessionSummary 确含 cwd(L6)+lastActiveAt(L10)，派生基础成立 |
| **G-3** | D | landing ~200 LOC 视觉子轴堆叠（弱信号，建议 chip 逻辑抽 shared） | §7 landing 仍 ~200 LOC，未补 chip-shared 注 | ⏸ **可接受（已正确延后）** | G-3 自标「弱信号，属实现层⑤design-code-arch 关注，本轮仅提示」。架构层不强制处理，留代码架构阶段合理 |
| **G-4** | F | BC-8 触发点清单：SearchModal:119 幽灵行号 + 遗漏 Workspace/Overview/PanelContainer | §11 AC-3 + BC-8 更正为 7 处（Sidebar:200/232、SessionList:44、PanelHeader:71、Workspace:46、Overview:95、PanelContainer:69），SearchModal 移除 | ✅ **闭合** | grep 命中一致 |
| **G-5** | F | BC 清单遗漏 forkSession 调 sessionApi.create() | BC-11 新增 forkSession，标「变更(→独立 ticket，T1 波及)」 | ✅ **闭合**（⚠️ 行号小瑕疵，见下） | `useSidebar.ts` 第 223 行 `sessionApi.create()`；doc 引第 212 行是函数声明行 |
| **G-6** | F | BC-7 preload 路径错误（preload/src/ 子目录不存在） | BC-7 更正为 `src-electron/preload/preload.ts:87` | ✅ **闭合** | `find` 确认无 src/ 子目录，line:87 内容准确 |
| **G-7** | K | BC-5「create 后 broadcastSessionList」时序与源码不符 | 主 agent 判误报丢弃，BC-5 未改 | ✅ **误报判定正确**（详见下） | — |

### G-7 误报核实（关键判定复核）

Round 1 G-7 核心主张：「create 流程**不触发** session.list 广播」，依据是 `session-message-handler.ts:30-32` 只 `reply` 单播。

**源码核实推翻此主张**：

```
src-electron/runtime/src/transport/session-message-handler.ts
  30:    case 'session.create': {
  31:      ...
  32:      this.ctx.reply(ws, msg.id, 'session.created', { session })
  33:      return this.ctx.broadcastSessionList()    ← Round 1 漏读此行
```

`session.create` handler 在 `reply` 单播后，**第 33 行显式调用 `broadcastSessionList()`**。该函数定义于 `server.ts:335-336`：

```ts
private broadcastSessionList(): void {
  this.broadcast({ type: 'session.list', id: this.nextPushId(),
                   payload: { groups: this.sessionService.listPersistedSessions() } })
}
```

即 create 后确有全量 `session.list { groups: SessionGroup[] }` 广播。Round 1 subagent 停在第 32 行，漏读第 33 行，把「lifecycle 层 `refreshAll()` 是内存缓存刷新（非广播）」与「WS handler 层确有广播」两层混淆——两者并存，refreshAll 刷内存、broadcast 推客户端，不互斥。

**结论**：BC-5「create 成功后 broadcastSessionList 推全量 SessionGroup[]」**时序归因准确**，主 agent 判 G-7 为误报并保持 BC-5 不变**正确**。（前端另有 appendSession 乐观更新亦真，但那是客户端双保险，不否定后端广播存在。）

### 非阻断观察（不构成 gap）

- **BC-11 行号小瑕疵**：doc 引 `useSidebar.ts:212`（`async function forkSession(` 声明行），实际 `sessionApi.create()` 调用在第 223 行。Round 1 原引 223 才是精确行。文件路径与语义均正确，仅指向函数头而非调用点，不影响验收。**不阻断收敛**，建议 ⑤阶段 grep 时以 `forkSession` 为锚。

---

## 二、视角 5（变化轴）新 gap 扫描

逐模块复核 §7 模块表变化轴单一性：

| 模块 | 变化轴 | 判定 |
|------|--------|------|
| useNewTaskFlow | 编排中心（状态机/overlay/IPC 子轴内聚于业务轴） | ✅ G-1 已改述，单一业务轴内聚多技术子轴，与 useSidebar（316 行同类）同模式 |
| landing / DirSelect / BranchSelect / CreateBranchModal | 视觉/列表/分支/表单各自一轴 | ✅ 正交分离 |
| recentWorkspaces / resolveDefaultCwd | 派生逻辑 / 默认值解析 | ✅ 两个纯函数两概念（top10 列表 vs 单值），§4 已明确区分 |
| GitService.createBranch 扩展 | port 能力集扩展（UC-6） | ✅ 同一轴（新增分支创建能力）跨 4 触点（method+白名单+protocol+handler），是特征扩散非多轴堆叠 |
| useSidebar.newSession 扩展 | 触发入口迁移 | ✅ 单轴 |

**新 gap：无。** §7 变化轴单一性声明与模块实际定位一致，LOC 预估（G-1 上调后）合理。

---

## 三、视角 6（行为契约）新 gap 扫描

### BC 覆盖完整性核实

`sessionApi.create()` 全部调用方（grep 全仓 3 处）：
- `useSidebar.ts:155`（newSession）→ BC-8 ✅
- `useSidebar.ts:167`（newSessionToStandby）→ BC-8（已注明 standby 侧语义需单独决策）✅
- `useSidebar.ts:223`（forkSession）→ BC-11 ✅

**无遗漏的 create 路径**。BC-1~BC-11 覆盖：协议层 cwd（BC-1）、cwd 回退（BC-2，line:42 核实✅）、label 回退（BC-3）、持久化（BC-4）、广播（BC-5）、git-info 显示（BC-6）、pick-directory IPC（BC-7）、触发点（BC-8）、recent workspace 新增（BC-9）、landing 新增（BC-10）、forkSession（BC-11）。

### 内部一致性
- §5 状态机（cancelled 非终态、completed 唯一终态）↔ §11 AC-6（核验一致）✅
- §4 落地空态派生判据（chat store messages Map）↔ §11 AC-6（核验一致）✅
- BC 处理标签（保持/变更/新增）与 §1 搭便车表 T1/T3 状态交叉一致（BC-2→T1，BC-9→D-6 打回派生）✅

**新 gap：无。** BC 清单事实准确（源码核实 BC-2 line:42、BC-5 broadcastSessionList、create 调用方 3 处），覆盖完整，内部一致。

---

## 四、收敛判定

**CONVERGED = true**

- Round 1 演进帧 7 gap：**5 闭合（G-1/G-2/G-4/G-5/G-6）+ 1 正确延后（G-3 弱信号留⑤）+ 1 误报正确丢弃（G-7）**
- G-7 误报判定经独立源码核实**成立**（`session-message-handler.ts:33` 确有 broadcastSessionList 调用）
- 视角 5/6 新 gap 扫描：**无**
- 唯一非阻断观察：BC-11 行号 212（函数声明）vs 223（调用点）小瑕疵，不影响验收

本组（演进帧，视角 5+6）Round 2 收敛。是否整轮收敛取决于建模帧、结构帧 Round 2 结果。
