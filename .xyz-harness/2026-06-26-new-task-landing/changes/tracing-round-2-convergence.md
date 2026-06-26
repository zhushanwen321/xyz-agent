---
phase: step3-tracing
round: 2
source: system-architecture.md + issues.md (Step 3 分流后)
mode: convergence-review
converged: true
round1_closed: 36
new_gaps: 0
---

# Tracing Round 2 — 收敛复核

> 独立收敛复核 subagent，上下文与主 agent 隔离。
> 任务：① 确认 Round 1 的 36 条 gap 是否全闭合；② 按同样的失败帧 + 覆盖视角重新扫描新 gap。

## CONVERGED

**Round 1 闭合：36/36。新 gap：0。**

---

## 一、Round 1 闭合核验（36 条逐条）

### 覆盖重建 6 条（P1 + M1-M5）

| ID | 描述 | 闭合方式 | 状态 |
|----|------|---------|------|
| P1 | P3 延后项根来源在①spec §6 非② | 决策记录 D-P1 显式声明根来源 | ✅ 闭合 |
| M1 | branch_modal 失败转移目标矛盾（②§5 vs AC-7.3） | D-7 用户裁决「留 modal」+ AC-7.3 改写 + 回流② L94 挂 Step6b | ✅ 闭合（回流待 Step6b） |
| M2 | 非 git 目录 popover/modal 不可达守卫漏验收 | AC-3.7 状态机守卫（非法转换抛错） | ✅ 闭合 |
| M3 | 发送失败 composer 显错 UI 落点断层 | AC-2.6/2.7（landing 失败出口）+ AC-3.13（统一错误策略） | ✅ 闭合 |
| M4 | Esc 优先级验收脱钩 | AC-3.9（模态/composer/浮层 Esc 三者优先） | ✅ 闭合 |
| M5 | 深模态来源约束守卫漏验收 | AC-3.8（来源约束非法抛错，与互斥正交） | ✅ 闭合 |

### 异常猎手 30 条（A1-A30）

| ID | 维度 | 闭合方式 | 状态 |
|----|------|---------|------|
| A1 | 并发/双击 | AC-1.5（幂等 debounce/in-flight） | ✅ |
| A2 | 异常/pi spawn 失败回滚 | AC-1.6（半创建态回滚，策略属⑤） | ✅ |
| A3 | 边界/首次启动 cwd | AC-1.7 + D-A3（强制选目录，不回退 process.cwd） | ✅ |
| A4 | 异常/getHistory 失败 | AC-2.6（失败出口，不永久卡住） | ✅ |
| A5 | 边界/landing vs 生成态 | AC-2.8（互斥渲染，生成态优先） | ✅ |
| A6 | 并发/messages Map 切台 | AC-2.3 乐观空判据（②§4 设计决策：unhydrated 视为空） | ✅ 闭合（设计决策） |
| A7 | 死角/overlay 切 session | AC-3.10（4 overlay 态 →cancelled） | ✅ |
| A8 | 死角/overlay 期间 session 被删 | AC-3.10 机制闭合（删除触发同一 selected-session-change 信号 → cancelled） | ✅ 闭合（隐式） |
| A9 | 异常/非法转换抛错恢复 | AC-3.11（回安全态 idle + Vue 错误边界） | ✅ |
| A10 | 死角/completed 后实例模型 | AC-3.12（v1 单实例假设）+ D-A10（⑤验证） | ✅ |
| A11 | 边界/cwd=null 脏数据 | AC-4.5（过滤跳过） | ✅ |
| A12 | 边界/多 session 同 cwd 去重 | AC-4.6（取 lastActiveAt 最新） | ✅ |
| A13 | 异常/pick-directory handler 抛错 | AC-5.6（popover 显错 toast） | ✅ |
| A14 | 异常/不可读目录错误链路 | AC-5.7（错误反馈连贯不割裂） | ✅ |
| A15 | F/异常/dirty 语义矛盾 | AC-6.2 改写（切走=执行 checkout，工作区保留改动） | ✅ |
| A16 | 异常/getStatus 无缓存 | AC-6.8（v1 可接受，④评估加缓存） | ✅ |
| A17 | 边界/分支列表极多 | AC-6.9（虚拟滚动/搜索过滤） | ✅ |
| A18 | 并发/execSync 期间 Esc | AC-6.7（阻塞期间事件排队，NFR④） | ✅ |
| A19 | 异常/createBranch execSync hang | AC-7.7（超时包装，策略属⑤） | ✅ |
| A20 | 边界/分支名校验规则 | AC-7.8（实时校验 + 双重校验） | ✅ |
| A21 | 边界/detached HEAD/worktree createBranch | 误报闭合：`git checkout -b` 新建分支在 detached HEAD/worktree 下无限制；名字冲突已由 AC-7.2 兜底 | ✅ 闭合（误报） |
| A22 | 并发/orphan promise | AC-7.9（Esc 后孤儿 promise 忽略） | ✅ |
| A23 | 并发/防重复点击 | AC-7.9（提交 disabled） | ✅ |
| A24 | 异常/源 session cwd 不存在 | AC-8.4（失败显错，不建僵尸 session） | ✅ |
| A25 | K/边界/空 session 堆积 | D-A25（v1 不清理，移交④NFR 评估阈值） | ✅ |
| A26 | 异常/WS 断连全局 | D-A26（runtime 稳定性属 NFR，移交④） | ✅ |
| A27 | K/异常/错误反馈 UI 载体 | AC-3.13（inline 条/toast/composer 子态三策略） | ✅ |
| A28 | 异常/git-info 裸 execSync | D-A28（分层债，移交④） | ✅ |
| A29 | 异常/pi spawn 后崩溃 | D-A29（与 A26 合并移交④） | ✅ |
| A30 | 边界/6 触发点语义差异 | D-A30（newSessionToStandby vs newSession，#3 实现时区分） | ✅ |

