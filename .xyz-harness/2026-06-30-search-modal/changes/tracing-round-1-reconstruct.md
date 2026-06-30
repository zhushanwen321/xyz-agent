---
frame: reconstruct
verdict: GAP_FOUND
gap_count: 16
---

# test-matrix 禁读重建 — Round 1

> 重建方法：先从 ①UC+AC / ④MR(代码测试类) / ⑤§4 时序图 alt/else 三类源头**独立推导**「该有哪些用例类别」，**完成后**才读 §6 初稿做集合 diff。
> 关键约束遵守：重建阶段未读 §6；D-026（编排归 useSearch.ts）已 confirmed，不当 gap 重报。
> 本轮聚焦⑤test-matrix §6 盲区（前序 round-1-reconstruct 是 spec↔requirements diff，已归档，此处覆盖为 test-matrix 重建）。

## 重建的用例类别（从①④⑤§4 独立推导）

### 来源①：按 UC 推导（每 UC 正常/边界/异常/状态/并发/e2e）

**UC-1（唤起/浏览 recents）**
- 正常-唤起聚焦：⌘K 唤起→输入框自动聚焦+光标置末尾（AC-1.1）
- 正常-空查询分组：recents 按类分组每类≤5/共≤20（AC-1.1）
- 正常-键盘导航：↑↓ 跨组扁平化移动选中项（AC-1.2）；Tab/Shift+Tab 循环切类（UC-1 替代流 b，F3 本期）
- 正常-选中视觉态：Card-Active inset ring（AC-1.2）
- 正常-关闭方式：Esc / 再按⌘K(toggle) / 点遮罩 三种均关闭（AC-1.3, AC-7.1 变更项）
- 正常-高亮：命中子串 `<mark>` accent 色（F4，空查询段不命中）
- 边界-recents空首用：空态引导文案（AC-1.4, AC-3.3）
- 边界-持久化：reload 后 recents 保留（AC-1.5）
- 边界-FIFO淘汰：每类超5项淘汰最旧（AC-1.5, MR-3.4）
- 边界-脏数据降级：localStorage JSON.parse 失败→[]（MR-3.1）
- 边界-配额满：内存态保留 reload 丢失（MR-3.3）
- 异常-查询无结果：「未找到」空态（§4 功能2 全源空）
- 并发-乱序响应：loadSeq 守卫（BC-9）
- 并发-快速open/close：clearTimeout+open flag（AC-7.14）
- 并发-close孤儿查询：open flag 守卫不发 WS（MR-7.1）
- e2e-首屏冒烟：mount 渲染 gate（TEST-STRATEGY §3）

**UC-2（搜索并执行命令）**
- 正常-查询命中命令：pi slash（/commit）+ 应用命令（新建）（AC-2.1）
- 正常-子串高亮：`<mark>` 不加背景（AC-2.2）
- 正常-执行：应用命令 action 执行+toast+关浮层+写recents（AC-2.3, AC-6.1/6.4）；slash 命令注入 composer（AC-6.1）
- 边界-同名去重：pi 带/前缀不撞应用命令（AC-2.5）
- 异常-需active session无session：置灰或提示（AC-2.4）
- 异常-action抛错：toast+浮层保持打开（AC-6.8）
- 状态-成功关浮层：先 await 成功再关（AC-6.7）

**UC-3（搜索并打开文件）**
- 正常-查询命中：按相对路径子串匹配（AC-3.1）
- 正常-打开预览：Enter→DetailPane 打开（AC-3.2, AC-6.2）
- 边界-无active session：文件分组提示（AC-3.3）
- 边界-加载态：>200ms 显 / <200ms 不显（AC-3.4, AC-8.1）
- 边界-大仓库截断：>5000 显截断提示（AC-4.7）
- 边界-缓存命中：二次查询不重复 WS（AC-4.9）
- 异常-读取失败：file.read reject→toast+浮层保持（AC-6.5, AC-6.9 直调不经吞错层）
- 异常-file源WS reject：分组空态静默（AC-4.5, MR-4.2）
- 状态-成功关浮层（AC-6.7）

