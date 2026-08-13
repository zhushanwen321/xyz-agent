# 2. Renderer 详细设计（91.1k 行）

> 本文档是主文档（`README.md`）的子文档，覆盖 renderer 层候选 **C1-C7**。波次归属、DP 裁决、全局验收见主文档。所有路径/行号基于 2026-08-13 审查后二次核实（审查后代码有少量漂移，已按实际路径修正并在各候选标注）。审查报告纯文本提取版：`/tmp/arch-review-text.md` §2。

## §1 背景与目标

### 背景（SCQA）

**S**：renderer 是五包链中最厚的层（91.1k 行）。2026-08-13 审查确认：五包绞杀（ADR-0058）已深度推进——v6 文档记载的 B1-B9 欠债大多落地（chat.ts 906→31 行、routeInbound 已迁 core 查表式、Sidebar 467→270、features 已按 14 域分组）。

**C**：但"大多落地"意味着"没有全部落地"。当前摩擦集中在三类：

- **绞杀残留死壳**：旧 implementation 只剩 1 个消费方却不删（C1/C4），审查持续误报
- **seam 泄漏**：Feature 层绕过同域 composable 直连 lib/ipc（C2）；剪贴板/resize 跨组件重复实现（C3）
- **组织债**：composables/panel 25 项平铺（C6）、components/panel 四个 390-520 行巨模块（C7）

**Q**：这些残留每一条单独看都不大，但合起来是持续的架构税：死壳让审查误报、直连让 seam 形同虚设、平铺让 AI/人导航靠猜。怎么以最低风险把它们清完？

**A**：7 个候选按"删除 → 归位 → 下沉 → 组织"四类分入 W0/W2/W3/W4 波次——删除类和纯组织类零风险先做，收敛类/下沉类行为等价验证后做。死代码合计约 600 行（与 B1/B2 同口径），W0 一天清完。

### 目标

1. **绞杀收尾**：C1 删除 useSidebar 旧壳（565 行）、C4 删除 summarizeTurn dead code（W0，与 B1/B2 合计约 600 行零风险死代码清除）
2. **seam 归位**：C2 把 Feature 层 vue 直连 lib/ipc 的 3 处（8+1+1 符号）收编进域 composable；C3 把剪贴板 4 份、resize 订阅 5+ 处收敛为 useClipboard/useWindowResize 经 platform 端口注入（W2）
3. **绞杀续行**：C5 按 chat 域已验证路径把四 store 直连 api 通道下沉 core/domain（W3，subagent/workflow 分批后置）
4. **组织债**：C6 composables/panel 按 4 域分子目录、C7 components/panel 四个巨模块按 zone 拆分（W4）

### Out of Scope

- 不引入 UI 视觉改动（本分支 feat-optimize-ui 的视觉工作不受影响）
- 不新增第三方依赖
- C5 阶段 3（subagent/workflow 下沉）的虚拟 session 解耦设计不在本波次内完成，只定方向与分批

## §2 现状与问题分析

### 层判定（来自审查报告 §2 renderer）

五包绞杀（ADR-0058）已深度推进：v6 文档记载的 B1-B9 欠债大多落地（chat.ts 906→31 行、routeInbound 已迁 core 查表式、Sidebar 467→270、features 已按 14 域分组）。**当前摩擦 = 绞杀残留死壳 + seam 泄漏 + 组织债**。

包级层面 renderer 直连 core 96 文件、直连 shared 237 文件（DAG 形态属包级正常现象，见 01 号文档）。七层铁律（Feature 层经 seam 访问 T&C adapter）整体成立，但存在本节清单中的漏网点。

### 候选问题清单表

| 编号 | 级别 | 波次 | 问题类型 | 一句话 | 关键事实（已核实） |
|------|------|------|---------|--------|-------------------|
| C1 | Strong | W0 | 死壳删除 | useSidebar 绞杀残留死壳，仅 1 个消费方 | useSidebar.ts 565 行，消费方仅 `useChatViewDeps.ts:34,57`；useSidebarNew.ts 413 行真消费方 9 处（App.vue/useForkNoticeStream/composer-shell/useHandoffEffect/Sidebar.vue/Panel.vue/AppShell.vue/Workspace.vue/Overview.vue） |
| C2 | Strong | W2 | seam 归位 | Feature 层 vue 直连 lib/ipc 绕过同域 composable seam | BrowserPane.vue:178 直连 8 符号（browserCreate/Navigate/Hide/Show/Back/Forward/onBrowserState/openExternal）；SystemSoundSection.vue:112（listSystemSounds）；ExtensionPage.vue:41（chooseDirectory）。同域 useBrowserZoom/useBrowserRectSync 已走 seam |
| C3 | Strong | W2 | 重复收敛 | 剪贴板 4 份 + resize 订阅 5+ 份 | clipboard.writeText：useCopy.ts:21 / useCodeblockCopy.ts:37 / SystemPromptPage.vue:293 / BrowserPane.vue:364（1200ms 常量、await/then 风格不一）；resize：useMessageStreamRail.ts:163 / useBrowserRectSync.ts:118 / TerminalView.vue:174 / TokenDebugPage.vue:111 / useConstantHeightAssert.ts:65 等 |
| C4 | Strong | W0 | dead code | summarizeTurn 零调用方 + guiComponent 注释失真 | summarizeTurn.ts 11 行零调用方（唯一引用自身测试，TD7 迁 core 残骸）；guiComponent.ts **已不存在**（审查后已删），作已解决案例 |
| C5 | Worth | W3 | 绞杀续行 | 四未下沉 store 直连 api | 矛盾严格成立者 **2/4**：subagent.ts:19-20、workflow.ts:26 头注释「依赖方向：无」却直连 @/api；project.ts:21 直连但无声明（缺失非矛盾）；fileTree.ts 零直连（import shared + composables/logic/file-tree-utils） |
| C6 | Worth | W4 | 组织债 | composables/panel/ 25 项平铺 | composer-shell.ts 387 行与 useCopy 等小 module 平铺混放；features/ 已按 14 域分组（B9），panel/ 桶复发 |
| C7 | Worth | W4 | 组织债 | components/panel/ 巨模块群 | DetailPane 520（t244/s275）/ MessageStream 405（t150/s240/st16）/ Composer 407（t149/s257）/ BrowserPane 390（t143/s246）；深度在 script 段（3/4 无 style 段），非 template+style |

