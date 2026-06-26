---
round: 1
frame: structure
perspectives: [3, 4]
converged: false
---

# 追踪 Round 1 · 结构帧（视角 3 分层纪律 + 视角 4 依赖边界）

> 独立 fresh-context 追踪。卡住处 = gap。类型：F=事实层面冲突 / K=文档缺失需确认 / D=决策待定。
> 证据全部源码核实（file:line）。证伪三连聚焦 §6 Port 清单 5 个 port。

---

## 视角3 分层纪律

### G-1 [F] Port 清单「git CLI（git-info）真 seam」美化现实 —— git-info 无 port，services 层直连 child_process

**问题**：§6 Port 清单把「git CLI（git-info）」列为 `真 seam / 实现=1`，并在备注写「已有，5min cache」。但源码事实相反——

- `src-electron/runtime/src/services/git-info.ts:3` `import { execSync } from 'node:child_process'`
- `git-info.ts:59` `execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout, ... })`

git-info 是 services 层的一个**裸 IO 模块**：直接 spawn 子进程、自己管 cache，**没有任何 port**。这与同层的 GitService（经 `IGitExecutor` port 隔离 infra，`git-service.ts:23`）形成**分层不一致**：

| 模块 | 层 | git 调用方式 | 有无 port |
|------|----|-----------|---------|
| GitService | services | `IGitExecutor.exec()`（白名单 GitCommand） | 有（`services/ports/git-executor.ts`） |
| git-info | services | `execSync('git ...')` 裸字符串 | **无** |

视角3 检查项「核心层零外部 SDK」与「依赖方向严格向下」同时违反：services 层越过 Adapter 直接碰外部 git 进程。这是**现状债**（非本文档引入），但文档把它写成「真 seam」是**把分层泄漏美化成已正确归位**，会误导后续 issue 拆分认为 git-info 无需动。

**Port 证伪三连（对"git-info 是 port"这一主张）**：
- 删：把 git-info 当 port 这个概念删掉，代码照样跑（它本就只是个直接 execSync 的便利函数）→ 概念多余
- 翻：git-info 无 interface，依赖方向是 services → child_process 单向，没有"结构边界 vs 控制边界反向"的 port 双重性 → 不是 port
- 挪：所谓"seam"可随意平移（execSync 可在调用方就地写）→ 边界不卡在自然接缝

三连全崩。**git-info 在文档 Port 清单里是"伪 port"（以 port 名义列了非 port）**。

**处理建议**：要么（a）承认 git-info 是 services 层便利函数而非 port，从 Port 清单移除或改注「裸 IO，分层债，T2 红队一并评估是否补 port」；要么（b）真给它加 port（YAGNI 风险，需评估）。当前文档两头占——声称是 seam 却不付出 port 代价。

---

### G-2 [F] UC-6「创建并检出新分支」在 Port / Handler / Protocol 三层全部未建模 —— §6/§7「复用 GitService」主张不实

**问题**：§7 模块表 `GitService（已有）接入调用点新增 ~5 行`，§6 Port 清单「git CLI（GitService）真 seam，实现=1，已有 getStatus/stage/commit」。但 UC-6（requirements §2）的核心是不可逆写操作「创建并检出新分支」，需要 `git branch <name>` + `git checkout <name>`（或 `git checkout -b`）。源码核实——**三层 port 契约都不支持**：

1. **Port 白名单**：`services/ports/git-executor.ts:33`
   `type GitCommand = 'status' | 'add' | 'reset' | 'commit' | 'diff' | 'rev-parse'`
   → 无 `branch` / `checkout`。executor 白名单注释明确「exec 只接受这 6 个 git 子命令」。

2. **Transport handler**：`transport/git-message-handler.ts:34`
   `readonly handles: ClientMessageType[] = ['git.status', 'git.stage', 'git.unstage', 'git.commit']`
   → 无 `git.createBranch`。

3. **Protocol 层**：ClientMessageType 无创建分支消息类型（handles 清单已枚举全集）。