**UC-4（搜索并切换会话）**
- 正常-跨项目命中：label/cwd/gitBranch 匹配（AC-4.1）
- 正常-gitBranch缺失降级：非 git 目录仅匹配 label/cwd（AC-4.1）
- 正常-切换：Enter→active session 切换+写recents（AC-4.2, AC-6.3/6.4）
- 边界-跨项目侧栏定位：命中他项目会话侧栏定位分组（AC-4.3）
- 边界-会话库空：空态提示（AC-4.4）
- 异常-切换失败：toast+刷新列表+浮层保持（UC-4 异常, AC-6.6）
- 异常-session源WS reject：分组空态静默（AC-4.8, MR-4.2）
- 异常-WS断连超时race：10s reject→allSettled settle（AC-17.1, MR-17.1）
- 异常-全源失败：四类空态+toast（AC-17.3, MR-4.2）
- 状态-成功关浮层（AC-6.7）

**UC-5（符号占位）**
- 正常-占位渲染：分组头+占位提示保留（AC-5.1, AC-4.6）
- 边界-占位恒定：不随查询变化（AC-5.2）
- 异常-选中不跳转：返回 not-available（D-001）
- 异常-占位渲染失败：整个符号分组隐藏不阻断其他类（UC-5 异常）

### 来源④：MR(验收方式=代码测试) ≥1 用例
- MR-3.1 → useRecents read 脏数据降级 + write 配额满 catch（unit）
- MR-3.3 → 配额满内存态保留（unit）
- MR-3.4 → FIFO 淘汰时机（类满/同 key/计数器兜底）（unit）
- MR-4.2 → 单源 reject 静默 vs 全源失败 toast（integration）
- MR-17.1 → WS 超时 race（integration）

### 来源⑤§4：时序图 alt/else ≥1 异常用例
- §4 功能1 alt：key存在合法 / key不存在首用 / JSON.parse失败（MR-3.1）
- §4 功能2 alt：file缓存命中 / file WS reject / session WS reject / WS断连超时 / 全源失败 / activeSessionId=null / 乱序响应 / 文件>5000截断
- §4 功能3 alt：command action抛错 / file.read reject / session.switch reject / symbol选中 / 跳转先await再关
- §4 功能4 alt：快速open/close / close孤儿查询 / >200ms loading / <200ms loading / 组件卸载清理

## 与 §6 初稿的集合 diff

### MISSING（该有而初稿漏列）—— [K 完整性缺口，最关键]

**M1. AC-1.1 输入框自动聚焦 + 光标置末尾 —— 无用例**
- 源头：①UC-1 AC-1.1「⌘K 唤起浮层，输入框自动聚焦」（主流程步骤2）；⑤§4 功能1 时序图入口 `U->>SM: ⌘K 唤起`
- 初稿现状：T1.1 只断言「渲染分组 + Clock 图标」，**无聚焦断言**。唤起后输入框未聚焦是 P0 体验 bug（用户得手动点输入框），却无回归防线。
- 建议用例 ID：T1.1b（正常-唤起聚焦）；断言：`open=true` 后 `search-input` 元素 `=== document.activeElement`，且光标在末尾（selectionStart===value.length）。

**M2. AC-1.2 ↑↓ 跨组扁平化键盘导航 —— 无用例**
- 源头：①UC-1 AC-1.2「↑↓ 跨组扁平化移动选中项」+ 主流程步骤3「用户按↑↓浏览」；requirements F3「键盘导航（↑↓/Enter/Tab/Esc）」明确**本期 IN SCOPE**（§8 不做清单只列 ⌘1..⌘5，未列 ↑↓/Tab）。
- 初稿现状：扫描 T1.1~T1.8 全部 UC-1 用例，**无任何 ↑↓ 键盘移动断言**。§6 自检第3条把 `type_filtered` 标「P2 #9 延后」——但 #9 延后的是 ⌘1..⌘5 直达，不是 ↑↓/Tab 基础导航。**自检误把本期 IN-SCOPE 的 ↑↓/Tab 当延后项，致盲区。**
- 建议用例 ID：T1.1c（正常-↑↓导航）；断言：跨分组边界时 selIdx 正确跨越（命令组末→文件组首），`scrollIntoViewIfNeeded` 滚动到选中项。

