---
phase: architecture
tracer: independent-subagent
frame: evolution
round: 1
---

# Tracing Round 1 · evolution 帧（视角5 变化轴 / 视角6 行为契约）

> 范围：只评 §7 模块划分 + §12 行为契约。已 confirmed 决策（D-011~D-016）不当 gap 重报。

## 视角5 变化轴（逐模块判断）

逐条核对 §7 七个模块，判断「单轴 / 拆分粒度 / 命名是否反映变化轴」。

| 模块（§7） | 判断 | 说明 |
|-----------|------|------|
| SearchModal.vue（改造） | ✅ 单轴 | 改造后 segments→ME、跳转→JO、recents→RC 抽走，SearchModal 收敛为「UI 交互 + 键盘导航 + 渲染」单轴。现 186 行→~250 行预估偏保守（抽走后应更少），LOC 预估存疑但不影响轴判断。 |
| search real domain（新建） | ⚠️ 疑似二轴 | 标注轴=「数据源查询编排」，但 §9 swimlane 显示其还做「合并全量候选」+（隐含）分组输出。**分组（按 type 分箱成 4 section）是独立于「查询编排」的第二轴**，归属未明确。见 GAP-E1。 |
| 命令注册表（store 扩 + composable 新） | ✅ 单轴 | 物理跨 2 文件但同属「命令聚合」一轴；store=存储、composable=聚合逻辑，是同一关注点的存储/逻辑切分，合理（D-016 两区隔离已 confirmed）。 |
| 匹配引擎（提取纯函数） | ⚠️ 边界含糊 | 提取为独立模块**合理**——存在两消费者（SearchModal 渲染 segments + search domain 过滤候选），共享子串核心算法，~40 LOC 适中，AC-4 可验收纯函数。**但职责边界含糊**：§7 说 ME=「匹配+segments」，§9 却让 ME 返回「分组结果」。见 GAP-E2。 |
| 跳转编排（新建） | ✅ 单轴 | 三条分发路径（命令执行/file.read/session.switch）同属「跳转路由」轴，合理。 |
| recents composable（新建） | ✅ 单轴 | 读写+FIFO 淘汰同属「recents 持久化」轴，合理。 |
| api/index.ts（接线改造） | ✅ 单轴 | domain 装配，~5 LOC 纯接线，合理。 |

**命名是否反映变化轴**：跳转编排/匹配引擎/recents composable/命令注册表 命名均贴轴。唯 `search real domain` 命名强调「real vs mock」迁移语义而非轴本身（查询编排），但因遵循 `api/domains/*` 既有约定，可接受。

**核心结论**：7 模块中 5 个干净单轴；问题集中在 **search domain 的分组归属** 与 **匹配引擎职责边界**，且二者在 §7 与 §9 间存在矛盾陈述。

## 视角6 行为契约（遗漏检查）

### 源码位置准确性核对
BC-1~BC-8 全部 8 条的源码行号核对 SearchModal.vue **均准确**（BC-1:11、BC-2:157-162、BC-3:171-177、BC-4:141-155+60-69、BC-5:124-129、BC-6:80-87、BC-7:164-169、BC-8:115 实测一致）。

### 「代码有但文档没写」的遗漏行为
逐行扫 SearchModal.vue，发现以下行为未进任何 BC：

| 遗漏行为 | 源码位置 | 严重度 | 说明 |
|---------|---------|--------|------|
| **竞态保护 loadSeq** | `:123` `:126-128` | 🔴 高 | 序列号守卫，乱序响应不覆盖新结果。refactor 重写 loadResults 时**极易丢失**，是正确性不变式，必须登记为新 BC。 |
| **鼠标 hover 同步选中 + click 确认** | `:50` `:51` | 🟡 中 | `@mouseenter` 同步 selIdx、`@click` 触发 confirmSel。BC-2/BC-3 只覆盖键盘路径，鼠标输入路径完全空白。 |
| **查询变化重置 selIdx=0** | `:180` | 🟡 中 | 每次按键 selIdx 跳回首项，影响 UX 一致性，refactor 须保留。 |
| **关闭清空 query + 打开触发 loadResults** | `:182-185` | 🟡 中 | 关闭副作用=清空查询、打开副作用=加载初始结果。BC-1 只写「关闭」，漏了 query 清空副作用。 |
| 空结果禁用键盘导航 | `:158` | 🟢 低 | `total===0` 时 onKeydown 直接 return。 |
| 键盘循环包裹 | `:159-160` | 🟢 低 | ↑↓ modulo 首尾循环。BC-2「跨组扁平化」隐含但未点明。 |
| Clock 图标 recents 态显示 | `:72-75` | 🟢 低 | 空查询每项右侧 Clock，BC-5 漏此视觉标识。 |
| aria-selected/role/sr-only 可访问性 | `:15-18` `:44-46` | 🟢 低 | 无障碍属性，refactor 须保留。 |

