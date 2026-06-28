---
verdict: CHANGES_REQUESTED
review_mode: deep_redteam
---

# 深度复审 — issues.md（质疑帧 + 失败帧）

> fresh subagent，对 review-issues.md（APPROVED）做反向质疑。本轮**实证核验源码**（不只读文档自证），发现 1 个 F 类事实错误（#10 的「3 处重复 TreeNode」前提不成立）、1 个被虚覆盖的 trace 断裂（②§1 D-014 源声明自相矛盾）、以及多个 K/D 类更深问题。之前审查的 6 维全 ✅ **过快**，未做源码实证。

## A. MECE 性与冗余

### A1. #1 vs #14 — protocol.ts 双线编辑，非真重叠（K）
- **观察**：#1 扩 protocol.ts（file.tree/expand/git.diff 读协议），#14 也扩 protocol.ts（file.write.* 写协议）。两 issue 同改一个文件。
- **判断**：**不该合并**。#14 blocked_by #1，#1 先交付读协议，#14 后补写协议骨架——是时序依赖非并行重叠。合并反而制造「P0 前沿阻塞 P1 骨架」的错序。**颗粒合理。**
- **但**：#1 的 AC-1.4 只列「file.tree / file.tree.expand / git.diff 三组」，未声明「**不含** file.write.*」——实现者若在 #1 顺手把 file.write.* 类型也写了（因为都动 protocol.ts），#14 的 AC-14.1 就变空动作。建议 #1 AC-1.4 加注「file.write.* 类型在 #14 定义，#1 不含」。**[可选]**

### A2. #7 实质接线 #2 — 极薄但不合并（D，confirmed 保留）
- **观察**：#2 已建 FileService.readFile + IFileExecutor.readFile（AC 隐含），#7 只是「扩 server.ts:472 白名单 + 把 transport 的 fs 调用改指向 #2 的 FileService.readFile」。#7 的实质工作量 ≈ 改 server.ts 一处调用点 + 扩白名单数组。
- **判断**：**极薄但独立 ticket 成立**（§12 BC-3 拆分理由=权限审计/回滚粒度，正交于功能）。tracing-round-1 角色 B 已标注「极薄但成立」。**不建议合并**，但 #7 的方案对比（A 扩展 vs B 收紧）是真 trade-off（向后兼容是系统性质约束）。**颗粒合理。**

### A3. #8/#9 同处 pi-infra，服务同一 ChangeSetCard（K，confirmed 不合并）
- **观察**：#8（event-adapter cwd）、#9（convertPiHistory fileChanges）同属 message.file_changes 链路，同服务 ChangeSetCard。
- **判断**：**不合并**。#8 修 ready 帧（运行时），#9 修历史还原（重开 session）——是**同一链路的两个正交故障点**（一个 runtime 路径、一个 history 路径），§12 BC-5/BC-6 拆分便于回滚定位。tracing-round-1 已标注「可选合并不建议」。**颗粒合理。**
- **但见 B3**：#8/#9 的「为什么是 P1」措辞仍有归因残留问题（角色B 已指出但未完全修正，见 E3）。

### A4. #1 四产物一 issue vs #3 三模块一 issue — 颗粒度不一致（D，可接受）
- **观察**：#1 把 4 个 shared 产物（file-tree.ts / ignore-parser.ts / path-guard.ts / protocol.ts）打包一 issue；#3 把 3 个前端模块（store / composable / api）打包一 issue。
- **判断**：**颗粒度表面上不一致，但实质同构**——两者都是「同一变化轴（shared 契约 / fileTree 会话状态）内聚交付」。#3 的 3 模块强耦合（store 定义态、composable 编排、api 封装 WS，三者必须同改才能跑通 loadTree），拆开制造循环依赖。**颗粒合理。**

### A5. 伪 issue 检查（删除测试）— 无伪 issue，但 #14 骨架价值存疑（D）
- **#1~#10**：删除测试全过——不做则 G1/G2/G3/UC-6 直接失败。
- **#14**（删测试）：不做 #14，整个功能仍能跑（file.tree 读/预览/git 标注全不受影响）。#14 是**纯前置契约**，无运行价值（自承认「骨架无运行价值但契约价值真实」）。这不是「伪 issue」（有契约价值），但**是过度设计嫌疑**——见 D2 红队。tracing-round-1 角色 B 未对此做删除测试（只角色 A 提了 M1 冲突）。**[D2 详述]**

