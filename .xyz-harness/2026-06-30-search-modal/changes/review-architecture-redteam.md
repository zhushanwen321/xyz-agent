---
verdict: APPROVED
machine_check: PASS
dimension: redteam
---

## Verdict

APPROVED

> 红队立场逐项 deletion test 后，**未发现需要降级的过度设计硬伤**。该架构整体走的是「反过度」方向——三层而非 DDD 四层（D-011）、不做伪 port（D-012）、纯 DTO 无 aggregate（D-013）、松散状态机不建转换表（D-014）。这些恰恰是红队通常会要求的方向，本就达标。
>
> 七个模块、四个 D-不可逆决策、分层深度、搭便车 3 项均通过 deletion test。发现 3 处「边缘可商榷项」（列在下方，标注不构成阻断），建议在 ⑤骨架阶段明确边界，但不阻断本阶段定稿。

**machine_check 说明**：脚本 exit 1（FAIL），但唯一 ❌ 是 `review-architecture.md 不存在`——这正是本次审查待产出的兄弟文件，属预期失败项，按用户指令豁免。架构定稿相关的 8/8 检查项全过（frontmatter / 关键章节 / 占位符 / 核心计算 / 模型类型 / 状态机正交 / 设计立场 / 文件存在）。故对「架构本身质量」machine_check = PASS，无架构硬伤。

## 过度设计发现

> 格式：对象 + deletion test 结论 + 建议降级方案。✅ = 通过（删不掉/删了得不偿失）；⚠️ = 边缘可商榷（不阻断，建议⑤澄清）。

### 七个模块 deletion test（§7）

**1. SearchModal.vue（改造）✅**
- 删掉会怎样：浮层 UI 入口消失，整个 feature 不存在。无可删。
- 结论：必须保留，非过度。

**2. search real domain（api/domains/search.ts ~120 LOC）✅**
- 删掉会怎样：4 数据源查询编排逻辑需另寻归属。若塞回 SearchModal.vue，UI 组件将同时承担渲染 + 键盘导航 + 多源编排，职责过载（且 G2 明确要求 search 接 real domain 替换 mock，domain 是替换落点）。
- 最小可行版本：编排可内联组件，但会破坏项目现有 `domains/* + transport` 一致模式（requirements §7、sys-arch §2 均引用），且 mock 切换无统一装配点。
- 结论：合理。编排逻辑有独立归位，且与项目架构一致。非过度。

**3. 命令注册表（command store 扩展 + useCommandRegistry composable ~100 LOC）⚠️ 边缘可商榷**
- 删掉 composable 会怎样：若 command store 扩展后能暴露聚合 getter（appCommands + slashCommands 合一），composable 的「聚合读取」职责就是 store getter 的薄封装——可删。
- 但 composable 还承担「应用命令注册动作」（§6/§7：跨 store 协调 + 注册）。若注册逻辑确需独立承载（store 是状态容器、不承担注册副作用），composable 有存在价值。
- deletion test 结论：**取决于 composable 的真实职责边界**。当前文档对 composable vs store getter 的分工描述模糊——若 composable 仅做聚合读取 = 薄封装过度；若承担注册 + 聚合 + 消费者共享访问点 = 合理。
- 建议降级方案：**不必降级模块**，但 ⑤骨架阶段须明确「composable 承载哪些 store getter 做不到的事」（至少：应用命令 register 动作 + 多消费者共享 setup）。若验证后发现仅是聚合读取，则降级为「store getter + 直接引用」，删 composable。属 confirmed 决策（D-004 ask_user + D-016 agent-opinionated），不阻断。

**4. 匹配引擎（lib/match-engine.ts ~40 LOC 纯函数）✅**
- 删掉会怎样：segments 子串高亮逻辑（现 SearchModal.vue:141-155 内联）留在组件里也能跑。
- 但 §9 泳道图证实两个消费者：search domain 调 `matchFilter` 过滤候选、SearchModal 调 segments 产生高亮段。40 LOC 纯函数 + 双消费者 + 可独立单测 = 标准提取，非过度。
- 结论：合理。

**5. 跳转编排（composables/useSearchJump.ts ~80 LOC）✅**
- 删掉会怎样：3 类跳转分发（命令执行 / file.read+DetailPane / session.switch）塞回 SearchModal.vue。组件从 186 行膨胀到 266+，且 UI 渲染与 IO 编排（调 runtime + useDetailPane + useSidebar）职责混杂。
- BC-3 已标记现 emit select 父组件未接入，D-006 要求接入真实跳转——跳转逻辑是新增 IO 编排，天然适合 composable 抽离。
- 结论：合理。

**6. recents composable（composables/useRecents.ts ~60 LOC）⚠️ 边缘可商榷**
- 删掉会怎样：localStorage 读写 + FIFO 淘汰（每类 5 项 × 4 类）逻辑塞回 SearchModal。组件再增 60 行 + 副作用。
- 比例性质疑：60 LOC 是否够「独立模块」阈值？边缘。但内含 FIFO 淘汰算法（有边界用例：超 5 项淘汰最旧、type+key 唯一性）+ localStorage 副作用隔离 + 可独立单测，抽离有测试与解耦收益。
- deletion test 结论：**删掉不致命但会损失可测性 + 让组件变重**。属合理抽离，阈值边缘但不构成过度。
- 建议降级方案：无需降级。若 ⑤验证 FIFO 逻辑极简（<30 LOC），可考虑内联回组件，但当前估算支持独立。