### 变更项（BC-3/5/7）独立 ticket 评估
- **BC-3（emit→跳转编排）**：✅ 该独立。但与新建「跳转编排」模块（§7 row5）**强耦合**——JO 不建好 BC-3 无处可调。独立 ticket 需注明依赖前置（先建 JO 骨架，再切 BC-3），否则「独立」是伪独立。
- **BC-5（recents mock→localStorage）**：✅ 该独立。数据源切换，边界清晰。
- **BC-7（scrollIntoView→scrollIntoViewIfNeeded）**：⚠️ 条件独立。此项状态=搭便车 D-015「候选」，**依赖 ⑤骨架验证确认**。若搭便车不纳入，BC-7 应回退为「保持」。当前文档已标此依赖，但 §12 表头「变更项该独立 ticket」的口径未反映此条件性——建议在 BC-7 行显式标注「以 D-015 确认为前提」。

## Gap 汇总

| gap_id | 类型 | 描述 | 建议 |
|--------|------|------|------|
| GAP-E1 | 文档矛盾/职责边界 | 分组（按 type 分箱）归属在 §7（search domain 返回分组）与 §9 swimlane（ME 返回「分组结果」:269/:256）间矛盾；search domain 疑似揉入「查询编排 + 分组」二轴 | 明确分组归属单一模块（建议归 search domain 作输出整形），修正 §9 swimlane 让 ME 仅返回命中候选/segments，不返回分组 |
| GAP-E2 | 职责边界含糊 | 匹配引擎 §7 定为「匹配+segments」，但若兼做候选过滤（§9 SD→ME），需明确导出形态（matchFilter 与 segments 分离 or 合并） | AC-4 已列 `export function match\|segments`，确认两函数分离；在 §7 补一句 ME 不含分组/不调 api 的边界声明 |
| GAP-E3 | 行为契约遗漏（高） | 竞态保护 loadSeq（:123/:126-128）未登记，refactor 重写易丢正确性不变式 | 新增 BC-9「乱序响应保护」，源码位置 :123/:126-128，处理=保持 |
| GAP-E4 | 行为契约遗漏（中） | 鼠标交互（mouseenter 同步 selIdx :50 + click 确认 :51）未登记，BC-2/3 只覆盖键盘 | 新增 BC-10「鼠标 hover/click 与键盘共享 selIdx」，或扩展 BC-2/3 覆盖鼠标路径 |
| GAP-E5 | 行为契约遗漏（中） | 生命周期副作用未登记：查询变化重置 selIdx(:180)、关闭清空 query(:184)、打开触发 load(:183) | 新增 BC-11「查询/开关生命周期副作用」，逐条标源码位置 |
| GAP-E6 | 行为契约口径 | BC-7 变更项依赖搭便车 D-015「候选」确认，但 §12「变更项独立 ticket」口径未反映条件性；BC-3 与新建跳转编排模块强耦合，独立性存疑 | BC-7 行显式标注「以 D-015 ⑤确认为前提」；BC-3 ticket 注明前置依赖 JO 骨架 |
| GAP-E7 | 行为契约遗漏（低） | 边缘行为未登记：空结果禁用键盘(:158)、循环包裹(:159-160)、Clock 图标(:72-75)、a11y 属性(:15-18/:44-46) | 低优，建议合并入相关 BC 的「处理=保持」注脚，或新增 BC-12 统一登记边缘不变式 |