## B. 方案对比实质深度

### B1. #3 方案对比回避「overlay join 性能/正确性」真实代价（K）
- **问题**：#3 方案 A（GitOverlay 独立 ref + 渲染时 path join）的 trade-off 只写了「单 store 体量大（~150 LOC）」，**回避了 join 的真实代价**：
  - **正确性代价**：D-012 分离后，overlay 有 path 但 tree 无节点（agent 新建文件）→ join 悬空。这正是 D-017 的根因——但 #3 方案对比时 D-017 尚未裁决，方案 A 的「优点」列了「git status 变化只更新 overlay 不触发树重建」却没列「**会引入 overlay-path 无节点的悬空问题，需额外失效机制**」。
  - **性能代价**：渲染时每个 tree 节点要查 overlay Map（O(1) 但递归整树是 O(n) 查询），方案对比未提。
- **建议**：方案 A 的缺点应补「overlay 与 tree 生命周期不同步，需 D-017 失效机制兜底（否则悬空）」。当前方案对比把 D-012 的代价美化了。**[可选，因 D-017 已补救]**

### B2. #2/#3/#5 多个「方案 B 是偷工减料版」的假对比（K）
- **#2 方案 B**（service 内联 fs）：缺点列「不可 mock + 范式不对称 + 违反 AC-2」——方案 B 不是真设计，是「违反已定 AC 的反面教材」。真对比应是「port 换 mock 能力，付一层间接」vs「内联换简单，付测试脆弱」。**当前是循环论证**（A 合 AC，B 违 AC，所以选 A）。
- **#5 方案 B**（新增 IGitDiffExecutor port）：同病——缺点直接引「违反 §6 内聚判定」，把架构结论当对比依据。
- **判断**：这是 issues.md 全篇的系统性模式——**方案 B 几乎都是「违反已定 D 决策的反面」而非「同等价值不同 trade-off」**。问题不大（因为 D 决策已 ask_user 拍板，对比只是记录），但**宣称「≥2 方案对比」的质量是注水的**。review-issues.md 把「P0/P1 ≥2 方案对比 ✅」当通过项是**虚覆盖**——数量达标但对比深度不达标。**[E2 详述]**

### B3. #8/#9 方案对比是真 trade-off（D，通过）
- #8 方案 A（闭包捕获 cwd）vs 方案 B（ready 帧重查 session store）——是真设计分歧（传递方式 vs 重查），理由基于「cwd 创建后稳定」这一系统性质。**通过。**

## C. AC 可验证性 + trace

### C1. AC-3.7「sessionId 校验丢弃 stale 响应」— 可验证但缺方法（K）
- **问题**：AC-3.7「file.tree.expand 在途时切 session，丢弃 stale 响应（带 sessionId 校验）」——实现者怎么测？需构造「expand 请求发出但未返回时切 session」的时序窗口。issue 未给测试方法（mock WS 延迟 / AbortController）。
- **判断**：**可验证**（人工或集成测试可造时序），但 AC 措辞未暗示验证手段。建议补「（集成测试：mock api 延迟 + 切 session 断言新树无 stale 节点）」。**[可选]**

### C2. AC-3.11「监听 file_changes ready 帧触发失效」— 触发源不清（F/K）
- **问题**：AC-3.11「监听 file_changes ready 帧 → 相关节点 loaded→invalidated」。
  - **触发源混淆**：`message.file_changes` ready 帧是 **ChangeSetCard 的数据源**（BC-1），发往 chat store。#3 的 fileTree store 要监听它来做树失效——但 fileTree store 与 chat store 是两个 store，跨 store 监听未定义机制。issue 说「监听 file_changes ready 帧」但没说**怎么监听**（chat store emit 事件？fileTree store 订阅 WS？）。
  - **更优触发源**：②§5 D-017 原文写「触发 = agent_end / file_changes ready 帧」。`agent_end` 是更干净的触发源（pi 生命周期事件，session 级广播）。issue 只写了 file_changes ready 帧（changeSetStatus='ready'），漏了 agent_end，且 file_changes ready 帧在 #8 修复前拿不到正确 cwd（ready 帧依赖 cwd）——**#3 AC-3.11 实际依赖 #8 先修**，但 #3 的 blocked_by 只有 #2，未列 #8。**[trace 断裂]**
