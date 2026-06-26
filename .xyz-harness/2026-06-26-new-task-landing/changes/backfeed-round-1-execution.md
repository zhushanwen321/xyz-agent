---
verdict: pass
upstream: execution-plan.md
backfed_to: code-architecture.md
entries: 2  # 检出矛盾条数（含已执行的 2 项事实性矛盾；额外矛盾 0）
---

# 反哺 Round 1（execution → code-architecture）

> 独立反哺检查 subagent 产出。检测⑥execution-plan.md 是否引入与①-⑤上游矛盾的结论，并执行已登记反哺项。
> 结论：**检出 2 条矛盾，均为事实性矛盾，已直接修订⑤。无额外矛盾，无 D-不可逆决策待确认。**

## 已执行反哺项

### 反哺项 1（Gap-4）— ⑤code-architecture.md §1.2 标题与表格内容矛盾 ✅ 已修订

**矛盾点**：⑤§1.2 小节标题「runtime（后端）扩展（**仅 #7 port 扩展**）」与紧随其后的表格内容自相矛盾。表格四行明标 **#6+#7 共用**：
- `git-executor.ts:22` GitCommand 加 `'checkout'` → 说明「**#6+#7 共用**：#6 `checkout <name>`、#7 `checkout -b`」
- `git-service.ts` 新增 `createBranch` + `checkout` 两方法
- `git-message-handler.ts` handles + switch 加 `'git.createBranch'` + `'git.checkout'`
- `protocol.ts` 加 `git.createBranch` + `git.checkout`

标题写「仅 #7」却列出 #6 的 checkout 全套（GitService.checkout / GitCommand 'checkout' / handler git.checkout / protocol git.checkout），事实性矛盾。此矛盾已在⑥execution D-5（Gap-1 修正）暴露为根因——初稿误把 #6 checkout runtime port 全归 Wave 3。

**修订**：
- ⑤§1.2 标题改为「runtime（后端）扩展（**#6 checkout + #7 createBranch port 扩展**）」，行尾标 `[BACKFED from ⑥execution on 2026-06-26]` 注释。
- ⑤frontmatter 追加 `backfed_from: [execution]`。

**性质**：事实性矛盾（标题与自家内容不一致），非 D-不可逆决策，不需 ask_user。

### 反哺项 2（D-6/T4.7）— ⑤code-architecture.md §6 T4.7 用例行未标条件性 ✅ 已修订

**矛盾点**：⑤§6 test-matrix 的 T4.7 行，关联 AC 列写「AC-6.8(加缓存后)」已暗示条件性，但**用例行本身（类型=边界 / 预期=第二次零 spawn）未标条件性**，导致⑥execution 在 Wave 2「覆盖的 test-matrix 用例 ID」与「测试验收清单」中初稿误将 T4.7 固化为**硬 PASS 门槛**（见⑥D-6 决策记录：审查 M1 修正）。

上游本意是条件性验收：
- ④NFR D-NFR1：「v1 可先不加缓存（每次 spawn），性能问题实测后优化」+「若 P99>200ms 则 worker_threads 化」
- ③AC-6.8：「v1 可接受每次 spawn」
- ④缓解项回灌表 T4.7 行状态标「条件性待落」

**修订**：
- ⑤T4.7 行：类型列 `边界` → `边界（条件性）`；预期列追加「（条件性：仅加缓存后）」。
- T4.7 表后追加 `[BACKFED from ⑥execution on 2026-06-26]` 说明块，解释与④D-NFR1/③AC-6.8 的对齐，及 v1 不加缓存时标 `[DEVIATED]④NFR 允许`。

**性质**：事实性矛盾（标注不完整导致下游误读），非 D-不可逆决策，不需 ask_user。

## 额外发现矛盾（Task B 逐上游核对）

> 对①requirements / ②system-architecture / ③issues / ④NFR 四上游逐一核对本阶段（⑥execution）是否有其他矛盾结论。
> **结论：无额外矛盾。** ⑥execution-plan.md 与上游结论一致，所有「调整」均在⑥职责范围内并已显式登记为决策（D-1~D-6），未静默偏离上游 D-不可逆结论。

### ①requirements UC/AC — 无遗漏/曲解

7 个 UC 全部落入⑥Wave 且 AC 覆盖完整：