### 与主文档的一致性

- 波次：C1/C4→W0、C2/C3→W2、C5→W3、C6/C7→W4（与主文档 36 候选总览一致）
- W2 与 runtime D3/D4、electron E2/E3 同波次并行（不同层无文件冲突）；W3 与 B3（logic 下沉）同波次，C5 与 B3 有文件级依赖（见 §5）
- 审查报告的 ⚠️ 核查修正项（C1 消费方 9 非 20、C3 useCopy 注释口径、C4 guiComponent 现状、C5 矛盾 2/4、C7 深度在 script 段）均按修正后口径描述

## §3 解决方案

---

### C1 · useSidebar 绞杀残留死壳删除

**级别**：Strong · W0 · 删除/冲突归一

**问题**：同域两个 implementation 并存——useSidebar.ts（565 行，头注释自述「R2 features 层」）只剩 1 处 import，useSidebarNew.ts（413 行，自述「新壳 sidebar/session 接缝（w5 绞杀接缝）」）才是唯一真实现。旧壳是绞杀完成前的最后一口气。

**现状证据**（已核实）：

- 旧壳消费方精确唯一：`rg "features/sidebar/useSidebar'"` 仅命中 `composables/panel/useChatViewDeps.ts:34`（排除 New 后缀与测试）；消费 `forkSession`/`handoff` 2 个符号（:57）
- 新壳真消费方 9 处：App.vue / useForkNoticeStream / composer-shell / useHandoffEffect / Sidebar.vue / Panel.vue / AppShell.vue / Workspace.vue / Overview.vue
- ⚠️ 核查修正：原「20」仅在把注释提及 + 自身定义计入的错误口径下成立，真消费方 9 非 20
- 同目录 sidecar（useSidebarCounts / useSidebarSessionActions / useSidebarSubagentActions）已全部消费 New 侧，删除旧壳不触碰它们
- 旧壳测试文件与被测实现同目录（`__tests__/` 下），删除时须一并移除，否则测试引用已删符号导致 typecheck 失败

**影响分析**：

- 死壳不删，每次架构审查都会把「同域双实现」误报为活跃冲突（本候选原报告计数口径混乱即因此）
- 维护者无法区分权威实现，新增功能可能加到旧壳上
- 违反全局规则「冲突要表面化」——同域两实现必须归一，选一个（更新、更经过测试的），标记另一个待清理

**收益**：死代码消失（locality）、冲突归一（全局规则落地）、审查计数口径从此只有一个实现可数。与 B1/B2 合计约 600 行零风险删除，是主文档 W0 快赢清单的核心组成。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：换注入 + 删壳 | 长期 | useChatViewDeps 切换注入 useSidebarNew（适配 forkSession/handoff 导出签名），删 useSidebar.ts + 其测试 | 改动 1 处消费方，删除 565 行死代码；绞杀正式收尾，后续审查不再误报，维护者只有一条路可读。代价：需对照两壳导出签名差异 |
| B：保留现状 | 短期 | 旧壳留用 + TODO 注释标注待删 | 零改动零风险；但死壳持续腐烂、审查持续误报、未来维护者会把它当"活跃实现"读——问题原样保留，只是把「待删」写进了注释 |
| C：新壳继承旧名 | 长期 | 删旧壳，useSidebarNew 重命名为 useSidebar（9 处消费方 import 名不变，useChatViewDeps 零改动） | 改动面最小（0 处消费方改动）；但丢失「New 后缀」的绞杀命名历史，git blame 追溯被切断，为省 1 处 import 改动牺牲可追溯性，不划算 |

**方案评述**：

- A 是审查报告口径的直接落地（「useChatViewDeps 换注入 useSidebarNew，删旧壳 + 其测试」），1 处改动显式可审计，删除即收尾
- B 实质是"不做"，把死壳从"事实"降级为"注释"，审查下次仍会报同一问题
- C 的「重命名继承」看似省事，但 useSidebarNew 已在 9 处消费方 + 3 个 sidecar 中作为「新壳」被认知，改名会切断 git blame 与设计文档（w5 绞杀接缝）的对应关系；且 useChatViewDeps 的 1 处 import 改动成本极低，不值得为此牺牲历史
- 若未来出现第三个 sidebar 实现，本候选的收尾将「双实现」问题降为「单实现 + 单壳」，新实现直接替换 New 壳即可，不再有旧壳拖尾

**推荐**：方案 A。

**测试影响**：useSidebar 旧壳的测试随实现删除；useSidebarNew 若缺少 forkSession/handoff 的针对性测试，在 useChatViewDeps 切换注入后补 1 条冒烟用例（调用 forkSession/handoff 断言副作用发生）。其余 sidecar 测试不受影响。

**改动点**：

1. `composables/panel/useChatViewDeps.ts:34` import 改 `@/composables/features/sidebar/useSidebarNew`；`:57` 调用点适配导出签名（forkSession/handoff 是否同名同参，以 useSidebarNew 导出为准，实施时确认）
2. 删 `composables/features/sidebar/useSidebar.ts` + 其测试文件（同目录 `__tests__/` 下）
3. `rg "useSidebar"` 确认旧符号零引用——useSidebarCounts/useSidebarSessionActions/useSidebarSubagentActions 等 sidecar 已在 New 侧，不应被删除波及

**风险**：低。唯一适配点是两壳导出签名差异；sidecar 文件已全在 New 侧无需联动；删除为纯 git 操作可随时恢复。不涉及任何行为路径（消费方只换 import 来源，语义不变）。

**验收（真实场景）**：

1. 替换注入后启动 dev，侧栏创建/切换/折叠/删除 session 全流程无回归（fork/handoff 4 回调触发路径由 useChatViewDeps 提供，需确认 New 壳导出齐全）
2. 9 个 useSidebarNew 消费方 typecheck 通过（含 App.vue/Workspace.vue/Overview.vue 等页面级组件）
3. `rg "features/sidebar/useSidebar'"` 零命中（不含 New 后缀）；`git diff --stat` 显示约 565 行删除
4. 单测全绿作辅助（W0 删除类候选禁止以单测为唯一验收）
5. 与主文档 §4 全局验收联动：本波次完成后再跑一次完整对话冒烟（新建 session → 发消息 → 收回复 → 折叠/展开侧栏 → 切 session → 重开验证历史）