**闭合分布**：显式 AC 闭合 26 条；决策记录/移交闭合 8 条（A25/A26/A28/A29/A10 + D-P1/D-A3/D-A30）；设计决策闭合 1 条（A6）；机制隐式闭合 1 条（A8）；误报闭合 1 条（A21）。

---

## 二、新 gap 扫描（失败帧 + 4 轴覆盖）

### 按失败帧重扫

| 帧类别 | 扫描项 | 判定 |
|--------|-------|------|
| **异常路径** | create/checkout/popover/modal 失败、getHistory 失败、execSync hang、IPC handler 错、pi spawn 失败、git-info 异常、WS 断连 | 全部有 AC 或移交④闭合，无新异常路径 |
| **边界值** | 空/单/极大极小（session list、分支数、cwd 脏数据、重名 cwd、unborn HEAD、空 popover） | 全部有 AC 闭合；极长/unicode cwd 属 OS 层，非③ |
| **并发时序** | 双击创建、messages 切台、execSync 期间 Esc、orphan promise、双提交 | 全部有 AC 闭合；双 popover 同开被 AC-3.2 互斥防止 |
| **状态机死角** | 8 态出口完整性、completed 重置、session 删除中断、全删 session | 8 态出口完整（含 AC-3.10 →cancelled）；全删 session 由 landing 判据 `当前选中 session` 自然 falsy 处理（转 app 空态，全局关注点非③） |
| **删除测试** | 伪 issue 检测 | Round 1 已确认 0 伪 issue，AC-6.2 缺陷已修；本轮无新增 |

### 候选新 gap 排查（均判定为非 gap）

1. **orphan OS dialog 结果**（dir-dialog → cancelled 后 OS dialog 返回）
   - 判定：非 gap。BC-7 handler 经 `getFocusedWindow()` 传 parent window，`showOpenDialog` 对该 window modal，切换 session 在 modal 期间被 OS 阻塞。A13 已覆盖 getFocusedWindow null（handler 抛错 → AC-5.6）。

2. **createBranch 命令注入**（分支名含 shell 元字符）
   - 判定：非③ gap。GitCommand 白名单（②§7）+ git 自身命名规则（AC-7.8 禁 `~^:` 等）+ arg-array exec（⑤实现层）三重兜底。属⑤安全实现关注点。

3. **全删 session 后 landing 态**
   - 判定：非③ gap。landing 判据 `当前选中 session && ...`，无选中 session → falsy → 不渲染 landing → app 全局空态接管。属 app 级空态，非 NewTaskFlow 编排范围。

### 按 4 轴覆盖重扫

- **状态轴**（§5）：T_recon 1-19 全闭合，含 AC-3.10 新增的 4 overlay →cancelled 中断转移。
- **模块轴**（§7）：T_recon 20-32 全闭合。
- **边界轴**（§8）：T_recon 33-35 全闭合。
- **挑战轴**（§10）：D-1~D-6 全决策，T_recon 36-41 全闭合。
- **兜底**（§6/§9/§11/§12）：T_recon 42-55 全闭合。

无新 MISSING / PHANTOM / MISMATCH。

### 新增 AC 间一致性

- AC-7.3（留 modal）vs ②§5（失败→popover）：D-7 已裁决一致，回流②挂 Step6b。
- AC-3.12（单实例假设）vs ②Obs-B（移交⑤）：一致（③声明假设，⑤验证）。
- AC-3.13（错误策略）与各 issue 错误 AC（AC-2.7/AC-5.6/AC-6.4 等）相互引用一致。

无矛盾。

---

## 三、收敛结论

**CONVERGED。**

- Round 1 的 36 条 gap（6 覆盖重建 + 30 异常猎手）全部闭合：26 条显式 AC、8 条决策记录/移交、1 条设计决策（A6）、1 条机制隐式（A8）、1 条误报（A21）。
- 按 5 类失败帧 + 4 轴覆盖重扫，**无新 gap**。
- 3 个候选新 gap 经排查均判定为非 gap（modal 阻塞 / ⑤实现层 / app 全局空态）。
- ②回流项（D-7 状态机转移、D-A3 首次启动边缘态）已挂 Step6b 反哺待办，不阻塞③收敛。

**前沿已清晰**：通往 ④NFR（git 同步阻塞/WS 断连/空 session 堆积/getStatus 缓存）和 ⑤code-arch（NewTaskFlow 实例模型/git-info 分层债补 port）的移交路径明确，剩余均为 P2/P3 或已可推导项。建议进入 Step 4（非功能性设计）。