- **建议**：① 明确 file_changes 监听机制（跨 store）；② #3 AC-3.11 补 agent_end 触发源；③ 评估 #3 是否应 blocked_by #8（失效触发依赖 ready 帧拿到 cwd）。**[必须]**

### C3. AC-3.5「展开态随 session 生命周期恢复」— trace 与②§4 reset 矛盾未解（K）
- **问题**：AC-3.5「切走再切回，该 session 展开态恢复」。但 ②§4 FileTreeState 不变式写「随 session 切换整体 reset」。reset = 丢展开态。tracing-round-1 角色 B 已标此矛盾（K），issues.md 的 AC-3.5 措辞「展开态缓存在 store 内按 session 隔离，随 session 生命周期」——但没说**reset 后如何再水合**（从哪恢复展开态？持久化到哪？）。
- **判断**：**UC-3 AC-3.2 要求展开态跨 session 恢复（后置状态明写），但 ②§4 要求整体 reset，二者未调和**。AC-3.5 措辞模糊回避了实质（reset 后展开态是丢还是留）。review-issues.md 把「D-017 失效转移 §5/§7/§10/#3 四处一致」当通过项，但**这个展开态矛盾根本没在 D-017 范围内**——是更早的未解 gap。**[必须]**

### C4. trace 链断裂：D-014 源声明自相矛盾（F）
- **问题**：issues.md L12 写「本阶段所有 D 类决策（D-014~D-016）已 ask_user 拍板」。但：
  - D-014（P0/P1 划线）confirmed_by=`ask_user` ✓
  - D-015（搭便车全 P1）confirmed_by=`ask_user` ✓
  - D-016（文件操作实现延后 P3）confirmed_by=`ask_user` ✓
  - **D-017**（缓存失效）confirmed_by=`ask_user` ✓（decisions.md 确认）
  - **D-018**（骨架补 issue）confirmed_by=`ask_user` ✓（decisions.md 确认）
  - 但 L12 只写「D-014~D-016」，**漏了 D-017/D-018**。而正文（#14、#3 AC-3.11、Step 6b 反哺记录）大量引用 D-017/D-018。**源声明范围与实际引用范围不一致**——读者看 L12 会以为只有 3 个 D 决策，实际 5 个。
- **判断**：**事实小错**（漏列 D-017/D-018），不影响决策有效性（decisions.md 账本完整），但 review-issues.md「内部一致性 ✅」**虚覆盖**了此不一致。**[必须，低优先]**

### C5. ①UC AC 覆盖核查（逐 UC）
- **UC-1**（AC-1.1/1.2/1.3）：AC-1.1→AC-2.1/3.1/4.1 ✓；AC-1.2→AC-2.2/3.4/4.7 ✓；AC-1.3→AC-4.8 ✓。**全覆盖。**
- **UC-2**（AC-2.1~2.4）：AC-2.1/2.2→AC-4.2 ✓；AC-2.3→AC-4.3 ✓；AC-2.4→AC-3.6 ✓。**全覆盖。**
- **UC-3**（AC-3.1/3.2）：AC-3.1→AC-2.3/3.3 ✓；AC-3.2→**AC-3.5 但措辞模糊**（见 C3）。**覆盖但有缺陷。**
- **UC-4**（AC-4.1~4.3）：全→AC-4.4/4.5/4.6 ✓。**全覆盖。**
- **UC-5**（AC-5.1 占位）：→#14 骨架 + demo。**覆盖**（UC-5 本就是占位）。
- **UC-6**（AC-6.1~6.3）：AC-6.1→AC-6.1/7.1 ✓；AC-6.2→AC-6.2/5.1 ✓；AC-6.3→AC-6.3/5.2 ✓。**全覆盖。**
- **结论**：①UC AC 漏覆盖 **0 条**（trace 链不断，仅 UC-3 AC-3.2 的 AC-3.5 措辞有缺陷，见 C3）。

## D. 决策合理性

### D1. D-017（缓存失效反哺）— 反哺到②但 issue 实现链有断（D）
- **账本自洽**：D-017 标 `[REVISIT of ②§5/§10]` confirmed，decisions.md status=confirmed。②§5/§7/§10 三处已补。**账本✓。**
- **但 issue 实现链有断**：见 C2——#3 AC-3.11 的失效触发依赖 file_changes ready 帧，而 ready 帧 #8 修复前拿不到 cwd，且 fileTree store 跨 store 监听 chat store 的机制未定义。**D-017 的「反哺」在②文档层完成，但在③issue 的「怎么实现」层留了机制空白。**review-issues.md 说「D-017 反哺准确落地 ②§5/§7/§10/#3 AC-3.11 四处一致」——**四处文字一致 ≠ 实现机制闭环**。**[必须，见 C2]**

