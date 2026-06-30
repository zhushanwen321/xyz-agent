---
verdict: APPROVED
machine_check: PASS
dimension: redteam
review_mode: parallel
---

## Verdict
**APPROVED**

机器检查 8/9 passed，唯一 FAIL 是 `review-issues 存在`（对齐组报告已写、本红队报告正产出）——协议内正常项，非真硬伤。本维度逐条做了 deletion test，**未发现需要阻断的过度设计**；发现 3 条比例失当的 AC/结构建议，均归入「可选改进」，不阻断通过。

> 红队方法论说明：`decisions.md` 中 status=confirmed 且 confirmed_by=ask_user 的决策（D-011~D-020），仅在「有新代码证据证明过度」时才质疑，不因「看起来多余」推翻用户拍板。本次所有 confirmed 决策（含 D-016 两区物理隔离、D-020 debounce 升 P1、D-018 loading/error 列 P1）经源码核验均有实际证据支撑，不质疑。

## 过度设计发现

### 发现 1（比例失当·AC）：AC-1.5「极大查询串 >200 字符截断」(AH-B5) —— 建议降级为 P3/删除
- **对象**：#1 AC-1.5 [边界]（AH-B5）——「极大查询串（>200 字符）早退，避免 O(text×q) 重复计算拖慢渲染」
- **deletion test**：删掉这条 AC 会怎样？⌘K 浮层的 query 是**用户手动键盘输入**（无粘贴大文本的合理路径：浮层 Input 无 paste 处理、无程序化 setQuery 入口）。用户手敲 200+ 字符查询的频率近乎为零；即便发生，segments 是 O(text×occurrences) 线性 indexOf（SearchModal.vue:147-153 实测，非 O(text×q) 嵌套），200 字符 q 的最坏退化也只是子串全重叠场景，单条 title ≤几十字符，开销微秒级，无「拖慢渲染」的实际证据。
- **结论**：**为防御一个用户路径上几乎不可达的输入、且算法复杂度被高估（实为线性非嵌套）的边界，单设一条验收 AC，属比例失当**。其价值低于维护一条低优 AC 的认知成本。
- **建议降级方案**：删除 AC-1.5，或降级为 P3 后续项（与 #11~#16 同列）。AH-B5 这个发现本身可保留在 tracing 笔记，但不应占 P0 issue 的验收位。

### 发现 2（结构·issue 拆分粒度）：#5「api/index.ts 接线」独立成 issue —— 建议并入 #4，但属温和建议不阻断
- **对象**：#5 整个 issue（~5 LOC 三元切换，1 个文件 1 行改动 + 1 处 import + 1 处 type re-export）
- **deletion test**：删掉 #5（并入 #4）会怎样？#4 建 real domain、#5 接线，二者**强耦合同序**（#4 blocked_by 含 #1/#2/#3，#5 blocked_by=#4；#5 唯一作用是把 #4 的产物挂到 api/index.ts）。把「建 domain」和「接线 domain」拆两个 issue、各自一套方案对比（#5 方案 A/B 共 ~40 行方案文本为 ~5 LOC 改动服务）+ 各自 AC + 各自图节点，**issue 管理开销（方案对比/AC/图/依赖维护）已接近甚至超过改动量**。
- **结论**：**#5 是过细的拆分**。最小可行版本是 #4 收尾时顺手接线（AC-4.x 增一条「grep 三元切换」即可），不需要独立 issue 承载独立方案对比。
- **建议降级方案**：#5 并入 #4 作为其最后一步（#4 增加 1 条接线 AC，复用 #5 的 AC-5.1/5.2/5.3）。**但**：注意 #5 的独立存在有一个正面理由——grep AC-1 是 G2 的硬验收锚点，独立 issue 让「mock 误导消除」在 issue 图上有显式节点可追溯。故此项判为**温和建议，不阻断**（保留现状亦合理）。

### 发现 3（比例失当·AC）：AC-3.6「timestamp 计数器兜底」(AH-C3) —— 保留，但标注争议
- **对象**：#3 AC-3.6 [并发]（AH-C3）——「timestamp 用 `Math.max(stored)+1` 兜底，避免同毫秒连续 write 的 FIFO 排序不确定」
- **deletion test**：删掉会怎样？裸 Date.now() 在同毫秒连续 write（用户极快连点确认两个不同项）时，FIFO 排序依赖 timestamp 比较，同值会导致排序不稳定 → recents 顺序跳变。这是**真实可达路径**（虽低频），且修复成本极低（一行 Math.max）。
- **结论**：**比例得当，不降级**。列出此条仅因被点名质疑——核验后认为它比发现 1 的 >200 字符 AC 更有保留价值（真实路径 + 零成本修复），故保留。AH-C3 发现质量高于 AH-B5。