**下一层拆分**：无（单 commit 原子操作）。与 B1/B2 同波次 W0，一天内完成，完成后即提交。

---

### C2 · Feature 层 vue 直连 lib/ipc 归位到域 composable

**级别**：Strong · W2 · seam 归位

**问题**：BrowserPane.vue:178 的 import 区**同一处混两种范式**——useBrowserZoom / useBrowserRectSync 走域 composable seam，8 个控制函数（browserCreate/browserNavigate/browserHide/browserShow/browserBack/browserForward/onBrowserState/openExternal）却直连 `@/lib/ipc`。SystemSoundSection.vue:112（listSystemSounds）、ExtensionPage.vue:41（chooseDirectory）同理。违反七层铁律：Feature 层不应直接调 T&C adapter（renderer-target-architecture 七层依赖铁律：Feature 层经 seam 访问 Transport&Coordination，禁止绕 seam 直连）。

**现状证据**（已核实）：

- BrowserPane.vue:178 的 import 区中 `@/lib/ipc` 的 8 符号块与 `@/composables/features/browser/useBrowserZoom`、`useBrowserRectSync` 相邻并列——同一文件、同一 import 区、两种范式并存，是最直观的「seam 泄漏」样本
- browser 域已有走 seam 的先例（useBrowserZoom / useBrowserRectSync，同目录还有 useBrowserFocusSync），leverage 现成却不复用
- sound/directory 两处为单符号直连，泄漏面小但范式相同
- 与 C3 的 platform seam 不同：本候选是「域内归位」（browser 业务控制函数 → browser 域 composable），C3 是「跨端能力收敛」（clipboard/resize → platform port），两者不要合并成一个方案

**影响分析**：

- Feature 层直连 T&C adapter，主进程 IPC 签名变更时泄漏面是 N 个 vue 文件而非 1 个 seam
- 同一文件双范式，新增 browser 功能时新代码大概率照直连范式写（就近复制）
- 审查口径混乱——「components/ 下无 lib/ipc 直连」这类守护检查无从建立

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：收编进域 composable | 长期 | 新建 `features/browser/useBrowserControls.ts` 收编 8 符号（透传 IPC 签名，onBrowserState 订阅生命周期随组件挂载管理）；sound 归 `features/settings/` 域（listSystemSounds）；chooseDirectory 归 settings 域封装 | 与 features/ 14 域分组范式一致，复用现有 seam 结构；BrowserPane 的 import 区归一为全走 seam，审查口径从此清晰。代价：3 个新薄封装 + 订阅生命周期管理责任转移 |
| B：现状 + 豁免注释 | 短期 | 直连保留，头注释声明「已知豁免」 | 零改动；但同一 import 区双范式持续存在，审查持续报，未来新增直连无约束——豁免注释会变成"法外之地"的注册表 |
| C：lib/ipc 上加通用 wrapper | 长期 | 在 lib/ipc 之上包一层非按域的通用函数层 | 解决"绕过 seam"却制造新桶（wrapper 无域语义，与 features/ 14 域分组冲突），且与 C3 的 platform seam 方案职责重叠——比 A 差 |

**方案评述**：

- A 是既有范式的自然延伸——browser 域目录已有 3 个 composable，新增 useBrowserControls 是"补齐最后一块"，不是新机制
- B 的豁免注释与「无守护 → 回潮」病根同源（声明式豁免必被遗忘）
- C 的通用 wrapper 方向与按域收编相反：platform seam（C3，跨端能力）与域 composable（本候选，browser 域业务）职责不同，不要混淆——本候选走域 composable，C3 走 platform seam
- 收编后 browser 域 4 个 composable（zoom/rectSync/focusSync/controls）职责正交：zoom 管缩放、rectSync 管布局同步、focusSync 管焦点、controls 管控制命令——域内职责图完整

**推荐**：方案 A。

**测试影响**：本候选不新增单测——IPC 封装是薄透传，行为等价验证依赖真实场景（主进程 IPC 无法在 renderer 单测中模拟全链路）。若 browser 域已有 composable 测试先例（useBrowserZoom/useBrowserRectSync），useBrowserControls 的纯参数透传部分可补 1 条签名一致性测试。

**改动点**：

1. 新增 `composables/features/browser/useBrowserControls.ts`：8 符号薄封装，保持主进程 IPC 参数/返回签名不变（纯透传，不做形态转换——preload 的 canceled→null 形态适配不在本层，见 E7）
2. BrowserPane.vue:178 import 区替换；onBrowserState 的 on/off 订阅随组件 mount/unmount 成对管理（遵守「事件总线 listener 防重复注册」规则——BrowserPane 可能多实例）
3. SystemSoundSection.vue:112 → settings 域 composable（listSystemSounds，薄封装）
4. ExtensionPage.vue:41 → settings 域 chooseDirectory 封装（注意：SystemPromptPage.vue 的剪贴板直连是 C3 范围，本候选不碰）

**收益**：seam 归位（Feature 层不再直连 T&C adapter，七层铁律恢复）、leverage 复用（browser 域先例扩展，无新机制）。收编后「components/ 下无 lib/ipc 直连」成为可执行的守护检查条件。

**风险**：中低。IPC 封装是纯透传，行为等价；唯一小心点是 onBrowserState 订阅生命周期（避免泄漏/重复注册导致事件处理翻倍）。

**验收（真实场景）**：

1. 启动 dev → BrowserPane 完整操作（新建/导航/后退/前进/隐藏/显示/打开外部链接）与迁移前行为一致
2. 设置页声音预览播放正常；Extension 设置页目录选择 dialog 正常（含取消返回 null 形态）
3. Playwright（9222 端口）断言 BrowserPane 关键控件可点击且状态正确；`rg "@/lib/ipc" components/` 归零
4. 行为等价验证：迁移前后跑同一操作序列，断言输出一致
5. 与主文档 §4 全局验收联动：本波次（W2）完成后跑全量检查（`pnpm run lint` + renderer `npx vitest run`）确认零回归

**下一层拆分**：无独立子任务，3 处收编可各一个 commit（browser 控制函数 / sound / directory）。与 C3 同波次 W2——C3 的 useWindowResize 会触及同域 useBrowserRectSync，建议 C2 先行（域 composable 先例成型）或同批实施，避免对 useBrowserRectSync 的重复修改。