**M3. AC-1.2 Tab/Shift+Tab 循环切类 —— 无用例**
- 源头：①UC-1 替代流 b「Tab / Shift+Tab 循环切类」；requirements F3 本期功能；⑤§5 状态表「类型过滤 Tab/Shift+Tab 循环切类」；issues #9 是 Tab 切类 issue（本期 IN SCOPE）。
- 初稿现状：无 Tab 切类用例。
- 建议用例 ID：T1.1d（正常-Tab切类）；断言：Tab 切到下一类 activeType 更新，Shift+Tab 逆序，selIdx 重置（issues AC-9.3）。

**M4. AC-1.2 选中项 Card-Active inset ring 视觉态 —— 无用例**
- 源头：①UC-1 AC-1.2「选中项有 Card-Active inset ring 视觉态」。
- 初稿现状：无选中态 class/style 断言。
- 建议用例 ID：T1.1e（正常-选中视觉态）；断言：当前选中项 DOM 含 Card-Active 标识类（inset ring 样式存在）。

**M5. AC-1.3 三种关闭方式（Esc / 再按⌘K / 点遮罩）—— 无独立用例**
- 源头：①UC-1 AC-1.3「Esc / 再按⌘K / 点遮罩三种方式均能关闭浮层」+ UC-1 替代流 a；⑤§4 功能4 时序图 `U->>SM: Esc/再按⌘K/点遮罩`。
- 初稿现状：T1.6/T1.7 只测 open/close **并发竞态**，**无任何用例验证三种关闭方式本身能关闭浮层**。⌘K toggle 变更（AC-7.1，G2 明确为行为变更项）尤需回归。close 路径坏掉无防线。
- 建议用例 ID：T1.1f（正常-关闭方式×3）；断言：Esc keydown / ⌘K keydown(toggle) / 遮罩 click 后 `open===false` 且焦点还给触发元素（UC-1 后置状态）。

**M6. AC-1.5 recents 持久化 reload 后保留 —— 无用例**
- 源头：①UC-1 AC-1.5「recents 持久化到 localStorage，reload 后保留」；D-007 跨会话保留。
- 初稿现状：T1.11（MR-3.4）只测 **FIFO 淘汰时机**（类满/同key/计数器），**无 reload 后 read() 读回持久化数据的断言**。D-007「跨会话保留」是 confirmed 决策，却无跨 reload 持久化回归。
- 建议用例 ID：T1.11b（边界-reload 持久化）；断言：write(entry) 后重新 read() 返回含该 entry（key 命名为 `xyz-agent:search-recents`，MR-3.2 骨架约束的运行时验证）。

**M7. AC-2.2 子串高亮 `<mark>` accent 色 —— 无独立用例**
- 源头：①UC-2 AC-2.2「命中项显示子串高亮（`<mark>` 标记，accent 色，不加背景）」；requirements F4「匹配高亮（子串 `<mark>` accent 色）」；⑤§3 segments() 签名 + §4 功能2 `SM->>ME: segments`。
- 初稿现状：无高亮用例。T2.1 只断言命令分组命中，**无 `<mark>` 渲染 / accent 色 / 不加背景的断言**。segments() 是 §3 独立可测纯函数（有独立边界条件 `q='' 返回单元素`），却无单测。
- 建议用例 ID：①match-engine 单测 T-ME-1（segments 命中段 hit:true）；②集成 T2.1b（DOM 含 `<mark>` 元素且无 background 样式）。

**M8. AC-2.4 需 active session 的命令无 session 时提示 —— 无用例**
- 源头：①UC-2 AC-2.4「需 active session 的命令在无 session 时有明确提示，不静默失败」+ UC-2 异常流程「命令需要 active session 但当前无 active session → 命令项置灰或提示」。
- 初稿现状：T2.5 测的是 **command action 抛错**（AC-6.8），**不是无 session 提示**。AC-2.4 无任何对应用例。slash 命令（/commit）需 active session 注入，无 session 时降级路径无防线。
- 建议用例 ID：T2.5b（异常-命令需session无session）；断言：activeSessionId=null 时 slash 命令项置灰/提示文案「需要先选择会话」，不静默执行失败。

**M9. AC-3.1 文件按相对路径展示 —— 断言不足**
- 源头：①UC-3 AC-3.1「输入文件名片段命中当前项目内文件，**按相对路径展示**」；requirements §3 数据清单「按相对路径子串匹配」。
- 初稿现状：T3.1 只断言「文件分组命中当前项目文件」，**无相对路径（非绝对路径）展示断言**。GAP-BL-2 残余风险是「绝对路径泄漏」，文件分组展示相对路径是反方向的正确性约束，应断言 sub 为相对路径。
- 建议用例 ID：T3.1b（正常-相对路径展示）；断言：命中文件 sub 字段为相对 cwd 的路径（不含绝对路径前缀）。

