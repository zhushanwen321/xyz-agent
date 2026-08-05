# 架构修复设计 — 总览（校准版 v2）

> **校准依据**：8 份审查报告（`/tmp/audit-arch-0[1-8]-*.md`）+ feat-remote-use 实证（94 commit mobile-renderer）+ 代码实测复核
> **原则**：只做长期的、架构合理的决策，不做短期临时决策
> **决策状态**：全部已定（无需用户再决策）
> **导航**：本文档是入口；逐项执行细节在 `01-08-*.md` 子文档；ADR 草案在 `adr/`

---

## 校准修正（3 个误判，已固化）

| 原判断 | 实测 | 修正 |
|---|---|---|
| sandbox 是 P0 security-critical 紧急 | `EXTERNAL_PLUGIN_ENABLED=false` 硬锁（commit `2b9066ad9`，2026-08-03，比审计早 1 天），external 装不进来，只有 builtin/trusted 能跑 | 降为长期完整性，非紧急 |
| useChat 是 P1「最危险」反模式 | ADR-0049 已走「全局 sid 协调器例外类」登记，useChat 显式接收 sid（非 sidRef 实例绑定），工厂契约错位 | **剔除**（合理架构决策，不是 bug） |
| 审计 163 项是待修清单 | 多项已 RESOLVED（useConnection 迁 core / slashIcons / import.meta / lib 4 文件 / sidebar #3-#5 / B5 Sidebar 拆分 / §9.1 文档漂移 / §14.3 双层 modal） | 逐项复核，不盲信判定 |

---

## 一、架构决策（1 项，已定）

### 决策 1：新建 @xyz-agent/dom-core（A2）

**问题**：`core/domain/composer/input/` 4 文件（2148 行）含 47 处直接 DOM 访问（Selection/Range/TreeWalker/execCommand），与 core 三处注释自称「零 DOM」矛盾；core devDep 引入 jsdom 支撑测试。

**根因**：B4 拆分把 DOM-bound 的 contenteditable 编排误当 headless 逻辑归位（只验行数 + import 收敛，没验 headless 边界）。

**决策**：新建 `@xyz-agent/dom-core` 承载「需要 DOM API、无 electron、跨 DOM renderer 复用」的前端逻辑。core 恢复真 headless。

**主论据：契约纯净**（独立成立）——core 契约是「可在 node/worker 跑、纯单测、无 jsdom」，含 DOM + jsdom 自相矛盾，必须修。**复用预留是支撑论据**（三端复用是 feat-remote-use 愿景，mainline mobile-renderer 只是 4 个 Stub 骨架零 composer 消费；A2 不依赖复用实证成立）。

**为何 A2 而非 A1（回迁 renderer）/ B（降级前端 headless）**：
- A1 辏牲复用预留（未来真多 renderer 时重蹈「整目录复制」覆辙）
- B 稀释 core 契约（含 DOM 污染 node/worker 可跑能力）
- 成本佐证：core/dom-core 都是 source-only 包（无构建步骤），新包成本极低

**分层**：`shared ← core（真 headless）← dom-core（DOM-bound 前端逻辑）← ui（Vue 壳）← renderer/mobile-renderer（装配）`

**迁移附带**：chip-commands.ts 的 `createVNode/render`（Vue 组件渲染进 DOM host）收敛为注入 callback，保证 dom-core 边界纯净（DOM API only，无 Vue 渲染）。

**详见**：`01-dom-core-package.md` + `adr/0058-dom-core-package.md`

---

## 二、架构重构（3 项，都做）

### 重构 2：ExtensionHost 接线闭环

**现状**：core 基建 + ui 组件全交付；commit `c75898270` 后 StatusBar 链路打通；ViewHost/CompanionBand 数据进 store 但 UI 未挂载，uiRequest renderer 仍走旧通道。

**工作**：ViewHost 按 MountPointRegistry 挂载 4 点（sidebar.tab/panel.header.action/composer.toolbar，statusbar 已通）+ CompanionBand 全局 overlay + useExtensionUI 切 `ui-request` bus。

**解锁**：sidebar 第 5 plugin tab。

**详见**：`02-extension-host-wiring.md`

### 重构 3：sandbox 真隔离（非紧急）

**现状**：Worker Thread + CJS require 拦截 + **external 硬锁兜底**（fail-closed，完备）；ESM import 漏洞理论存在但被硬锁覆盖（只有 builtin/trusted 插件能跑）。

**目标**：`child_process.fork()` 子进程隔离（D-2 已裁定方向，VSCode ExtHost 模式），消除 ESM 绕过，翻转 `EXTERNAL_PLUGIN_ENABLED`。

**性质**：长期架构完整性，非 P0 紧急。

**详见**：`02-extension-host-wiring.md`（与重构 2 同文档，ExtensionHost 主题）

### 重构 4：chat store 深模块化（B6 *Impl 消除）

**现状**：`core/domain/chat/store.ts` 935 行，6 个 *Impl（注释自我记录「为绕 max-lines-per-function 拆」）。

**目标**：3 个流式相关（applySubagentStreamDeltaImpl/finalizeSubagentStreamImpl/finalizeMessagesImpl）内聚为 `streaming-state-machine.ts` 深模块；3 个小函数（<15 行）内联回 store action。

**独立性**：与 useChat 正交（useChat 已接受 ADR 例外，不重做）。

**详见**：`03-chat-store-paradigm.md`

---

## 三、执行型收尾（全部无需用户决策，方向明确）