---

### C3 · 剪贴板 4 份 + resize 订阅 N 份收敛

**级别**：Strong · W2 · platform seam 收敛

**问题**：`navigator.clipboard.writeText` 在 4 处独立实现——useCopy.ts:21、useCodeblockCopy.ts:37、SystemPromptPage.vue:293、BrowserPane.vue:364，1200ms 提示常量与 await/then/catch 风格各自为政（useCopy 失败静默 catch 吞错，SystemPromptPage 用 await，BrowserPane 用 then）；window resize 订阅全仓 5+ 处——useMessageStreamRail.ts:163、useBrowserRectSync.ts:118、TerminalView.vue:174、TokenDebugPage.vue:111、useConstantHeightAssert.ts:65 等，节流/时序语义各写各的。

**现状证据**（已核实）：

- ⚠️ 核查修正：原「注释自认『刻意双份』」不实——useCopy 头注释自称「单一真相源」，useCodeblockCopy 给出「事件委托 vs ref-based」技术辩护；重复是事实但作者并未认账，该论据需改写
- ⚠️ 核查修正：全仓 resize 订阅不止 2 处（原口径偏窄），实测 5+ 处
- duplicate-code-audit.md 只覆盖 runtime（D1-D28）——这是 renderer 侧第一批实测重复证据，修完本候选 audit 才有 renderer 章节可写

**影响分析**：

- 4 份剪贴板实现各自演进，1200ms 常量将来改文案/时长要改 4 处，漏改即不一致
- resize 订阅的节流/清理语义分散，一处漏退订就是监听器泄漏（跨 session 切换时尤其隐蔽）
- 行为只能透过真实 window/DOM 验证——这正是 renderer 难测试模块的集中区，不收敛则永远无法单测
- 1200ms 提示常量四处各自定义：一处改时长其余三处不同步时，用户会看到「复制成功」提示时长不一致的漂移现象

**收益**：单点可测（port 注入）、四份归一（clipboard 语义单一真相源）、platform seam 唯一（与 core 的 port 模式对齐）。这是 renderer 侧第一批实测重复证据的收敛，duplicate-code-audit.md 从此有 renderer 章节可写。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：useClipboard + useWindowResize | 长期 | 抽共享 composable，经 platform 端口注入（对齐 core 的 port 模式——core 定义 port 接口 + renderer 薄壳注入 window/navigator 实现） | 单点可测——port 注入把 4+5 处调用点变成可单测的纯逻辑；1200ms 常量/节流语义归一为单一真相源（这次是真的）。代价：行为等价验证面广（resize 各消费点语义不同，rAF 合并可能改变帧时序） |
| B：保留现状 | 短期 | 4 份复制各自演进 | 零改动；重复持续、风格漂移加剧、下一轮审计继续报同一问题——现状是"5 份代码维护一份语义"的净亏损 |
| C：只抽 useClipboard | 长期 | clipboard 收敛，resize 维持现状 | 半收敛——clipboard 收益落地但 resize 5+ 处重复继续，且两者同为 platform seam 问题，拆两批反而重复评审与验收 |

**方案评述**：

- A 的 port 注入与 core 的 chat 域 ports 先例同构——core/domain 定义接口（`ClipboardPort { writeText }` / `ResizePort { subscribe }`），renderer 薄壳注入真实 window/navigator 实现；消费方只依赖接口，测试注入 mock
- 这是「renderer 难测试模块」的唯一解——把不可测的 window 依赖推到 seam 之后
- B 是"5 份代码维护一份语义"的纯亏损；C 的半收敛会留下"为什么 clipboard 有 seam 而 resize 没有"的疑问，审查口径仍然混乱
- 收敛完成后，后续新增复制/缩放类功能只有一条路：useClipboard / useWindowResize——新的「单一真相源」有 seam 兜底，不会再次回潮为多份
- 与 C2 的边界：clipboard 直连点在 BrowserPane（C3 范围）与 browser 控制函数（C2 范围）分属两个候选，实施时按候选边界分开提交，不要混在一个 commit

**推荐**：方案 A（clipboard + resize 同批）。命名口径注意：useCopy 曾自称「单一真相源」但实际不是——新 useClipboard 才是，旧注释随旧实现删除。

**测试影响**：useCopy/useCodeblockCopy 的既有测试随旧实现迁移到 useClipboard（mock ClipboardPort 注入）；useWindowResize 新增订阅/退订计数测试（vi.fn 断言 addEventListener/removeEventListener 成对调用）。这是「难测试模块」转可测的关键收益，也是收敛类候选唯一允许以单测为主的辅助验收。

**改动点**：

1. 新增 platform seam：`composables/platform/useClipboard.ts` + `useWindowResize.ts`（或 core/domain 定义 port 接口 + renderer 实现注入，与 chat 域 ports 先例同构——具体归位按 B3/DP-1 裁决后的逻辑层现状定）
2. 4 处 clipboard 调用点替换；1200ms 提示常量收敛为共享常量（文案/时长统一）
3. 5+ 处 resize 订阅点替换为统一订阅工厂（回调注册 + rAF 合并 + 自动清理，onUnmounted 统一退订）
4. 删除各点本地重复实现（useMessageStreamRail 的内联 addEventListener、useBrowserRectSync 的本地监听等）

**风险**：中。resize 各消费点的节流/时序语义需逐一比对（useMessageStreamRail 的右缘刷新、useBrowserRectSync 的 rect push、useConstantHeightAssert 的断言时序、TerminalView 的自适应），rAF 合并可能改变帧时序——必须真实场景行为等价验证，单测只是辅助。clipboard 侧风险低（writeText 语义单一）。

**验收（真实场景）**：

1. 启动 dev → 4 个复制场景（代码块复制按钮/消息复制/系统提示词页复制/浏览器 URL 复制）逐一粘贴验证内容正确、1200ms 反馈一致（迁移前后对比同一操作序列）
2. 窗口缩放 → message rail 右缘刷新、browser rect 推送、terminal 自适应、height 断言全部正常（各消费点逐一核对节流语义等价）
3. 单测：mock port 注入验证 useClipboard 错误路径（writeText reject 时 catch 行为）与 useWindowResize 订阅/退订计数（作辅助，主验收是真实场景行为等价）
4. 与主文档 §4 全局验收联动：W2 波次收尾时对迁移前后两份代码跑同一窗口缩放脚本，断言各消费点响应一致（收敛类候选的强制验收口径）