**M10. AC-4.1 gitBranch 缺失降级匹配 —— 无独立用例**
- 源头：①UC-4 AC-4.1「gitBranch 缺失时不显示该字段，**仅匹配 label/cwd**」；requirements §3 数据清单「gitBranch 缺失时降级为仅匹配 label/cwd，非 git 目录 gitBranch 为 undefined」。
- 初稿现状：T4.1 场景笼统写「label/cwd/gitBranch 匹配，gitBranch 缺失降级」，但**未拆独立用例验证「非 git 目录（gitBranch=undefined）会话仍能被 label/cwd 命中」**。降级匹配是 DTO 映射（D-025）的关键分支，gitBranch=undefined 的会话若被错误排除是数据完整性 bug。
- 建议用例 ID：T4.1b（正常-gitBranch缺失降级）；断言：session gitBranch=undefined + label 含查询词 → 仍命中会话分组（不被 gitBranch undefined 过滤掉）。

**M11. UC-5 占位渲染失败整个符号分组隐藏不阻断 —— 无用例**
- 源头：①UC-5 异常流程「占位提示渲染失败（极端）→ 整个符号分组隐藏，不阻断其他三类」。
- 初稿现状：T5.3 测 symbol 选中不跳转，**无占位渲染失败容错用例**。D-002 审查裁决保留 UI 渲染占位，其异常容错（隐藏符号分组不阻断命令/文件/会话）应有防线。
- 建议用例 ID：T5.4（异常-占位渲染失败容错）；断言：mock 符号分组渲染抛错 → 符号分组隐藏，命令/文件/会话三类仍正常渲染。
- *注：此条优先级低于 M1~M10（极端场景），但同源（①UC-5 异常），如实列出。*

**M12. issues #9 Tab 切类 selIdx 重置 / recents 态正交 —— 无用例（与 M3 同源但侧重 NFR）**
- 源头：④non-functional Issue #9「Tab 切类」分析「AC-9.3 守 selIdx 重置，AC-9.4 守 recents 态正交」（全部 ✅ 但有可测 AC）。
- 初稿现状：无 #9 相关用例（§6 自检把 type_filtered 标 P2 延后，但 #9 本期 IN SCOPE）。
- 建议用例 ID：并入 M3 的 T1.1d，断言补 AC-9.3（切类后 selIdx 重置）+ AC-9.4（recents 态下 Tab 行为正交）。

**M13. 缓存失效竞态 MR-4.4 / stale cache —— 标注矛盾需澄清**
- 源头：④MR-4.4「search domain 消费 session 级缓存时须自绑 setupInvalidation watch（不依赖 CommandPopover 挂载），防 stale cache」——回灌去向标「③issues #4 新 AC-4.10」，验收方式=代码测试。
- 初稿现状：§6 来源 B 自检未列 MR-4.4（只列 MR-3.1/3.3/3.4/4.2/17.1）。但 MR-4.4 验收方式=代码测试，按 [MANDATORY] 规则应进 test-matrix 或在③有 AC-4.10 对应用例。**§6 无 AC-4.10 对应用例，也无 MR-4.4 映射行**——若 AC-4.10 已在③issues 定义，则 §6 来源 A 应有对应用例（如 T3.x stale cache）；若无，则 MR-4.4 是悬挂承诺。
- 建议用例 ID：T3.9（异常-stale cache）；断言：CommandPopover 未挂载时改文件 → search domain 缓存 invalidate 触发（setupInvalidation watch 自绑），搜得到刚改的文件。*需主 agent 澄清 AC-4.10 是否已在③定义并补用例。*

### PHANTOM（初稿有但①④无根）—— [D 设计争议，优先级低]

**P1. T1.8 e2e 首屏冒烟 —— 弱根但可接受**
- 用例 ID：T1.8；关联 TEST-STRATEGY §3（⑤来源 DoD）。
- 为何列入审查：源头是⑤测试策略（非①UC 也非④MR），属「渲染 gate」DoD。但 TEST-STRATEGY 是⑤合法来源（非①④），**不算无根 PHANTOM**——保留，仅备注其来源是⑤而非①④。