**7. api/index.ts 接线改造（~5 LOC）✅**
- mock → real 切换的三元装配，G2 硬性要求。无可删。

### D-不可逆决策质询

**D-011 三层 vs DDD 四层（confirmed ask_user）✅ —— 真·反过度**
- 红队通常要求「删层」，本决策恰是删了 Domain 层（理由：核心是技术编排无领域规则，Domain 会是空壳）。
- 真不可逆？若将来出现领域规则（如命令权限策略），可补 Domain 层——可逆。但当前删层是正确的复杂度归位。
- 结论：反过度设计典范，通过。

**D-012 不做 port（confirmed ask_user）✅ —— 真·反过度**
- 红队核心打击对象（伪 port），本决策主动避免。4 数据源接口形状不同（前端内存 vs runtime WS），删/翻/挪证伪为伪 port。匹配策略稳定无替换需求。
- 结论：反过度设计典范，通过。

**D-013 纯 DTO 无 aggregate（confirmed ask_user）✅ —— 真·反过度**
- 不建 SearchSession aggregate（理由：无领域不变式可守，建了是「装着 UI 逻辑的对象」反模式）。正确。
- 结论：反过度设计典范，通过。

**D-016 扩展 command store 两区物理隔离（confirmed agent-opinionated）⚠️ 可商榷但不阻断**
- 这是唯一 `confirmed_by=agent-opinionated` 的架构决策，红队可正常质疑实现方式（决策纪律：不质疑「是否扩展」本身，只质疑实现）。
- 质询：应用命令（全局静态、启动注册、无失效）与 slash 命令（per-session 动态、session 切换刷新）**失效语义不同**，却放同一 store 文件，用「独立 ref 物理隔离」应对。把两个不同生命周期的东西塞同一 store，是否增加耦合？
- 反方理由成立处：两区同属「命令」概念，复用 SessionCommand 模型 + store 基建，内聚；独立 ref 避免响应式误触发。
- 真不可逆？后续若想拆为独立 store 可逆（ref 迁移即可）。决策本身可逆，非硬约束。
- deletion test 结论：**实现方式有 trade-off 但理由成立**（内聚 + 模型复用）。换独立 store 会产生两个命令 store、消费者聚合更麻烦——并非明显更优。
- 建议降级方案：**不降级**。但建议 ⑤骨架时确认「独立 ref 物理隔离」真的实现了（appCommands 与 slashCommands 不揉进同一响应式根），否则隔离是名义上的。

### 分层深度质询

**「核心编排真的需要 Service + Store 两层吗？合并行不行？」✅**
- Store 层仅 1 个（command store 扩展），不算过深。
- composable（useCommandRegistry / useSearchJump / useRecents）是 Vue 项目标准模式（状态复用 + 副作用封装），不构成额外「架构层」——它们是 Service 层内的模块化手段，不是独立分层。
- useSearchJump / useRecents 不依赖 store（独立 IO/持久化编排），本就不该塞 store。
- 合并 composable 进 store 会违反「store 无外部依赖铁律」（sys-arch §6 Store 层标注「stores 无外部依赖」）——useSearchJump 调 runtime、useRecents 调 localStorage，塞 store 违规。
- 结论：分层深度合理，合并会违规。非过度。

### 搭便车 3 项质询（D-015，confirmed ask_user，候选待⑤验证）

**① Sidebar keydown 接入命令注册表 ✅**
- 是 D-004 命令注册表的必要延伸——建了注册表却只服务 search、不消除 Sidebar 硬编码 if/else，注册表价值减半。顺势重构非无关 refactor。
- 风险：触及 Sidebar.vue:228-241 现有 ⌘N/⌘K/⌘B 行为（BC-1 守护）。但决策标「候选待⑤骨架验证」，有风险控制闸门。合理。

**② scrollIntoView → scrollIntoViewIfNeeded ✅**
- spec 明确要求（避免 OD 预览 iframe 滚动冲突），是 spec 合规修复，非锦上添花。BC-7 已标记为「以 D-015 ⑤验证为前提，不纳入则回退保持」。有回退路径。合理。

**③ 查询 debounce(120ms) ✅**
- spec 要求，现状无 debounce（SearchModal.vue:124）会致频繁查询。性能合规修复。合理。

**搭便车总判**：3 项均 spec 合规或 D-004 顺势，非无关改造；均有「候选待⑤验证」风险闸门 + 回退路径。非额外风险叠加，合理。

## 必须修改

无。红队维度无阻断项。

> 3 处边缘可商榷项（useCommandRegistry 职责边界 / recents composable 阈值 / D-016 物理隔离落地确认）均归入「⑤骨架阶段澄清」，不构成本阶段 CHANGES_REQUESTED。整体架构为反过度设计方向，七模块各有归位，分层深度合理。
