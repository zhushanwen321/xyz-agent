---
round: 2
frame: structure
perspectives: [3, 4]
converged: true
---

# 追踪 Round 2 · 结构帧收敛复核（视角 3 分层纪律 + 视角 4 依赖边界）

> **CONVERGED**。本组两视角追踪无新 gap。
> Round 1 的 3 个实质 gap（G-1 / G-2 / G-3）在修订稿中全部真闭合，证据经源码二次核实。
> 已追踪视角：视角 3（分层纪律）+ 视角 4（依赖边界）。

---

## 一、Round 1 gap 闭合验证（源码二次核实）

### G-1 [F] git-info 伪 port 美化 —— ✅ 闭合

**Round 1 主张**：§6 Port 清单把 git-info 列为「真 seam / 实现=1」，但源码它是 services 层裸 `execSync`、无 interface，是伪 port。

**修订稿处理**：
- §6 Port 清单**删除 git-info 行**，改为 4 个真 port（OS DirectoryPicker / pi RpcClient / git CLI 经 IGitExecutor / WS Transport）。
- §6 末尾新增明确声明：「**git-info 不是 port（结构G-1 闭合）**：`services/git-info.ts` 在 services 层裸 `execSync`（无 interface、直连 child_process），是**裸 IO 便利模块 + 分层债**，非 port。证伪三连全崩。文档原 Port 清单把它美化为「真 seam」是错误，现修正。T2 红队评估是否补 IGitExecutor port 覆盖读路径。」

**源码二次核实**：
- `src-electron/runtime/src/services/git-info.ts:3` `import { execSync } from 'node:child_process'`
- `git-info.ts:59` `execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout, ... })`
- 全文件无 interface/port，自管 cache（`gitInfoCache` Map）—— 确认是裸 IO 模块，非 port。
- 与同层 GitService（经 `IGitExecutor` port）的分层不一致是现状债，文档现已如实标注，不再美化。

**判定**：G-1 真闭合。文档与源码一致。

---

### G-2 [F] UC-6 createBranch port 缺口 —— ✅ 闭合

**Round 1 主张**：§7 模块表 GitService「接入 ~5 行」低估了 UC-6 创建分支的工作量；实际 port 白名单 / handler handles / protocol 三层全不支持写操作，需独立 port 扩展。

**修订稿处理**：
- §7 模块表新增独立行：「**GitService.createBranch 扩展（UC-6）** | 新增 createBranch 方法 + 扩 GitCommand 白名单(+branch/-b) + protocol 消息 git.createBranch + GitMessageHandler case | port 能力集扩展（结构G-2/G-5 闭合） | runtime Service | **~40（重估，非原 5）**」
- §6 Port 清单 git CLI 行备注补充：「已有，但**能力集缺口**：GitCommand 白名单(status/add/reset/commit/diff/rev-parse) 无 branch/checkout，UC-6 创建分支需扩 port」
- §1 搭便车表 T2 已标注红队预警（证伪三连显示职责正交，合并或为制造耦合）。

**源码二次核实（三层 port 契约确都不支持写操作）**：
- `services/ports/git-executor.ts:33` `type GitCommand = 'status' | 'add' | 'reset' | 'commit' | 'diff' | 'rev-parse'` —— 无 branch/checkout ✅
- `transport/git-message-handler.ts:34` `handles = ['git.status', 'git.stage', 'git.unstage', 'git.commit']` —— 无 git.createBranch ✅
- `shared/src/protocol.ts:31` ClientMessageType git.* 仅 4 个；`:103-106` payload map 无 createBranch ✅
- `grep createBranch|checkout` runtime 全域零命中 ✅

**LOC ~40 合理性核验**：createBranch 方法(~15) + GitCommand 类型(+1) + protocol 消息/union/payload(~5) + handler case(~10) + 前端 git.ts createBranch(~9) ≈ 40。前端 `renderer/src/api/domains/git.ts` 已存在（status/stage/unstage/commit 四方法），createBranch 沿用「动作-ack」模式（→ message.status），无新依赖方向。估算成立。

**判定**：G-2 真闭合。范围估计已修正，喂给 Step 3 将成独立 issue（非裹入「接入调用点」）。

---

### G-3 [D/K] D-5 deletion test 误用 —— ✅ 闭合