### D2. D-018（#14 骨架抛 NotImplemented）— 过度设计嫌疑（D，红队）
- **质疑**：骨架调用返回 NotImplemented，无运行价值（自承认）。其价值是「让 G4 实现时有类型依归，避免 G4 时再补类型」。
  - **但 G4 是不确定的未来**——requirements §8「不做」明列「file 写操作后端（G4）——F4 demo 画交互但标注后续实现」。如果 G4 永不实现（或 1 年后才实现），#14 的协议类型会**腐烂**（类型定好但无真实调用验证，G4 真做时大概率要改契约）。
  - **真 trade-off 应讨论**：「现在定契约但 G4 时可能改」vs「G4 时定契约但需重新对齐」。#14 方案对比没讨论这个——只写了「违反 D-018 + ②§1 承诺」的循环论证。
- **判断**：D-018 是 ask_user 拍板的，**不可推翻**。但 review-issues.md 红队说「#14 骨架符合 D-018 confirmed 且对齐 ②§1；合理」——**这是「因为 D-018 说了所以合理」的循环**，没做真红队（没问「②§1 承诺本身是否值得用 P1 工作量兑现」）。**[保留，但标注红队不充分]**

### D3. D-015（搭便车全 P1）— #8/#9 该不该 P0？（D）
- **质疑**：#8（修 cwd）若不修，#3 AC-3.11 的失效触发拿不到正确 cwd（见 C2）。即 **#8 是 #3 AC-3.11 的隐性前置**——但 #8 是 P1、#3 也是 P1、#3 不 blocked_by #8。若并行开发，#3 AC-3.11 会因 #8 未修而失效触发失效。
- **判断**：不是该 P0（#8 不阻塞 G1 核心），而是**#3 应 blocked_by #8**（至少 AC-3.11 部分）。当前依赖图漏了这条边。**[必须，见 C2]**

### D4. D-013/D-008 revisited+superseded 关系（D，账本✓）
- D-008 status=`revisited`，superseded_by=D-013 ✓；D-013 status=`confirmed` ✓。**账本自洽。**

### D5. D-016/D-018 关系（D，账本✓但措辞绕）
- D-016「实现延后 P3」+ D-018「骨架不延后」——二者配合（D-016 管实现、D-018 管骨架），#11（实现 P3）+ #14（骨架 P1）落地。账本✓。**但 D-016 的 rationale 提到「协议骨架单独见 D-018」——这是前向引用，D-016 落盘时 D-018 可能未定。账本时序上 OK（append-only，D-018 后补）。**

## E. review-issues.md 是否放水

### E1. 6 维全 ✅ 过快，未做源码实证（meta）
- **最严重虚覆盖**：review-issues.md 全程**只读 issues.md/架构文档做文字自证**，未实证核验源码声明。本轮实证发现：
  - **#10 的核心前提「3 处重复 TreeNode」事实错误**（见 F1）——grep 实证 `interface TreeNode` 在 components/ 下只命中 2 处（FileView.vue / FileTreeRow.vue），ChangeSetCard.vue 用的是 `FileChange` 不是 TreeNode。review-issues.md 说「完整性 ✅ 0 PHANTOM」——但 #10 的「3 处」描述本身是脱锚的（基于错误的现状描述）。
- **判断**：review-issues.md 的「完整性 ✅」是基于文档内部自洽的判断，**没核验文档对现实的描述是否准确**。这是 review 的根本性盲区。**[必须，见 F1]**

### E2. 「≥2 方案对比 ✅」是数量达标、质量虚覆盖（meta）
- 见 B2——几乎所有方案 B 都是「违反已定 D 决策的反面教材」而非真 trade-off。review-issues.md 把数量（每 issue 有 A/B）当质量通过，**未质疑对比深度**。