**冲突**：requirements UC-6 AC-6.1/AC-6.4 要求创建分支 + git 写操作运行时失败处理（.git 锁/磁盘满/权限），架构文档 §6 Port 清单却声称 git CLI（GitService）是「真 seam / 已有 getStatus/stage/commit」就绪可复用，§7 说 GitService 只需「接入 ~5 行」。**实际工作量是扩 GitCommand 白名单 + 加 GitService.createBranch 方法 + 加 ClientMessageType + 加 GitMessageHandler case + shared/protocol.ts 消息契约**——这是 port 扩展，不是「接入调用点」。

**这是真 seam 被低估为已就绪的典型**：GitService 确实是真 port（G-1 同源对比），但它的能力边界（GitCommand 白名单）没覆盖新建任务所需的写操作。文档把"port 存在"等同于"port 能力就绪"，漏掉 port 契约要扩。

**处理建议**：§7 模块表 GitService 一行从「接入 ~5 行」改为独立行「GitService.createBranch 扩展（GitCommand 白名单 +branch/-b、protocol 消息、handler case）」，LOC 重估（~30-50，非 5）。喂给 Step 3 应成独立 issue，不能裹进"接入调用点"。

---

### G-3 [D/K] D-5 证伪三连误用 deletion test —— git-info 真问题（分层泄漏）被"合并与否"议题掩盖

**问题**：§10 D-5 用证伪三连判「git-info 维持分离不合并」，理由是「删 git-info → 复杂度仍分散（轻量高频读 vs 重操作是两个变化轴）→ 边界真实」。

这个论证的 deletion test **前提错配**：
- deletion test 检验"模块边界是否多余"（删了复杂度塌缩→多余 / 仍分散→真实）。
- 但 git-info **不是"疑似 shallow 可删模块"**——它是 SessionSummary.gitBranch 的**唯一数据源**（BC-6：`session-service.ts:182` `const git = readGitInfo(s.cwd)`），删了 branch 显示直接坏，根本不存在"删"的选项。对一个删不掉的强依赖做 deletion test，结论恒为"边界真实"，是同义反复。

同时 D-5 的论证把两个**正交问题**混为一谈：
- 议题 A（模块边界）：git-info vs GitService 合并还是分离 → D-5 答"分离"，对（两变化轴确不同）
- 议题 B（层边界）：git-info 在 services 层裸调 child_process（G-1）→ 该不该也过 IGitExecutor port？→ **D-5 没回答**，因为 deletion test 只问了 A

结果："维持分离"这个对的模块决策，顺带让读者以为 git-info 的分层也没问题，掩盖了 G-1。

**处理建议**：D-5 补一句「git-info 分层泄漏（services 直连 child_process）是独立于合并与否的层边界问题，T2 红队一并评估」。或把 G-1 单列为 T2 的子项。

---

### G-4 [minor / 视角3观察] 核心计算定位与分层深度的论证站得住，但「核心层零 SDK」检查被 git-info 打穿

- §2「核心计算=技术流程编排，非领域规则」、§10 D-1「三层够不套 DDD 四层」：**成立**。无复杂领域规则引擎，现有 Transport→Service→Adapter 已捕获协议/编排/适配不对称。✅
- 但视角3 检查项「核心层零外部 SDK 依赖」：git-info.ts（G-1）打穿。文档 §2 立场声明「runtime 三层是稳定基座」与 git-info 的 services→child_process 直连矛盾。
- 不另立 gap，并入 G-1 处理。

---

## 视角4 依赖边界

### G-5 [F → 归并 G-2] GitCommand 白名单 + GitMessageHandler handles 清单双闭口 —— UC-6 写操作 port 缺失

（与 G-2 同源，视角4 复核「interface 过度抽象/边界覆盖」维度）

- `git-executor.ts:33` 白名单 6 命令无 branch/checkout
- `git-message-handler.ts:34` handles 4 消息无 git.createBranch
- GitService 无 createBranch 方法（`grep createBranch|checkout` 零命中）

**视角4 deletion test 视角**：删掉"GitService port"这个边界，UC-4（dirty 读，走 getStatus）和 UC-6（创建分支，走 createBranch）会塌缩到一起用裸 execSync 吗？不会——两条写/读路径失败域不同（getStatus 降级 isRepo=false / createBranch 失败须 modal 报错重试），port 边界真实。**但当前 port 只建模了 UC-4 的读路径，UC-6 的写路径没建模**。port 是真 seam，seam 的能力集有缺口。

