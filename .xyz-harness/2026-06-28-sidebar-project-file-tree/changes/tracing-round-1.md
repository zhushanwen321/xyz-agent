# 追踪 Round 1 — ⑤code-arch

> 5 组并行 fresh subagent（4 认知帧 + 1 禁读重建帧）。主 agent 合并去重。

## 闭环帧（搭便车 + BC 闭环）

**无 gap。** 搭便车 4 项（#7/#8/#9/#10）+ BC-1~BC-6 全闭环，无变主工程迹象。源码实证：#8 createAdapter options 确未含 cwd（bug 真实，一行修复）；#9 convertPiHistory 确无 fileChanges（挂起⑤验证 pi 数据，双阶段一致标注）；#7 server.ts:472 内联 fs（三层违纪真实，下沉落点完整）。
**流程提醒**：§9 骨架覆盖表 + 自检为空（纸面阶段），Step 7 骨架生成后强制回填。

## 正向追踪发现（4 帧合并去重 + 重建帧 MISSING）

### F 类（事实错误 — 必修）

| ID | 来源帧 | 问题 | 修正 |
|----|--------|------|------|
| F-1 | 契约帧 | §4 功能3 时序图 git.diff 路径参与者歧义：画为 `API→H(FileMessageHandler)→FS(FileService)`，但 getFileDiff 实属 GitService（§3 L207 标 GitMessageHandler→GitService）。一图混用会致 Step7 接线 git.diff 误接进 file-message-handler | 时序图 git.diff 分支新增参与者 GMH(GitMessageHandler)+GS(GitService)，arrow 改 `API→GMH→GS.getFileDiff`，与 file.read 分轨 |
| F-2 | 契约帧 | FileError 类型未在 §3 定义（只出现 code 字符串）。GitError 有源码定义，FileError 新建无类型锚点，§6 T1.3~T1.6 断言 code 字符串无类型根 | §3 services 模块补 `FileError extends Error { code: FileErrorCode }` + code 枚举 |
| F-3 | 契约帧 | 前端 api 层 reply type 契约未闭环：protocol.ts 当前缺 `file.tree:result`/`file.tree.expand:result`/`git.diff:result`（实证 protocol.ts:221-222 仅有 file.read:result/git.status:result）。§3 签名表声明返回类型但未钉 ServerMessageMap 条目 | §3 api 层签名表补「需扩 protocol.ts ServerMessageType + ServerMessageMap」精确 payload |
| **F-4** | 覆盖帧+重建帧 | **NFR-AC-S2（expand 越界）无专属用例**：来源 B 把 S2 映射到 T1.3，但 T1.3 测 listTree（file.tree）越界，S2 核心断言「file.tree.expand 越界返 out_of_cwd」从未被触发；§4 功能2 时序图也无 expand 越界 alt。S2 本为补 expand 越界而生，现状等于没补 | UC-2 新增 T2.10 异常 expand 越界（integration）；来源 B S2 行改指 T2.10；§4 功能2 补越界 alt |
| **F-5（重建 MISSING）** | 重建帧 | **UC-2 untracked `??`→A 独立断言缺失**：①AC-2.2 明确要求 untracked 显绿 A（来自 git `??`），初稿 T2.8 仅笼统「M/A/D/U 全态」合并，未对 `??`→A 独立断言。git `??` 是独立解析分支，合并断言漏回归 | 拆 T2.8b 显式断言 untracked（XY=`??`）→ 绿 A |
| **F-6（重建 MISSING）** | 重建帧 | **UC-4 过滤框与 ⌘K 严格区分断言完全缺失**：①AC-4.2 是 handoff P0 级「无 ⌘K 提示、不弹浮层」，§6 UC-4 零覆盖。P0 AC 在 test-matrix 零覆盖 = 同源盲区典型 | 补 T4.4 断言过滤触发时不出现 ⌘K overlay |
| F-7（重建） | 重建帧 | UC-4 清空过滤框恢复完整树缺失（①UC-4 替代流程） | 补 T4.5 |
| F-8（重建） | 重建帧 | UC-6 SideDrawer 已打开切换状态用例缺失（①UC-6 替代流程） | 补 T6.12 |

### K 类（缺漏 — 必补）