**下一层拆分**：调用点按域分 2-3 个 commit（clipboard 4 处一批 / resize 按消费域 2 批：panel 域一批、browser 域 + terminal + debug 页一批）。每批内先建 seam、后换消费点、再删旧实现，保持每批可独立验证。

---

### C4 · summarizeTurn dead code + guiComponent 注释失真

**级别**：Strong · W0 · 删除/内联

**问题**：`composables/logic/summarizeTurn.ts`（11 行）零调用方——唯一引用是自己的测试，是 TD7 迁 core 后的残骸（真实现已随 TD7 迁走，11 行是没带走的空壳）。guiComponent.ts 头注释声称「消除多处内联重复」，实测 1 个调用方、函数体只有一行 extractGui——注释与事实漂移。

**现状证据**（已核实）：

- `rg "summarizeTurn"`（排除测试）零命中，非测试代码无任何路径引用
- ⚠️ 现状修正：guiComponent.ts **文件已不存在**（2026-08-13 审查后已删除）——本节按「summarizeTurn 删 + 测试删」处理，guiComponent 作为「头注释与事实漂移」的已解决案例记录
- guiComponent 案例展示了这类漂移的标准结局（审查发现 → 删除），summarizeTurn 走同一路径；若实施时发现残留（其他分支/缓存），一行 extractGui 内联回唯一使用点 MessageStream.vue，恢复 locality

**影响分析**：

- dead code 不删，审查与代码导航持续看到"假活跃"符号
- TD7 迁 core 后残骸留在原地，未来维护者可能误以为 summarize 逻辑还在 renderer 层，去错误的位置找实现
- guiComponent 案例证明「注释声称消除重复」这类声明会随时间漂移成谎言——删除比注释可靠
- 若实施时 guiComponent 残留存在（其他分支/缓存），按报告建议处理：一行 extractGui 内联回唯一使用点 MessageStream.vue，恢复 locality

**收益**：复杂度消失、调用点内聚（审查报告原文「复杂度消失，调用点内聚」）。TD7 迁 core 后 renderer 侧 summarize 路径归零，导航不再出现「假活跃」符号；guiComponent 已删证明此类漂移的标准结局就是删除。C4 落地后，`composables/logic/` 目录只剩活跃纯函数，B3（logic 下沉 core）的盘点范围因此更干净。

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：删 + 测试删 | 长期 | 删 summarizeTurn.ts + 其测试文件 | 零风险死代码清除，复杂度消失；TD7 迁 core 后无任何路径需要它。审查报告明确将其列入「同一天可做完」的快赢清单 |
| B：保留待复用 | 短期 | 留壳 + TODO 注释标注「未来可能复用」 | 推测性保留，违反「不加推测性功能」原则——TD7 迁 core 时已把真实现带走，11 行残骸没有独立价值；「未来可能」是注释里最常见的谎言 |

**方案评述**：

- A 与 B1/C1 同为「删除即收尾」的快赢项，零风险
- B 的唯一论据是"万一未来要 summarize"，但 TD7 已经把 summarize 实现迁进 core——未来要用也是用 core 的，11 行 renderer 残骸没有任何独立价值；保留它只会让审查继续报 dead code
- 与 B1（renderer 的 core re-export shim 层）同属 W0 快赢：都是「绞杀迁移后的残骸清扫」，同一天内完成可共享一次 dev 冒烟验证

**推荐**：方案 A。guiComponent 已删无需对比；实施时若遇残留，extractGui 内联回 MessageStream.vue（1 行改动）。

**测试影响**：summarizeTurn 的测试文件随实现删除（零调用方，测试引用的是已死实现）。无新增测试需求——删除类候选的验证以 rg 零引用 + typecheck 为主，单测仅作辅助。

**改动点**：

1. 删 `composables/logic/summarizeTurn.ts` + 其测试文件（同目录 `__tests__/` 下）
2. `rg "summarizeTurn"` 确认零命中（含测试目录）
3. （残留情况下）guiComponent 的 extractGui 内联回 MessageStream.vue，删文件
4. 完成后 `ls composables/logic/` 核对目录清单，确认无其他 TD 迁 core 残骸（若发现同类死文件，一并记录，不扩大本候选范围）
5. 删除后跑一次 `pnpm run lint`，确认无未使用文件/悬空引用告警

**风险**：零（纯删除；guiComponent 残留处理为 1 行内联，风险极低）。不涉及任何行为路径，无回滚需求——万一误删（理论不可能，零调用方已核实），git 恢复即可。

**验收（真实场景）**：

**验收（真实场景）**：

1. 启动 dev 完成一次会话，消息折叠/展开交互正常（summarizeTurn 若被误删会在摘要路径暴露——实际零调用方故无影响路径，此验收是防误判）
2. typecheck 通过；`rg "summarizeTurn"` 零命中（含测试目录）
3. W0 删除类候选禁止以单测为唯一验收
4. 与主文档 §4 全局验收联动：本波次（W0）完成后跑主文档全局验收第 1 条（真实场景冒烟）与第 2 条（全量检查）确认无回归——C1/C4/B1/B2 同批验收，一次冒烟覆盖全部 W0 改动

**下一层拆分**：无。与 C1/B1/B2 同波次 W0。本候选无独立子任务，但实施顺序上排在 C1 之后（C1 删 useSidebar 壳涉及同波次 typecheck 面，先 C1 后 C4 可共享一次 dev 冒烟验证）。

---

### C5 · 四未下沉 store 直连 api 通道 → 下沉 core/domain

**级别**：Worth · W3 · 绞杀续行

**问题**（⚠️ 修正后口径，已核实）：矛盾严格成立者 **2/4**——subagent.ts:19-20、workflow.ts:26 头注释写「依赖方向：无（stores 间禁止互相 import）」却直连 `@/api`（interface 声明与 implementation 事实矛盾）；project.ts:21 直连 `@/api` 但完全无依赖方向声明（声明缺失，不是矛盾）；fileTree.ts 零直连（import shared + composables/logic/file-tree-utils，无「依赖方向」前缀声明）。对照：chat 域已完整下沉（chat.ts 31 行 factory + ADR-0059 薄壳）——同层新旧两种 implementation 并存，绞杀停在断点。