**Round 1 主张**：D-5 的 deletion test 检验的是「模块边界（合并 vs 分离）」，不涵盖「层边界（git-info services 层裸调 child_process）」；把两个正交问题混谈，让对的模块决策掩盖了分层泄漏。

**修订稿处理**：
§10 D-5 新增「**⚠️ 补充（结构G-3 闭合）**」段，明确：
- deletion test 只判定「模块边界」（合并 vs 分离），**不涵盖「层边界」**。
- git-info 在 services 层裸 execSync（直连 child_process）是**独立的分层泄漏问题**（§6 Port 清单已修正）。
- T2 红队一并评估是否补 IGitExecutor port 覆盖读路径。
- 「两个问题正交，不混谈。」

**判定**：G-3 真闭合。D-5 论据补强，议题 A（模块边界）与议题 B（层边界）显式分离，读者不再误以为 git-info 分层无问题。

---

## 二、本组视角追踪（视角 3 + 视角 4，Round 2 新 gap 检查）

### 视角 3 分层纪律 —— 无新 gap

| 检查项 | 复核结果 |
|--------|---------|
| 核心计算定位（决定分层深度） | §2「核心计算=技术流程编排」、D-1「三层够不套 DDD 四层」成立。无复杂领域规则引擎，现有 Transport→Service→Adapter 已捕获协议/编排/适配不对称。✅ |
| 分层深度匹配系统性质 | 三层匹配，无空壳层。✅ |
| 依赖方向严格向下 | createBranch 扩展走 service→IGitExecutor port→infra，方向正确。git-info 反向泄漏是现状债，已标注（G-1）。✅ |
| 核心层零外部 SDK 依赖 | git-info 打穿，已如实标为分层债（G-1）。新建任务不恶化。✅ |
| 伪 port（单实现 interface） | §6 Port 清单 4 个 port 全是真 seam（OS dialog/pi RPC/git CLI 经 port/WS），git-info 伪 port 已移除（G-1）。无新伪 port。✅ |
| Port 价值定位明确 | 每行标注「真 seam：XX 隔离」理由。✅ |

### 视角 4 依赖边界 —— 无新 gap

| 检查项 | 复核结果 |
|--------|---------|
| 依赖图有环 | createBranch 全链路 renderer→WS→transport→GitService→IGitExecutor→infra 单向向下，无环。✅ |
| 上帝对象（>400 行 / 函数 >80 行） | `git-service.ts` 现 217 行，加 createBranch ~10-15 行 → ~230，远低于 400。新建任务模块最大为 `useNewTaskFlow`(~200)/`branch popover`(~180)，均合规。✅ |
| 扁平 struct 混生命周期 | G-7（Round 1）记录的 ManagedSession 现状债未恶化，新建任务复用不改 struct。✅ |
| boolean flag 控制清理 | 无（NewTaskFlowState 是显式 enum 状态机，非 boolean flag，AC-4 已固化）。✅ |
| interface 过度抽象（方法 >10） | G-6（Round 1）记录 ISessionService 13 方法是现状债，新建任务**不新增方法**（dirty 接入走 GitService.getStatus，cwd 经 getSummary 取），不恶化。✅ |
| deletion test（疑似 shallow 模块） | G-3 已修正 D-5 的 deletion test 适用范围。无新误用。✅ |

**新增 createBranch port 扩展的边界健康**：扩展触及 4 层（shared protocol / transport handler / service method / port 白名单）是「扩展一个真 port」的正当代价（port 真实性已由 G-2/G-5 deletion test 确认：删 port 边界，UC-4 读路径与 UC-6 写路径不会塌缩，失败域不同）。非新 gap，是 G-2 闭合的落地形态。

---

## 三、收敛判定

**CONVERGED（converged: true）**。

- Round 1 的 3 个实质 gap（G-1 F / G-2 F / G-3 D）在修订稿中全部真闭合，源码二次核实无误。
- 本组两视角（视角 3 分层纪律 + 视角 4 依赖边界）未发现新 gap。
- §6 Port 清单从 5 行（含 1 伪 port + 1 能力缺口）收敛到 4 行（全真 seam，1 个能力缺口已显式标注并重估 LOC）。
- 既有现状债（G-6 ISessionService 13 方法 / G-7 ManagedSession 扁平 struct）维持 Round 1 判定：非本文档引入、不阻断本轮、提示 ⑤code-arch 阶段留意。

本组无需回 Step 3 处理。等待建模帧 / 演进帧两组 Round 2 结果汇总统判。