### 结构/范式卫生
- **收尾 5**：Settings 分层 + 大文件拆分。§14.1 按域建子目录 → §14.2 拆 SystemPage(594)/ExtensionPage(530)/PiPresetsPage(443)。顺序铁律：先分层后拆分。详见 `04-settings-structure.md`
- **收尾 6**：envelope 下沉（§10.1）。route-inbound.ts:257-280 的 ~24 行 envelope 展开搬到 pending 层，有测试覆盖，独立低风险。详见 `03-chat-store-paradigm.md`
- **收尾 7**：归位卫生批量。normalizeSubagentStatus 下沉 runtime（单消费者驱动）/ findNodeByPath 落点 composables/logic → lib（让审计验收 grep 通过）/ file-basename+utils re-export shim（对齐 slashIcons）/ composables/features 按域分组 / useCompletionNotify+Sound 移 effects/。详见 `06-relocation-hygiene.md`

### 视觉对齐（demo 有明确真值）
- **收尾 8**：sidebar #6 #7。SegmentedTab 删 count span（5 行）+ badge 加 pulse class（1 行，keyframes 已存在 style.css:375）。详见 `05-sidebar-visual.md`
- **收尾 9**：§13.2 ⌘[⌘]⌘, 归位 useGlobalShortcuts。AppShell.vue:72-90 的 3 键并入 keymap 数组。洁癖级，功能正确。详见 `05-sidebar-visual.md`

---

## 四、剔除（非问题 / 已 RESOLVED / 合理现状）

| 项 | 剔除理由 |
|---|---|
| useChat 工厂化（§11.1） | ADR-0049 例外登记是合理架构决策，useSessionScopedState 的 sidRef+reactive 契约与全局协调器显式 sid 语义错位 |
| sandbox「P0 紧急」 | external 硬锁兜底完备，现实风险已消除 |
| bg-accent 双义（§14.4） | 消费侧 75 处已单义化（零 danger 误用），根源清除依赖 ui 原语清洗，降优先级合并处理，不单列 |
| 审计 RESOLVED 项 | §10.2 useConnection 迁 core / §15.6 三项二次发现 / sidebar #3-#5 / B5 Sidebar 拆分 / §9.1 文档漂移 / §14.3 双层 modal —— 均已被修复 commit 消化 |
| #3 chrome 对齐 | 误判（DOM 实测中线对齐），不单列 |
| §12.4 rows 原语 | 按需，设计标候选，当前 6 布局原语 + custom 逃生口覆盖多数场景 |

---

## 五、推进顺序（按依赖 + 架构完整性）

```
收尾 8（sidebar #6/#7，6 行零风险）← 不依赖任何决策，可立刻单独做掉

决策 1（dom-core A2）← 先做，确立 core 真 headless 边界，是其他归位判定的一致基准
    │
    ├─ 重构 2（ExtensionHost 接线）+ 重构 4（chat store 深模块化）【可并行】
    ├─ 重构 3（sandbox 真隔离）【独立，非紧急】
    └─ 收尾 5/6/7/9（Settings/envelope/归位卫生/快捷键）【可批量，收尾 5 依赖自身分层先行】
```

---

## 六、4 个跨主题架构优化（随对应主题落地）

| 优化 | 随 | 内容 |
|---|---|---|
| 端口注入标准化 | 决策 1 后 | 现有 3 套端口（PlatformPort/DevMode/ConnectionPorts）命名/读取策略/测试隔离不一致，统一约定。详见 `07-cross-cutting-optimizations.md` |
| re-export shim 模式推广 | 收尾 7 | slashIcons 已验证，file-basename/utils 归位时顺势落地。详见 `07-cross-cutting-optimizations.md` |
| 深模块化重构范式 | 重构 4 | B4 已验证三段式（逻辑归位+壳装配+facade 消费），B6/ViewHost/Settings 遵循。详见 `07-cross-cutting-optimizations.md` |
| 窄口径自动化范式守护 | 可选 | ADR-0049 checklist 是文档门禁，可补窄口径 ESLint（三重条件收紧避误报）。投入产出比待评估。详见 `07-cross-cutting-optimizations.md` |

---

## 七、文档索引

| 文档 | 内容 |
|---|---|
| `00-overview.md`（本文档） | 总览 + 校准修正 + 推进顺序 |
| `01-dom-core-package.md` | 决策 1：dom-core 分层 + 迁移清单 + 包配置 + ADR 链接 |
| `02-extension-host-wiring.md` | 重构 2+3：ViewHost 挂载 + CompanionBand + sandbox 子进程 |
| `03-chat-store-paradigm.md` | 重构 4 + 收尾 6：*Impl 深模块化 + envelope 下沉 |
| `04-settings-structure.md` | 收尾 5：分层 + 大文件拆分清单 |
| `05-sidebar-visual.md` | 收尾 8+9：sidebar #6/#7 + ⌘[⌘]⌘, |
| `06-relocation-hygiene.md` | 收尾 7：归位卫生批量清单 |
| `07-cross-cutting-optimizations.md` | 4 个跨主题架构优化 |
| `adr/0058-dom-core-package.md` | ADR-0058 草案 |

**证据库**（只读参考，不修改）：
- `/tmp/audit-arch-0[1-8]-*.md` — 8 份审查详细报告
- `/tmp/architecture-audit-summary.md` — 审查汇总
- `/tmp/long-term-architecture-decisions.md` — 校准清单
- `/tmp/v6-refactor-inconsistency-audit.md` — 原始审计（2026-08-04，多项已过时）
- `/tmp/sidebar-v6-diff-audit.md` — sidebar 差异审计