**影响分析**：

- 头注释谎报契约——「依赖方向：无」的真实语义是「stores 之间不互 import」，不是「不依赖外部层」，注释口径与实现脱节，阅读者被误导
- 四 store 与 chat 域 depth 不对称——chat 已沉到底（Foundation 归位），其余四个停在直连 T&C 层，同层两套范式，新 store 不知照哪个写
- 无守护时这种漂移是常态——本次审查就是靠人工核查才发现 2/4 矛盾，注释类声明不修就永远失真

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：按 chat 域路径下沉，分批 | 长期 | 按 chat 域已验证的绞杀路径下沉 core/domain（ports 注入替换 api 直连）。分两批：fileTree/project 轻量先行（project 只换 1 处 import；fileTree 本无直连，只需补声明），subagent/workflow 后置（耦合虚拟 session，renderer-target-architecture §12.1 已判定「高且深」，需独立设计先行） | Foundation 归位、依赖倒置消除，depth 与 chat 域对称；ADR-0058/0059 同向非冲突。代价：阶段 3 是大工程，需拆独立设计/评审循环，本波次只完成阶段 1-2 是务实边界 |
| B：先修头注释止血 | 短期 | subagent/workflow 的「依赖方向：无」改为如实声明「依赖 api（T&C 层）」，project 补声明，fileTree 补「无 api 依赖」 | 声明与事实对齐，成本极低（2-4 处注释），可作为 A 的前置 commit 立即落地；但结构不动，直连仍在 |
| C：维持现状 + 文档标记例外 | 长期 | 不沉，在 renderer-target-architecture 中把四 store 标记为已知例外 | 承认而非解决，与「绞杀续行」主叙事相悖；例外清单会持续膨胀，下一个新 store 会照直连范式写——不推荐 |

**方案评述**：

- A 复用 chat 域已验证路径（ADR-0059 薄壳 + ports 注入），不是新机制；分批是关键——fileTree/project 是"注释 + 1 处 import"级别的轻活，subagent/workflow 因虚拟 session 耦合被 §12.1 判定「高且深」，硬塞进本波次会失控
- B 是 A 阶段 1 的内容，可独立先行——2-4 处注释改动立即消除「声明与事实矛盾」，即使下沉推迟也不失守
- C 与「绞杀续行」主叙事相悖，且「标记例外」无守护必回潮

**推荐**：方案 A 分批（阶段 1 的注释止血随行，立即做）。

**改动点**：

1. 阶段 1（止血）：修正 subagent.ts/workflow.ts 头注释（如实声明 api 依赖），project.ts 补声明，fileTree.ts 补「零 api 直连」声明
2. 阶段 2（轻）：project store 的 projectApi 下沉 core/domain（ports 注入替换 `stores/project.ts:21` 直连；project 是四者中依赖面最小的，作为下沉样板）
3. 阶段 3（重）：subagent/workflow 下沉——虚拟 session 解耦设计先行（本候选只定方向与分批，不断言实施细节）

**风险**：阶段 1-2 低（注释 + 单点替换）；阶段 3 中高——subagent/workflow 与虚拟 session 的耦合是真正难点，必须独立设计 + 对抗审查后再动，禁止大爆炸式迁移（与 D8 同纪律：渐进切分）。

**验收（真实场景）**：

1. 阶段 2 后 project 设置页保存/加载功能冒烟正常（行为等价）
2. 阶段 3 后 subagent 面板（任务列表/新建/取消/状态刷新）、workflow 运行列表全流程冒烟正常
3. 全量 typecheck + vitest 全绿；`rg "from '@/api'" stores/` 归零（fileTree 本无直连，归零口径为 subagent/workflow/project 三文件）

**下一层拆分**：三阶段对应 3 个 commit；阶段 3 前置独立设计文档（可拆为子 wave，单独 design-review 循环）。

---

### C6 · composables/panel/ 25 项平铺 → 分子目录

**级别**：Worth · W4 · 组织债（纯组织重构）

**问题**：B9 已让 features/ 按 14 域分组，panel/ 桶原样复发——composer-shell.ts（387 行）与 useCopy 等小 module（<50 行）平铺混放（25 项，含 __tests__）。文件查找靠名字猜测，AI/人导航成本真实存在；且 C7 拆分巨组件时拆出的逻辑 composable 没有落位结构，必须先有目录骨架。

**现状证据**（已核实）：`composables/panel/` 下 24 个 module + __tests__ 平铺——composer-shell.ts（387 行）、useChatViewDeps、useMessageStreamRail/Scroll/Notices、useTurnElapsed/useTurnExpansion、useImageAttachment、useCopy/useCodeblockCopy 等。对比 features/ 的 14 域分组（browser/chat/command/drawer/file-tree/fork-handoff/model/new-task/search/settings/sidebar/terminal/url-bar/app），panel/ 是唯一没有按域组织的 composable 桶。

**影响分析**：

- 导航靠名字猜测——composer 相关逻辑散在 composer-shell/composer-injection-store/useChatViewDeps 等 5+ 文件中，无目录聚合
- C7 拆分巨组件时拆出的逻辑 composable 无落位结构，会继续往平铺桶里加
- AI 上下文窗口被无关文件浪费——读 panel/ 目录时 25 项全部进视野

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：按 4 域分子目录 | 长期 | composer/（composer-shell、composer-injection-store）、message-stream/（useMessageStreamRail/Scroll/Notices）、turn/（useTurnElapsed/useTurnExpansion）、attachment/（useImageAttachment），跨域共享件留 panel/ 根（useChatViewDeps/useCopy 按实际依赖归属，归属以 import 图为准） | 对齐 B9 范式（features/ 14 域分组），AI 可导航性真实改善；纯移动无逻辑改动，typecheck/vitest 全量兜底。代价：import 路径批量更新（含跨域消费方） |
| B：平铺 + README 索引 | 短期 | 目录不动，加分组索引文档 | 零成本；但导航仍靠名字猜测，索引文档会随代码漂移（文档债 §6 同病根——声明式索引无守护必回潮） |
| C：只拆大 module | 短期 | composer-shell 单独目录，小 module 留平铺 | 部分收益；两段式组织（有目录有平铺）增加认知负担，未来归位还要再动一次——半程状态比起点更糟 |