| requirements UC | ⑥归属 Wave | 覆盖用例 | 核对结果 |
|----------------|-----------|---------|---------|
| UC-1 新建任务主流程 | Wave 1 | T1.1-T1.7 | AC-1.1(⌘N→落地→发送)、AC-1.2(dialog取消)、AC-1.3(首次启动空态disabled) 全覆盖 |
| UC-2 直接发送 | Wave 1 | T1.1/T1.2 | AC-2.1(沿用cwd)、AC-2.2(首次disabled) 覆盖 |
| UC-3 更换工作目录 | Wave 2 | T3.1/T3.2 | AC-3.1(选列表项)、AC-3.2(空列表空态) 覆盖 |
| UC-4 切换分支 | Wave 2 | T4.1-T4.6/T4.8/T4.9 | AC-4.1(干净)、AC-4.2(dirty确认)、AC-4.3(unborn) 覆盖；dirty「留在工作区不 stash」(§7) 与 T4.2 一致 |
| UC-5 打开外部文件夹 | Wave 2 | T3.3/T3.4 | AC-5.1(选中回灌)、AC-5.2(取消落回) 覆盖 |
| UC-6 创建并检出新分支 | Wave 3 | T6.1-T6.8 | AC-6.1(创建切换)、AC-6.2(已存在红字)、AC-6.3(空名disabled)、AC-6.4(失败留modal) 覆盖；v1 仅基于 HEAD 与 T6.1 `checkout -b` 一致 |
| UC-7 非 git 目录降级 | Wave 1 | T7.1/T7.2 | AC-7.1(chip隐藏)、AC-7.2(变git恢复) 覆盖 |

注：①UC/AC 用 UC 编号（AC-X.Y，X=UC号），③/⑤/⑥用 issue 编号（AC-X.Y，X=issue号），两套编号体系不同但映射一致，非矛盾。requirements UC-6 AC-6.3（input 空按钮 disabled）由 T6.2（非法分支名 disabled）+ ⑤AC-7.8（前端实时校验）覆盖，空名是「非法分支名」的特殊情形，无缺口。

### ②system-architecture D-不可逆决策（状态机/分层）— 无静默偏离

| ②D-不可逆决策 | ⑥是否遵守 | 核对 |
|--------------|----------|------|
| D-1 三层不套四层（核心=技术编排） | ✅ | ⑥未引入新后端分层；runtime 复用既有 Transport→Service→Adapter |
| D-2 RecentWorkspace DTO（派生视图） | ✅ | ⑥Wave 1 含 #4 recentWorkspaces 派生函数 |
| D-3 messageCount 派生判据（不引入 empty status） | ✅ | ⑥Wave 1 含 #2 landing，判据沿用 |
| D-4 显式状态机 + 非法转换抛错 | ✅ | ⑥Wave 1 含 #3 useNewTaskFlow，8 态 + 转换守卫全保留（T8.1-T8.6 验证） |
| D-5 git 服务分离，v1 不补 port | ✅ | ⑥不碰 git-info；#6 走 GitService.getStatus 经 IGitExecutor port，符合 D-5 |
| D-6 派生函数（打回 T3 独立缓存） | ✅ | ⑥Wave 1 #4 派生函数，无独立缓存模块 |
| §5 状态机：cancelled 非终态，唯一终态 completed | ✅ | ⑥T8.4(cancelled重入)、T8.5(completed终态销毁重建) 一致 |

⑥ D-1（Wave 划分偏离⑤§8 提示）属⑥职责范围调整，已显式登记并声明「不反哺⑤」——⑤§8 标题自标「喂给 Step 6 的部分」是提示非结论，Wave 编排是⑥本职。非②状态机/分层偏离。

### ③issues P 级 / P3 延后 — 无改写

| ③issue | P 级 | ⑥处置 | 核对 |
|--------|------|--------|------|
| #1/#2/#3 | P0 | Wave 1 | ✅ 优先 |
| #4 | P1 | Wave 1（与 P0 同 Wave） | ⚠️ 序列调整但 P 级未降——⑥D-1 显式说明：§4.1 主流程依赖 resolveDefaultCwd(#4)，#4 随主流程是依赖要求非 P 级改写。调度表标「P0+P1」诚实标注 |
| #5/#6 | P1 | Wave 2 | ✅ |
| #7 | P1 | Wave 3 | ✅ |
| #8 | P2 | 独立 ticket（D-4） | ✅ 不阻塞主交付，T1.9 归属此 |
| #9/#10/#11/#12 | P3 延后 | 后续迭代章节 | ✅ 4 项全部保留，延后理由与③一致（根来源①spec §6） |