### E3. #8/#9 措辞问题「已修正」实为半修正（meta）
- tracing-round-1 角色 B 标「#8/#9 P1 理由措辞误导，建议去掉 file-tree 归因」。review-issues.md 红队结论说「confirmed 决策均无新证据过度」——**未确认措辞是否真改**。
- 实证：#8 现状描述（L567）确实改了（「file-tree 标注走 git.status 不受此 bug 影响」已加），**但「为什么是 P1」段（L573）仍写「此 bug 影响 message-stream ChangeSetCard 的 file_changes 标注准确性（G1 互补）」**——把 ChangeSetCard bug 挂到 G1（浏览文件结构）下是**牵强归因**（ChangeSetCard 是 message-stream 的，G1 是文件树浏览的，二者互补但不是 G1 本身）。tracing-round-1 建议的「去掉 file-tree 归因」在「为什么是 P1」段**未完全执行**。review-issues.md 说搭便车「confirmed」但没核这个残留。**[可选]**

### E4. 可选改进 3 条是否该必须（meta）
- review-issues.md 列 3 条可选改进：
  1. 「AC-4.4 过滤语义⑤验证」——见 C 类，懒加载下过滤=已加载节点，**语义已在 AC-4.4 注明**，不需必须。**可选合理。**
  2. 「#11/#12/#13 fog 触发条件集中登记」——当前分散，**纯文档整洁性**，可选合理。
  3. 「机器检查 SKIP 是脚本问题」——**属实**，非 issues.md 问题。
- **判断**：3 条可选**均合理**，不该提为必须。但 review-issues.md 漏了本轮发现的必须项（C2/C3/C4/F1）。

## F. 实证发现（本轮新发现，源码核验）

### F1. #10「3 处重复 TreeNode」前提事实错误（F，严重）
- **issue 声明**（L675）：「整合 FileView/FileTreeRow/ChangeSetCard 3 处重复 TreeNode 类型」。
- **源码实证**：
  - `grep "interface TreeNode" components/` → **仅 2 处命中**：FileView.vue:63、FileTreeRow.vue。
  - ChangeSetCard.vue:48-50 import 的是 `FileChange, ChangeSetStatus`（**不是 TreeNode**）。
  - 即 ChangeSetCard **根本不用 TreeNode**，它是 message-stream 的改动卡片，数据是 `FileChange[]`（扁平列表），不是树。
- **影响**：
  - #10 的方案 A「整合 3 处」→ 实际只能整合 2 处（FileView + FileTreeRow）。
  - AC-10.1「`grep "interface TreeNode" components/` 仅命中 shared 定义处（不再 3 处重复）」——baseline 就不是 3 处，AC 措辞错误。
  - 方案 B「保留 ChangeSetCard 独立类型」描述的「仍有 2 套类型」是错的——ChangeSetCard 用 FileChange 本就与 TreeNode 无关。
- **判断**：**事实错误，非伪 issue**（#10 整合 FileView/FileTreeRow 2 处仍有价值，§11 AC-5 仍需满足），但「3 处」描述脱锚，AC-10.1 措辞需改。tracing-round-1 角色 A/B 均未实证（只读文档自证「3 处」）。review-issues.md「0 PHANTOM」虚覆盖——#10 不是 phantom，但前提描述错。**[必须：改 #10 描述 + AC-10.1]**

### F2. #1「isUnderOrEqual 从 git-service 抽出」事实不准（F，中）
- **issue 声明**（L130）：「`shared/path-guard.ts`（新，纯函数）：`isUnderOrEqual(cwd, path)` **从 git-service 抽出**共用」。
- **源码实证**：`isUnderOrEqual` **当前不在 git-service 内联**，而在 `runtime/src/utils/path-utils.ts:14`（已是独立 utils 文件）。git-service.ts:24 `import { isUnderOrEqual } from '../utils/path-utils.js'`。且**还有第 3 个消费者 extension-service.ts:25** 也 import 它。
- **影响**：
  - AC-1.2「`isUnderOrEqual` 从 git-service 迁出后 git-service 调用点改 import shared」——**实际迁移源是 `utils/path-utils.ts` 不是 git-service**，且迁移要改 3 处 import（git-service + extension-service + 可能的测试），不是 1 处。
  - AC-1.2 只验「git-service 调用点改 import」**漏验 extension-service**——extension-service 若不改 import 仍引旧 utils，会留 2 套路径校验。