**方案评述**：

- A 是 B9 范式的直接延伸，纯目录移动（git mv）+ import 更新，无逻辑改动——是全文档风险最低的一类改动，typecheck/vitest 兜底遗漏路径
- B 的索引文档与文档债 §6 同病根（声明式索引无守护必回潮），不解决问题
- C 的半程状态（有目录有平铺）比起点更糟——认知上要同时记两套组织规则

**推荐**：方案 A。

**改动点**：目录移动（git mv）+ 全部 import 路径更新（含跨域消费方 useChatViewDeps/useChat 等）+ __tests__ 同步迁移。无逻辑改动。归属判定以 `rg` import 图为准，不凭文件名猜测（useCopy 若被 composer 和 message-stream 双侧引用则留根）。

**风险**：低。纯移动；风险集中在 import 路径遗漏——typecheck + vitest 兜底（遗漏路径必报模块不存在）。

**验收（真实场景）**：

1. typecheck + vitest 全绿
2. 启动 dev 完成一次完整对话（composer 输入/消息流渲染/turn 展开/附件上传全链路）
3. `rg` 确认无残留旧路径 import；子目录结构与 features/ 14 域分组范式一致（对照 B9 文档）

**下一层拆分**：按 4 个子目录各 1 个 commit（composer / message-stream / turn / attachment），每个 commit 内目录移动 + import 更新 + 测试迁移原子完成。

---

### C7 · components/panel/ 巨模块群按 zone 拆分

**级别**：Worth · W4 · 组织债（组织重构）

**问题**：components/panel/ 四个 390-520 行巨模块——DetailPane.vue 520（t244/s275）、MessageStream.vue 405（t150/s240/st16）、Composer.vue 407（t149/s257）、BrowserPane.vue 390（t143/s246）。

**现状证据**（已核实）：

- ⚠️ 核查修正：「深度藏在 template+style」不成立——3/4 无 style 段，**script 段才是大头**（DetailPane 275 行 script、Composer 257 行、MessageStream 240 行、BrowserPane 246 行）
- MessageStream 审查口径 408 行，实测 405（审查后漂移 3 行）
- B5 Sidebar 拆分已验证该模式可行：467→270 + 13 子 .vue + 5 composable——主文件瘦身 42%、职责按 zone 落位、组件可独立渲染（原「约 10」偏低，实为 13 子组件）

**影响分析**：

- 每次改动需通读全文件定位（script 275 行里找一处逻辑）
- script 段超 240 行的组件新增功能无处安放——只能继续往里加
- AI 上下文窗口被无关 zone 浪费（DetailPane 同时含 markdown/diff/tool-result/attachment 四类渲染，改一类要读全部）
- 与 components/ 其他组件（Sidebar 拆分后 <300 行）规模不对称，没有可参照的组织样板

**方案对比**：

| 方案 | 性质 | 内容 | 取舍 |
|------|------|------|------|
| A：按 zone 拆子模块 | 长期 | script 段逻辑提取 composable + 模板段按 zone 提取子组件双轨。DetailPane 优先（detail-renderers/ 已起步，markdown/diff/tool-result 各 zone 独立），MessageStream/BrowserPane 次之，Composer 最后（动前对照 ADR-0056/0057 staging 裁决） | B5 已验证模式；主文件 <300 行 + 子组件可独立渲染；每次改动风险面缩小。代价：组件间 props/emit 契约设计成本，视觉回归需逐组件对比验收 |
| B：保持现状 | 短期 | 巨模块继续膨胀 | 零成本；但 script 段已超 275 行的 DetailPane 每次改动都高风险，新增功能无处安放——组织债只会随功能增长变贵 |
| C：只提 script 段 | 长期 | 逻辑提取 composable，模板段不动 | 逻辑拆分先行，但模板仍 244 行（DetailPane），拆分收益打折；半程状态还会诱导"模板也拆"的二次迁移——两段式迁移的总成本高于一步到位 |

**方案评述**：

- A 是 B5 已验证模式的复用（Sidebar 拆分已证明「zone 子组件 + 逻辑 composable」双轨可行且视觉可回归），DetailPane 的 detail-renderers/ 已起步说明该方向已被代码库接受
- Composer 因 ADR-0056/0057 的 staging 语义必须最后动——拆分不得改变行为，只做组织
- C 的半程迁移（只拆 script）总成本高于一步到位：模板段的 zone 提取与 script 段的 composable 提取共享同一份 zone 划分心智，拆两次等于 zone 边界设计做两遍

**推荐**：方案 A（DetailPane 优先，Composer 最后——ADR-0056/0057 裁决后再动）。

**改动点**：

1. DetailPane：detail-renderers/ 子组件群（markdown/diff/tool-result/attachment 各 zone）+ 逻辑 composable（275 行 script 按 zone 拆）
2. MessageStream：滚动/钉住/通知/加载更多分区提子组件（240 行 script + 150 行 template 双轨）
3. BrowserPane：chrome/urlbar/content 分区（与 C2 的 useBrowserControls 衔接，先 C2 后本项）
4. Composer：对照 ADR-0056/0057 后决定 staging 边界（257 行 script 是四个中第二深）

**风险**：中。视觉回归是主要风险——B5 已验证模式可行，但每个组件需组件级视觉对比验收；Composer 的 staging 语义（ADR-0056/0057）是前置裁决项，动前必须对照确认，禁止顺手改行为。

**验收（真实场景）**：

1. 启动 dev → 四种 detail 类型（markdown/代码 diff/tool-result/附件）渲染拆分前后截图逐一对比一致
2. 消息流滚动/钉住/加载更多行为一致；composer 输入/提交/附件行为一致
3. 拆分后主文件 <300 行（B5 同口径），子组件可独立渲染（临时挂载调试）
4. 视觉验证按规则派 minimax-m3 视觉模型 subagent 对比截图

**下一层拆分**：4 个组件各一个 commit 链（DetailPane → MessageStream → BrowserPane → Composer），每个组件内部按 zone 再拆 2-3 个 commit；Composer 链的前置是 ADR-0056/0057 对照确认（W4 内先做裁决确认再动）。

---

## §4 验收

### 层内整体验收

按波次执行（与主文档 §4 全局验收联动）：