⑥将 #4（P1）编入 Wave 1 是执行序列决策（#1+#2+#3+#4 构成首条 tracer bullet），③P 级本身未改，调度表「P0+P1」诚实标注。③Wave 编排提示本就是「供⑥」的提示，⑥调整在职责内。无 P 级降级、无 P3 提前、无 issue 丢弃。

### ④NFR 缓解项去向 — 全部落地（除 T4.7 已处理）

逐条核对④「缓解项回灌登记表」21 项在⑥Wave 的去向：

| ④缓解项 | 验收方式 | ⑥落点 | 核对 |
|--------|---------|--------|------|
| runtime cwd 路径校验 (#1,#5) | 代码测试 | Wave 1 T1.4（E2 非法cwd reject） | ✅ |
| session.create 失败回滚 (#1) | 骨架约束 | Wave 1 T1.5（E3 spawn失败回滚）+ ⑤§3.8 骨架约束 | ✅ |
| 新建触发点幂等保护 (#1) | 代码测试 | Wave 1 T1.3（E1 双击并发） | ✅ |
| session.create 结构化日志 (#1) | 骨架约束 | Wave 1 ⑤§3.8 骨架约束清单 | ✅ |
| landing 渲染条件约束 (#2) | 骨架约束 | Wave 1 ⑤§3.8 骨架约束 | ✅ |
| getHistory 失败 landing 重试 (#2) | 代码测试 | Wave 1 T1.8 | ✅ |
| 状态机非法转换回 idle (#3) | 代码测试 | Wave 1 T8.6 | ✅ |
| overlay 切 session cancelled (#3) | 代码测试 | Wave 1 T8.3 | ✅ |
| 状态转换 debug 日志 (#3) | 骨架约束 | Wave 1 ⑤§3.8 骨架约束 | ✅ |
| getStatus per-cwd 缓存 (#6) | 代码测试 | Wave 2 T4.7（条件性） | ✅ 反哺项 2 已处理 |
| getStatus P99 耗时埋点 (#6) | 骨架约束 | Wave 2 ⑤§3.8 骨架约束 | ✅ |
| getStatus P99>200ms 告警 (#6) | 运维项 | 不入 Wave（部署期配置） | ✅ 正确——④标运维项非代码 |
| dirty 切走 inline 确认 (#6) | 代码测试 | Wave 2 T4.2 | ✅ |
| pick-directory IPC 抛错 toast (#5) | 代码测试 | Wave 2 T3.5 | ✅ |
| createBranch 分支名双重校验 (#7) | 代码测试 | Wave 3 T6.2+T6.8 | ✅ |
| createBranch port 8000ms 超时 (#7) | 骨架约束 | Wave 3 ⑤§3.5/§3.8 骨架约束 | ✅ |
| GitCommand 白名单显式枚举 (#7) | 骨架约束 | Wave 3 ⑤§3.6/§3.8 | ✅ |
| createBranch disabled 防重复 (#7) | 代码测试 | Wave 3 T6.6 | ✅ |
| createBranch 失败留 modal (D-7) (#7) | 代码测试 | Wave 3 T6.3 | ✅ |
| createBranch 结构化日志 (#7) | 骨架约束 | Wave 3 ⑤§3.8 骨架约束 | ✅ |
| forkSession 源 cwd 透传 (#8) | 代码测试 | 独立 ticket T1.9 | ✅ |

**21/21 全部落地**。代码测试类 → 对应 test-matrix 用例（归属 Wave 明确）；骨架约束类 → ⑤§3.8 骨架约束清单 + 各 Wave 实现期落地；运维项类（getStatus P99 告警）正确不入 Wave（部署期配置，④已明标）。无缓解项丢失。

## NEEDS_USER_CONFIRM

无。本轮反哺的 2 项均为事实性矛盾（标题/标注不完整），属可直接修订范畴，无 D-不可逆决策需用户拍板。

## 总结

- **检出矛盾**：2 条（反哺项 1 Gap-4 标题矛盾 / 反哺项 2 D-6 T4.7 条件性标注缺失），均已修订⑤code-architecture.md。
- **额外矛盾**：0 条。①UC/AC 全覆盖、②D-不可逆决策全遵守、③P级/P3延后无改写、④NFR 缓解项 21/21 全落地。
- **D-不可逆待确认**：0 项。
- ⑥execution-plan.md 与①-⑤上游结论自洽，可进入编码实现。