归入 G-2 统一处理，不重复计数。

---

### G-6 [minor / 视角4观察] ISessionService 方法数 13（>10），架构文档复用不恶化

`interfaces.ts:66-78` ISessionService 方法：create/delete/renameSession/sendMessage/sendSubagentMessage/abort/switchModel/compact/getHistory/restoreSession/rebindAfterFork/hasActiveSession/getSummary = **13 个**，超视角4「interface 方法 >10」阈值。

- 这是**现状债**，非本文档引入。
- 新建任务复用此 interface（§7 SessionService「无需改」），不新增方法——dirty 接入走 GitService.getStatus（sessionId 经 ISessionService.getSummary 取 cwd），不动 ISessionService。
- **不阻断本轮**。记录为既有观察，提示 ⑤code-arch 阶段若 ISessionService 进一步膨胀再评估拆分（如 read/write 分离）。

---

### G-7 [minor / 视角4观察] ManagedSession 扁平 struct 混生命周期，非本文档引入

`session-service.ts:25-30` ManagedSession 把运行时句柄（adapter/interceptor/unsubUsageListener）与领域视图字段（IManagedSessionView 的 id/cwd/label/...）打包在同一 struct，生命周期不同（句柄随进程 detach，领域字段随 session 持久化）。

- 现状，非本文档引入。
- 架构文档 §4 Session aggregate「复用」声明，未恶化此结构。
- 不阻断。提示未来 SessionService 重构时分离。

---

## 交叉验证提示（供主 agent 汇总时与建模帧/演进帧比对）

- **[CROSS-VALIDATION 候选] G-1 / G-3 涉及 git-info 模块归属**：若建模帧（视角1 模型完整性）或演进帧（视角5 变化轴）也独立报告 git-info 的分层/职责问题，则 git-info 是本轮强信号。git-info 同时是「分层泄漏（G-1）+ deletion test 误用掩盖（G-3）+ 与 GitService 职责边界（D-5）」三重命中点。
- **[CROSS-VALIDATION 候选] G-2 / G-5 涉及 UC-6 port 覆盖**：若建模帧从「UC-6 写操作未建模为 git 领域动作」角度、或演进帧从「GitCommand 变化轴（读 vs 写 vs 创建）」角度也命中，则 UC-6 创建分支 port 缺口是强信号。
- **NewTaskFlowState 状态机 dir_dialog 载入失败出边缺失**（dir_dialog 只有选中/取消，无"载入失败"）偏视角2 状态正交性，不在本组，但提示建模帧核验。

---

## Port 清单 §6 证伪三连复核小结

| Port | 删 | 翻 | 挪 | 判定 |
|------|----|----|----|------|
| OS DirectoryPicker | 塌缩（无法选目录） | 不可（前端造不了 OS dialog） | 不可（卡 Electron IPC 边界） | **真 seam** ✅ |
| pi RpcClient | 塌缩（无法通信） | 不可（runtime 不被前端调） | 卡 WS 契约 | **真 seam** ✅ |
| git CLI（git-info） | 不塌缩（裸 execSync 照跑） | 单向非 port | 可随意平移 | **伪 port（G-1）** ❌ |
| git CLI（GitService） | 塌缩（注入/测试难） | 不可 | 卡 IO 边界 | **真 seam，但能力集缺 UC-6 写操作（G-2/G-5）** ⚠️ |
| WS Transport | 塌缩（进程间无通信） | 不可 | 卡进程边界 | **真 seam** ✅ |

5 个 port 里 1 个伪 port（git-info）、1 个能力集有缺口（GitService 缺 createBranch），其余 3 个真 seam 站得住。

---

## 收敛判定

**不收敛（converged: false）**。3 个实质 gap（G-1 F / G-2 F / G-3 D）+ 2 个归并/观察项。G-1 和 G-2 直接影响 Step 3 issue 拆分的范围估计（git-info 分层债、UC-6 port 扩展工作量），需回 Step 3 处理后重跑本组核验。G-3 是 D-5 决策论据补强，可与 G-1 合并处理。