- **判断**：**事实错误**。迁移源是 utils/path-utils.ts（shared utils 已存在），不是「从 git-service 抽出」。AC-1.2 需扩为「所有 isUnderOrEqual 消费者（git-service + extension-service）改 import shared/path-guard，旧 utils/path-utils 可删或保留 isStrictlyUnder」。**[必须：改 #1 描述 + AC-1.2 + ②§7/§10 同步]**

### F3. server.ts:472 handleFileRead「transport 直接 fs」描述准确（F，通过）
- 实证 server.ts:492 `const fs = await import('fs/promises')`——transport 确实直接 fs。**#7/BC-3 描述准确。**

### F4. createAdapter cwd 丢失描述准确（F，通过）
- 实证 index.ts:111 `new EventAdapter(sessionId, interceptor.send, {...})` 的 options 对象**无 cwd 字段**（只有 5 个回调）。`ctx.options?.cwd` → undefined → sendReadyFileChanges 跳过 git 对账。**#8 bug 描述准确。**

### F5. convertPiHistory 不还原 fileChanges 描述准确（F，通过）
- 实证 message-converter.ts:30-120 convertPiHistory 无 fileChanges 字段还原。**#9 bug 描述准确。**

## 必须修改（按严重度排序）

1. **[F1/严重] #10「3 处重复 TreeNode」事实错误** → 实证仅 2 处（FileView + FileTreeRow），ChangeSetCard 用 FileChange 不用 TreeNode。改 #10 问题描述（「3 处」→「2 处」或「FileView/FileTreeRow 的 TreeNode + 评估 ChangeSetCard 的 FileChange 是否需统一」）、方案 A/B 描述、AC-10.1（baseline 不是 3 处）。同步 ②§3/§11 AC-5（②也写「3 处」）。

2. **[F2/中] #1「isUnderOrEqual 从 git-service 抽出」事实错误** → 实际源是 `utils/path-utils.ts`（已存在），消费者含 git-service + extension-service。改 #1 AC-1.2（验所有消费者改 import，不止 git-service）、②§7/§10 path-guard 描述（「从 git-service 抽出」→「从 utils/path-utils 迁到 shared」）。

3. **[C2/D1/D3/中] #3 AC-3.11 失效触发机制空白 + 依赖链断裂** → ① file_changes ready 帧跨 store（chat→fileTree）监听机制未定义；② AC-3.11 漏 agent_end 触发源（②§5 原文有）；③ #3 AC-3.11 隐性依赖 #8（ready 帧需 cwd），但 #3 未 blocked_by #8。补：监听机制说明、agent_end 触发源、评估 #3→#8 依赖边。

4. **[C3/中] AC-3.5 展开态 vs ②§4 reset 矛盾未解** → UC-3 AC-3.2 要展开态跨 session 恢复，②§4 要整体 reset。AC-3.5 措辞模糊（「随 session 生命周期」未说 reset 后水合来源）。补：明确展开态持久化/再水合策略，或修订②§4/UC-3 措辞。

5. **[C4/低] issues.md L12「D-014~D-016」漏 D-017/D-018** → 改为「D-014~D-018」。

## 可选改进

- [B1] #1 AC-1.4 加注「file.write.* 类型在 #14 定义，#1 不含」，防实现者越界。
- [B2] 方案对比注水问题系统性——方案 B 多为反面教材而非真 trade-off。可在 SKILL 层改进（要求方案 B 必须有独立价值）。本轮不阻断。
- [C1] AC-3.7 补测试方法暗示（mock WS 延迟 + 切 session 断言）。
- [E3] #8「为什么是 P1」段去掉「G1 互补」牵强归因（ChangeSetCard 非 G1 本身）。
- [D2] #14 方案对比补真 trade-off 讨论（「现在定契约但 G4 时可能改」vs「G4 时定」）。

## 结论

issues.md **结构扎实、决策链完整、上游覆盖表 0 真漏项**，但有 **2 个 F 类事实错误**（#10「3 处」实为 2 处、#1「从 git-service 抽出」实为从 utils/path-utils 迁）和 **1 个 trace 断裂**（#3 AC-3.11 失效触发机制空白 + 隐性依赖 #8 未标注）是 review-issues.md 全程文字自证漏掉的——**review-issues.md APPROVED 放水**（虚覆盖了事实层与实现机制层）。需主 agent 修 5 项必须修改（2 事实修正 + 2 trace/机制补全 + 1 范围声明）后可 APPROVED。**verdict: CHANGES_REQUESTED。**