### 未发现过度设计的对象（deletion test 通过项）

- **#1 提取为 match-engine.ts（方案 A 双函数分离）**：被红队重点质询「未来复用论据」。**代码核验**：`lib/file-candidates.ts` 实为 FileNode→DTO **映射器**（toFileCandidates），**不是**匹配引擎；composer 的 `CommandPopover.vue` 渲染 `item.name` 时**无 `<mark>` 高亮**（无客户端 segments 消费）。故「未来 composer 候选过滤复用」**论据不成立**（该论据应从 #1 理由中删去，属夸大表述）。**但**：提取本身的真驱动力是**本期两个消费者**（SearchModal.segments 渲染 + search domain matchFilter 过滤共享同一子串核心算法），DRY 成立，~40 LOC 抽一个纯函数模块**不过度**。结论：设计正确，仅「未来复用」一句话属夸大，建议改写为「本期两个消费者避免重复」即可，**不降级**。
- **#6 方案 C（策略 Map）被否**：合理。固定 4 类型（符号占位不跳转 = 实际 3 handler），switch 比 Map 直白，Map 对编译期固定类型是过度设计——**该否决本身就是反过度设计的正确判断**，无问题。
- **#1 方案 A 双函数分离对 ~40 LOC**：不过度。过滤（matchFilter）与渲染（segments）是正交关注点，方案 B 合一会强耦合（search domain 被迫算不需要的高亮段）。双函数非「为抽象而抽象」，是「两种调用形态天然存在」。
- **D-020 debounce 提前到 P1**：非过度反应。**代码核验**：`useFileSearch.ts:36` 确直调 `composer.getFileCandidates`（file.search 全量递归），每次按键 allSettled × 3 源全量拉取，P1 阶段无 debounce 确是性能炸点。debounce 是 #4/#7 落地即需的性能护栏，升 P1（与 watch query 同 PR）正确。confirmed_by=ask_user 且证据为真，**不质疑**。
- **D-016 两区物理隔离（独立 ref）**：非过度。appCommands 静态 vs slashCommands per-session 动态，失效语义不同，独立 ref 避免应用命令被 session 切换误触发响应式——这是正确性护栏非性能优化，对 <20 项也值得（响应式误触发是 bug 非 overhead）。
- **#8 AC-8.4 setTimeout clearTimeout**、**AC-7.14 open/close 竞态**：比例得当（资源泄漏/定时器残留是真实路径，成本零）。
- **#10 剩 2 项（Sidebar keydown + scrollIntoView）独立 issue**：D-019/D-020 已标「待⑤骨架验证确认」，自带降级出口（若超预期降 P3），且 P2 非阻断。搭便车独立成 issue 便于⑤逐项核工作量，**不过度**。
- **AH-E1/E2（search domain 直调 composer.getFileCandidates 不经 useFileSearch.load 吞错层）**：**代码核验** useFileSearch.ts:39-43 确为静默 catch 降级空数组（「不抛」）。该决策是**消除既有吞错缺陷**的必要路径，非过度设计——若经吞错层，#8 AC-8.2「不静默」假性 PASS。证据为真，**不质疑**。

## 必须修改
无（本维度 APPROVED，无需阻断性修改）。

## 可选改进（不阻断通过，建议主 agent 酌情采纳）
1. **删除/降级 AC-1.5**（AH-B5 >200 字符截断）：比例失当，用户手敲 200+ 字符查询近乎不可达，且算法实为线性非嵌套 O(text×q)。建议降为 P3 或删除该 AC（AH-B5 笔记保留即可）。
2. **#5 并入 #4**（温和建议）：~5 LOC 接线独立成 issue 的管理开销 ≈ 改动量，建议作为 #4 末步 + 1 条接线 AC；若为保 G2 grep 验收锚点而保留独立 issue 亦合理。
3. **修正 #1 取舍理由表述**：删去「未来其他搜索场景（如 composer 候选过滤）复用」——经核验 composer CommandPopover 无客户端高亮、file-candidates.ts 是映射器非匹配引擎，该论据夸大。改写为「本期两个消费者（SearchModal 渲染 + search domain 过滤）避免子串算法重复」即足。