*本轮无强 PHANTOM（初稿用例均有①UC 或④MR 或⑤§4 根源）。*

### MISMATCH（标覆盖但断言不符）—— [F 事实错误]

**MM1. T2.4 关联 AC 错误 —— 应关联 AC-2.5 非 AC-2.3**
- 用例 ID：T2.4；场景「应用命令与 slash 同名，按 name 唯一，pi 带/前缀天然不撞」。
- 断言点问题：§6 标关联 **AC-2.3**，但 ①UC-2 AC-2.3 是「Enter 执行命令后浮层关闭 + toast 反馈」（正常执行），**与同名去重无关**。同名去重的正确根源是 **AC-2.5**（边界「应用命令与 pi 命令同名时……分开展示」）+ D-009。
- 修正：T2.4 关联 AC 应改为 **AC-2.5, D-009**。

**MM2. §6 自检第1条「正常类齐全」假性 PASS —— UC-1 正常类严重缺失**
- 问题：§6 覆盖完整性自检第1条勾选「每 UC 的正常/边界/异常/状态 4 类齐全（UC-1: T1.1~1.8）」。但实际 UC-1 正常类仅 T1.1（空查询渲染）一条，**AC-1.1 聚焦 / AC-1.2 ↑↓导航+视觉态 / AC-1.3 三种关闭 / Tab 切类 / 高亮** 共 5 条正常 AC 无独立用例（见 M1~M5, M7, M12）。自检「正常类齐全」是假性 PASS。
- 修正：自检第1条 UC-1 正常类不达标，应补 M1~M5 后才能勾选。

**MM3. §6 自检第3条「type_filtered: P2 #9 延后」误判 IN-SCOPE 为延后**
- 问题：§6 自检第3条把 `type_filtered` 状态转换标「P2 #9 延后」。但 requirements F3「键盘导航（↑↓/Enter/Tab/Esc）」是**本期功能**，§8「不做」清单只列 ⌘1..⌘5（未列 Tab/↑↓）。issues #9（Tab 切类）本期 IN SCOPE。**把本期 IN-SCOPE 的 Tab 切类当延后项，是事实错误**，直接导致 M3/M12 盲区。
- 修正：type_filtered（Tab 切类）应移出「延后」，补 M3 用例；只有 ⌘1..⌘5 直达快捷键才是真延后。

## 收敛判定

**GAP_FOUND**

- **MISSING 13 条**（M1~M13）：核心产出。集中在 **UC-1 正常类交互防线全面缺失**（聚焦/↑↓导航/Tab切类/视觉态/三种关闭/高亮/持久化）——这是用户最高频路径（唤起→浏览→关闭），却几乎无交互回归用例，仅 T1.1 一条渲染断言。次要集中在 **DTO 映射正确性**（相对路径 M9 / gitBranch 降级 M10）和 **命令无 session 提示 M8**。
- **MISMATCH 3 条**（MM1~MM3）：T2.4 关联 AC 错（AC-2.3→AC-2.5）；两条自检假性 PASS（正常类齐全 / type_filtered 延后误判）。
- **PHANTOM 0 条**（P1 弱根但合法，保留）。

**最致命同源盲区**：M2/M3/M12——§6 自检第3条把 Tab 切类/↑↓导航误判为「P2 #9 延后」，但 requirements F3 明确本期 IN SCOPE，§8 不做清单不含 ↑↓/Tab。这个**源头误判**（⑤§6 自检 vs ①requirements F3/§8 矛盾）直接导致键盘导航这一核心交互路径零测试覆盖，是同源盲区的典型——主 agent 初稿在自检时把本期功能错当延后项，从而未生成用例。

**次致命**：M5（三种关闭方式无用例）+ M6（reload 持久化无用例）——都是 ①AC 明确列出的验收标准（AC-1.3/AC-1.5），却无对应测试，AC 验收假性 PASS。

**建议主 agent 优先级**：M1~M8 为 P0（①AC 明确 + 用户高频路径）；M9~M11 为 P1（DTO/边界正确性）；M12/M13 为 P1（需澄清 #9 scope / AC-4.10 落点）；MM1~MM3 为 P0 修正（自检假性 PASS 会掩盖覆盖缺口）。