| 波次 | 候选 | 类型 | 验收核心 |
|------|------|------|---------|
| W0 | C1/C4 | 删除类 | `rg` 确认旧符号零引用（useSidebar / summarizeTurn），typecheck 通过，dev 启动侧栏全流程冒烟——删除类禁止以单测为唯一验收 |
| W2 | C2/C3 | 收敛类 | 行为等价验证——迁移前后跑同一真实场景（浏览器操作序列/复制 4 场景/窗口缩放），断言输出一致 |
| W3 | C5 | 下沉类 | 既有测试全绿 + 新增单测覆盖迁移后纯逻辑 + project/subagent/workflow 页面冒烟 + stores/ 直连归零 |
| W4 | C6/C7 | 组织类 | typecheck + vitest 全绿 + 对话全链路冒烟 + 组件级视觉对比（C7，minimax-m3 视觉模型核对截图） |

### 汇总表

| 候选 | 级别 | 波次 | 方案对比数 | 推荐方案 | 验收场景（真实） |
|------|------|------|-----------|---------|-----------------|
| C1 | Strong | W0 | 3 | A 换注入+删壳 | dev 启动侧栏创建/切换/删除全流程 + 9 消费方 typecheck + rg 零引用 |
| C2 | Strong | W2 | 3 | A 收编域 composable | BrowserPane 全操作序列 + 声音预览 + 目录选择 + Playwright 控件断言 + rg components/ 直连归零 |
| C3 | Strong | W2 | 3 | A useClipboard+useWindowResize | 4 复制场景逐一粘贴 + 窗口缩放 4 类响应 + mock port 单测辅助 |
| C4 | Strong | W0 | 2 | A 删+测试删 | dev 会话消息折叠/展开正常 + rg 零命中 |
| C5 | Worth | W3 | 3 | A 分批下沉 | project/subagent/workflow 页面冒烟 + stores/ 直连归零 |
| C6 | Worth | W4 | 3 | A 4 域分子目录 | 对话全链路 + typecheck/vitest + 无残留旧路径 |
| C7 | Worth | W4 | 3 | A zone 拆分 | 4 类 detail 渲染对比 + 流/钉住/加载 + composer 行为 + 主文件 <300 行 |

### 全局联动

- 每波次完成后跑主文档 §4 全局验收第 1-2 条（真实场景冒烟：`pnpm run dev` 完成一次完整对话 + 全量检查 `pnpm run lint`、renderer `npx vitest run`）
- W3 后跑打包链路验证（`bash scripts/validate-runtime-bundle.sh`——renderer 改动不直接影响 runtime bundle，但主文档要求 W3 后每波次至少一次）
- 守护类验收（W1 D1 的 pre-commit 拦截实测）由 03-runtime.md 负责，renderer 层引用其结论
- 本层所有候选完成后：主文档 README 的候选表标注实施状态

## §5 下一层拆分

### 实施顺序与依赖

```
W0（1 天）  C1 useSidebar 死壳删除 → C4 summarizeTurn 删除（同批，与 B1/B2 并行）
W2         C2 域 composable 收编 → C3 clipboard/resize 收敛
           （C2 先行：C3 的 useWindowResize 触及同域 useBrowserRectSync，避免重复修改）
W3         C5 阶段 1 注释止血 → 阶段 2 project 下沉 → 阶段 3 subagent/workflow（独立设计先行）
W4         C6 panel 分子目录 → C7 巨模块拆分
           （C6 先行：C7 拆出的逻辑 composable 直接落位新子目录）
```

### 跨候选/跨层依赖

- **C3 ← C2**：C3 会修改 useBrowserRectSync（browser 域），C2 先把 browser 域 composable 先例成型，二者同批实施（同波次 W2）
- **C7 BrowserPane ← C2**：BrowserPane 拆分与 C2 的 useBrowserControls 收编顺序衔接——先 C2（import 区归一）后 C7 拆分该组件，避免两处同时改同一个文件
- **C5 阶段 2 ← B3**：C5 的 fileTree 依赖 `composables/logic/file-tree-utils`，B3（logic 下沉 core）若先行，fileTree 的 import 路径会变——W3 内先 B3 后 C5 阶段 2，或 C5 直接引用下沉后新路径（执行时以 B3 实际落地为准）
- **C7 Composer ← ADR-0056/0057**：staging 裁决是前置项，动 Composer 前必须对照（W4 内先做裁决确认再拆）
- **C7 DetailPane ← C6**：C7 拆出的 detail 逻辑 composable 落位 C6 的新子目录（attachment/ 域含 useImageAttachment，与 DetailPane 的 attachment zone 呼应）
- **W2 跨层并行**：C2/C3 与 runtime D3/D4、electron E2/E3 同波次无文件冲突，可并行

### Commit 建议

| Commit | 内容 | 验证 |
|--------|------|------|
| W0-1 | C1 useSidebar 换注入 + 删壳 + 删测试 | typecheck + dev 冒烟 + rg 零引用 |
| W0-2 | C4 summarizeTurn 删 + 测试删 | typecheck + rg 零命中 |
| W2-1 | C2 browser 控制函数收编 useBrowserControls | BrowserPane 全操作冒烟 |
| W2-2 | C2 sound/directory 归域 | 声音预览 + 目录选择冒烟 |
| W2-3 | C3 useClipboard 收敛 4 处 | 4 复制场景验证 |
| W2-4 | C3 useWindowResize 收敛 5+ 处 | 窗口缩放各响应验证 |
| W3-1 | C5 阶段 1 注释止血 | typecheck |
| W3-2 | C5 阶段 2 project 下沉 | project 页冒烟 + 单测 |
| W3-3+ | C5 阶段 3 subagent/workflow（前置设计文档） | 独立设计评审 + 双面板冒烟 |
| W4-1..4 | C6 四子目录各一 commit | typecheck + vitest |
| W4-5..8 | C7 四组件各一 commit 链（Composer 最后） | 视觉对比 + 冒烟 |

### 收尾

全部完成后：本目录文档标注实施状态；migration-progress 等文档债随 W1 收口（见 06-doc-debt.md）；renderer 侧若出现新的「直连/重复/死壳」证据，补入 duplicate-code-audit.md 的 renderer 章节（C3 落地后 audit 扩展为双层覆盖）。