| ID | 来源帧 | 问题 | 补强 |
|----|--------|------|------|
| K-1 | 契约帧 | git-info.ts execSync 技术债（④K-7）在 §3/§7 未落处置。源码实证 git-info.ts:59 用 execSync 字符串拼接绕 port。§6 NFR-AC-S3 grep 范围仅 getFileDiff 未覆盖 git-info | §7 现有代码映射补 git-info.ts 处置行（收编 port 或显式豁免+论证） |
| K-2 | 结构帧 | **AC-2b grep 覆盖不全**：②§11 AC-2b 仅 grep `node:fs`，漏 (a) `fs/promises` 动态 import（现有 server.ts:492 正是此形式，要修的违纪会被 AC 误判通过）；(b) BC-3 下沉后 transport 残留 node:path/node:os | ②§11 AC-2b 反哺扩展 grep pattern（含 fs/promises + node:path + node:os，node:http 白名单）。**触发②反哺** |
| K-3 | 结构帧 | server.ts LOC（512，已超 400）在 BC-3 重构后不降反升风险：§7 标 server.ts 仅 `✱改`（注册 handler），未明确**移除** handleFileRead 方法体。若只注册不删→重复路由 + LOC 不降 | §7 处置表 server.ts handleFileRead 行明确标 **delete（移入 file-message-handler）**，确保净减 |
| K-4 | 覆盖帧+重建帧 | UC-4 过滤缺异常/状态类（仅正常/边界/性能）。过滤命中 invalidated/空树属合理状态用例 | UC-4 补至少 1 状态用例 |
| K-5 | 覆盖帧 | getFileDiff 签名边界（超时→GitError timeout、非 git 仓库→空 patch，AC-5.3/5.4）无 §6 用例 | UC-6 补 git.diff 超时/非 git 仓库边界用例 |
| K-6 | 重建帧 | T4.3 debounce 验收方式错置：④回灌表「过滤框 debounce」=骨架约束（tsc/审查），非代码测试。初稿列入 test-matrix 是验收方式错置 | T4.3 移出 test-matrix，归⑤骨架约束 |

### D 类（弱化/不一致 — 建议补）

| ID | 来源帧 | 问题 | 补强 |
|----|--------|------|------|
| D-1 | 覆盖帧+重建帧 | 来源 B 异步竞态映射漏 AC-3.8（T2.3 未纳入 B 行）：④要求 3.7/3.8/3.9/3.10 四条，B 行只给 T2.4/2.5/2.6 三个 ID | 来源 B 末行改 `T2.3/2.4/2.5/2.6` |
| D-2 | 覆盖帧 | S1（isUnderOrEqual 词法）强制层级=unit 违反「安全强制 integration」表头规则。词法纯函数工程上 unit 合理，但规则无条件 | 来源 B 表头补「纯函数安全原语（无 integration 边界）可 unit」豁免条款 |
| D-3 | 覆盖帧 | 跨 store 失效 UC 编号三不一致：表头「UC-5」/ 用例 T11.x（UC-11）/ §4 关联「UC-2」 | 统一为 UC-11（与 T11.x 一致），修正表头 + §4 关联 |
| D-4 | 结构帧 | K-9 行号引用偏差：§1 称 chat.ts:3 + sidebar.ts:5，实测 chat.ts:2 / sidebar.ts:4 | 行号改「顶部注释」（去行号锚定，防漂移） |
| D-5 | 重建帧 | T6.5/T6.6 未区分 file.read 截断 vs git.diff binary 路径 | T6.5/T6.6 显化路径 |
| D-6 | 覆盖帧 | §6 自检「ID 不重复」措辞误导：T1.3/T1.7/T2.4-2.6 实为有意复用 | 改「新增 ID 不重号；复用 ID 标 co-coverage」 |

## gap 计数

- **F：8**（F-1~F-8，含 3 条重建 MISSING 最致命：F-4 expand越界/F-5 untracked/F-6 ⌘K区分）
- **K：6**（K-1~K-6，K-2 触发②反哺）
- **D：6**

**无方案选型错误**——D-001~D-020 confirmed 决策无下游证据推翻。闭环帧全 PASS（搭便车/BC 无变主工程）。
