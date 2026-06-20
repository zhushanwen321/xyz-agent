# Tracing Round 1

## 追踪范围

- **spec 初稿版本**：`spec.md`（verdict: pass, status: draft, 2026-06-20）。定义前端 v3 重建的范围/分层/路线/验收/决策，不重新设计 UI。
- **追踪的视角**：
  - P1 User Journey — **完整追踪**（重建引入大量 UI 交互）
  - P2 Data Lifecycle — **降级追踪**（见下方降级表）
  - P3 API Contract — **完整追踪**（api/ 门面 + mock 契约是 P5 核心）
  - P4 State Machine — **完整追踪**（composer/panel/sidebar/connection/navigation 多状态机）
  - P5 Failure Path — **降级追踪**（见下方降级表）

### 降级视角记录

| 视角 | 降级理由 | 依据 |
|------|---------|------|
| P2 Data Lifecycle | 本需求是**前端重建**，数据实体（Session/Message/PanelTree/Settings）的类型已定义在 `shared/`，**不创建/变更后端数据模型**。Data Lifecycle 在本需求退化为「mock 数据生命周期 + 前端状态持久化策略」，只追踪与重建直接相关的子问题（mock 数据存活性、navigation/composer 草稿持久化、panel ratio 记忆），不追踪后端 CRUD/外键/级联/分区。 | spec §1 明确「Runtime 已就绪，前端用 mock 优先开发」+ §2 Out-of-scope「前后端联调推迟」 |
| P5 Failure Path | mock 模式下**不发生真实网络失败**（mockConnect 直接 setTimeout 200ms 进 connected，无真实 WS）。故 WS 断连重连、runtime 重启、stream_error 真实路径**推迟到联调阶段**（design.md G5 已规划，不在本 spec 范围）。本视角只追踪：mock 异常、用户 abort、非法输入、状态机非法转换、并发操作、空态/加载态等**与 mock 驱动 UI 直接相关**的失败路径。 | spec §2 Out-of-scope「前后端联调推迟，全 mock 驱动」+ D2「短期方案，联调阶段切换真 api」 |

---

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | Data / API | D2 / P5 / phase-1-api-client.md task6 | spec D2 写「复用 `mock/mock-ws.ts` + `mock/data.ts`（725 行预制数据）」，但**当前 worktree 只有 `mock/mock-ws.ts`（53 行最小骨架，只模拟 ping→pong）**，`mock/data.ts` **不存在**（只在 main worktree 有）。P5「mock 重写」实际是从零写 725 行预制数据 + 重写消费方式，工作量被低估。spec 需澄清「复用」的含义是「从 main worktree 搬过来」还是「重写」。 |
| G-002 | F | API | P5 / phase-1-api-client.md task4 现状表 | phase-1-api-client.md 列了 ~10 个待迁移的 send 直调方（useChat/useSession/useModel/useProvider/useTree/useExtensionUI/useToolApproval + stores/plugin.ts + 4 组件），但**这些文件全部存在于 main worktree，refactor-architecture-design worktree 一个都没有**（composables 只有 useConnection，components 为 0 个 .vue）。P5 的「迁移灰度并存」描述不适用——这是纯新建，不是迁移。spec 应明确 P5 = 全新建 api/ + 全新建 domains 调用方，不存在「灰度替换」。 |
| G-003 | F | State Machine | P4 / panel/spec.md + draft-composer-states.html | spec §4 P4 写「composer(6态)」，但 draft-composer-states.html §3 实际定义 **9 态**（S1 空 / S2 聚焦 / S3 命令浮层 / S4 附件 / S5 发送中 / S6 停止 / S7 待发送 steer/followup / S8 双队列分组 / S9 发送失败回退）。验收基准对不上。 |
| G-004 | F | Data / State | P0 / design-tokens.md + style.css 注释 | design-tokens.md SSOT 用 `--bg`（不是 `--bg-base`），但 style.css 注释写「P0 替换为 `var(--bg-base)` 冷蓝暗色」+ shell/spec.md 用 `.bg-base`。spec §4 P0 + §6 验收都未澄清 token 命名以哪边为准。 |
| G-005 | F | State Machine | P2 sidebar / shared/session.ts vs sidebar 设计稿 | `shared/session.ts` 的 `SessionStatus` 只有 2 值（`'active' \| 'idle'`），但 sidebar/draft-five-states.html 会话项状态点定义 **5 态**（running / waiting 脉冲 / done / stopped / error）。spec D4 裁决了 Overview 术语但**未处理这个 status 枚举不一致**。前端要么扩展 shared 类型、要么从 message/tool 状态派生 5 态视觉。 |
| G-006 | F | User Journey / State | P2 / D1 + main worktree navigation.ts | main worktree `navigation.ts` 用 `MAX_ENTRIES = 50` 上限 + `entries[]+pointer` 截断分支。spec D1 说「复用 navigation.ts 模式 + 扩展 overview 第三 view」，但**未提容量上限、未提分支截断策略是否保留**。重建时是否照搬 50？ |
| G-007 | F | Data / API | P0 / CLAUDE.md #10 vs design-tokens.md | CLAUDE.md 前端规则 #10 明确「border-radius 默认 1px，特殊场景 2px，`rounded-sm`(1px) 为默认」。但 design-tokens.md SSOT 定义 `--radius-sm: 3px / --radius: 8px / --radius-lg: 12px`，draft HTML 全用 3/8/12。**两份权威文档冲突**。spec P0 装机时 tailwind.config 要用哪套？shadcn-vue 默认 radius 又是另一套。 |
| G-008 | F | Data | design-tokens.md vs draft-composer-states.html | draft-composer-states.html 用 `--success:#34d399` / `--warning:#fbbf24` / `--danger:#f87171` / `--info:#38bdf8`，design-tokens.md SSOT 用 `--success:#22c55e` / `--warning:#f5a524` / `--danger:#ef4444` / `--info:#38bdf8`。draft 间已不一致。spec P0 验收「token 正确」时以哪份 draft 为准？ |
| G-009 | F | API | R4 / preload.ts vs lib/ipc.ts | preload 实际暴露了 15+ 个 electronAPI 方法（runtime port 4 个 + 窗口管理 8 个 + pickDirectory + onShortcut + openExternal + openSettingsWindow 等），但 `lib/ipc.ts` 只封装了 **4 个** runtime-port 相关方法。R4「WS+IPC 统一门面」需要扩展 ipc bridge 覆盖窗口/对话框/快捷键。spec §3 R4 + 附录 A 只列了 `ipc.ts`，未提扩展。 |
| G-010 | F | State Machine | P1 / ws-client.ts | ws-client.ts 已实现 4 态连接状态机 + 15s 心跳 + 指数退避重连（1s×2 上限 30s）+ generation 计数 + HMR 复连 + VITE_MOCK 分支。spec §1 提「WS/IPC/mock 基础设施可复用」但未列不变量清单。重建时是否保留全部不变量？mock 模式下心跳/重连是否还要跑？ |
| G-011 | F | User Journey | P0 / main.ts | main.ts 已 wire `createPinia()` + `i18n` + `style.css`。renderer/src/i18n/ 已有 vue-i18n + zh-CN/en-US locales。spec 附录 A 列了 `i18n/` 目录但**未说重建期是否启用 i18n**、是否所有新组件必须走 `$t()`、还是可以先硬编码字符串后续补。 |
| G-012 | F | Failure | composables/__tests__/ | 当前 worktree 有 2 个**断链 symlink**（`useChat.test.ts` / `useSlashCommands.test.ts` 指向不存在的 `__tests__/` 目录）。spec 未提是否清理、测试框架选型（CLAUDE.md 指定 vitest，但 renderer 当前无 vitest 配置）。 |
| G-013 | K | User Journey | §7 UC + design | **关闭最后一个 panel / 删除当前激活 session** 的用户流程未定义。workspace/spec.md 明确「单 panel 关闭主会话需确认流（本稿不处理）」——重建是否处理？sidebar 删 session 时若该 session 正绑在 active panel，panel 何去何从？ |
| G-014 | K | User Journey / State | §7 UC + overview/spec.md | **首次启动空态（session 数=0）**未在任何 UC 追踪。sidebar 容器态 D（Empty）触发条件是「会话数=0」，但此时 workspace 显示什么？有 onboarding 引导吗？是自动创建第一个 session 还是显式「新建」空态？ |
| G-015 | K | Data / Failure | D2 + §6 验收 | **mock 数据生命周期**未定义。mock 创建的 session 在 reload / HMR / 重启应用后是否保留？`VITE_MOCK=true npm run dev` 每次启动是干净状态还是有持久化？影响 UC-2「完成一次对话」的可重复性。 |
| G-016 | K | Data / State | D1 + design draft-composer-states §6 | draft-composer-states §6「输入暂存 · 切换 session/panel 不丢失」是 composer 的设计契约。spec 未提是否实现草稿持久化（内存？localStorage？）。spec 已有 [AMBIGUOUS] 标记折叠态记忆策略，但 composer 草稿记忆是另一个独立问题。 |
| G-017 | K | Failure | D2 | **v1 mock 阶段是否需要处理 WS 断连/错误 UI**？mock 模式永不真断连，但 connection state 仍是 4 态。用户看到「连接中…」是否合理？是否需要一个 mock 模式的「永远 connected」短路？还是保留 connecting 200ms 动画作为真 runtime 的视觉对齐预演？ |
| G-018 | K | User Journey | §2 In-scope + flow-2 | **Tool 审批交互**（`tool.approve` / `tool.deny` / `tool.always_allow`）未在任何 UC 追踪。protocol 有完整类型，phase-1 task4 列了 useToolApproval 待迁移。但 spec UC-2 只说「消息流显示 user/assistant 块 + 流式光标」，未说工具调用块是否含审批按钮、审批后流转。 |
| G-019 | K | User Journey | §2 + design shell/spec.md | **Steer / Followup 提交态**（S7-S8）未在任何 UC 追踪。composer 设计把 steer/followup 当核心交互（design §4），spec UC-2 只说「composer 6 态正确」（实际 9 态）。steer/followup 在 mock 模式下如何模拟「AI 工作中排队引导」？mock 是否要支持 message.steer / message.follow_up？ |
| G-020 | K | User Journey / State | §2 + ADR-0022 + sidebar/spec.md | **Overview 进入/退出**未在 UC 完整追踪。UC-3 说「点 Overview 按钮 → 覆盖 main 区、sidebar 持久」，但**退出路径**（点卡片载入 session / Esc）未在 UC 写。⌘⇧O 快捷键冲突未实机验证（ADR-0022 已标遗留）。 |
| G-021 | K | User Journey | P6 + settings/spec.md | **Settings modal 触发入口**未定义。settings/spec.md 有三模式（modal 三模式），但 spec 未说触发入口是 ⌘,（标准 mac 习惯）、sidebar 用户头像点击、还是两者都要。 |
| G-022 | K | User Journey | P6 + overlays/spec.md | **⌘K Search Modal 搜索范围**未定义。design 说「跨项目范围 → overlays/draft-search-modal.html」（遗留 deferred）。但基础范围（当前 session / 所有 session / 文件 / 命令）未定。mock 模式下搜索数据源是什么？ |
| G-023 | K | Data / State | §2 In-scope + D1 + main worktree | **Panel split 时只有 1 个 session 怎么办**？panel-header split 按钮「开第二会话」——若 sidebar 只有 1 个 session，点击 split 是自动新建 session、弹选择器、还是禁用按钮？workspace/spec.md 说「开第二个 session 才 split」，隐含必须有第二 session。 |
| G-024 | K | State Machine | §2 + shell/spec.md | **Sidebar 收起态（C）与 workspace 顶栏按钮迁移**未追踪。sidebar/spec.md 说收起后「后退/前进/展开」迁移到 workspace 顶栏，但 v1 workspace 是否有这个顶栏？P3「双 Panel 主从」+ workspace/spec.md「每 panel 只有一个 header，无工作区级横跨 header」——两者冲突。收起态下导航按钮挂哪？ |
| G-025 | K | Failure / State | P4 + panel/spec.md | **用户 abort（S6 停止按钮）后的状态流转**未追踪。abort 后 message 标 `isInterrupted=true`（shared/message.ts 已有字段），但 UI 上：composer 回到哪一态？message-stream 中断的回合如何折叠？能否立即重发？ |
| G-026 | K | Failure | P5 + mock | **mock 异常/非法数据**的容错策略未定义。若 mock 实现返回了不符合 shared 类型的数据（如缺 sessionId），前端是崩溃、warn、还是静默？影响 mock 实现的契约严格度。 |
| G-027 | K | State | §2 + ADR-0021 | **ThemeMode='system' 与默认 dark 的关系**未追踪。ADR-0021 裁决默认 dark/cold-blue，但 shared/settings.ts 的 `ThemeMode = 'light' \| 'dark' \| 'system'`。'system' 模式下跟随 OS 主题，可能与默认 dark 冲突。v1 是否实现 'system' 模式？亮色未校准（spec §2 Out-of-scope），那 'system' 在亮色 OS 下显示什么？ |
| G-028 | D | Data / API | P5 + phase-1-api-client.md task6 | **mock api 返回数据形状**：phase-1 列了 mock 最小集（session/message/config/model/tree/extension/plugin/context 8 类方法），但返回值是**严格镜像 shared 类型**（如 `SessionSummary` 全字段）还是**简化 fixture**？影响 api typing 是 `Promise<SessionSummary>` 还是 `Promise<Partial<SessionSummary>>`。 |
| G-029 | D | State / API | P5 + mock | **mock 是否模拟失败路径**？为了 UI 失败态可验收（错误红框、连接重置提示、tool 失败），mock 是否需要故意 throw 或返回 error 事件？若 mock 永远成功，§6 验收「错误作为内联消息插入」无法在 mock 模式验证。 |
| G-030 | D | State | G-005 | **SessionStatus 5 态映射策略**：扩展 shared 类型加 4 个枚举值（影响 runtime 协议），还是前端从 message/tool 状态派生（`isStreaming`→running、`isWaitingTool`→waiting 脉冲、`lastMessage.status==='error'`→error）？前者动后端协议（spec 说联调推迟），后者纯前端。 |
| G-031 | D | Data | G-016 | **草稿/折叠态持久化介质**：内存（reload 丢）、localStorage（跨 reload 保留）、sessionStorage（tab 内）？spec [AMBIGUOUS] 已标折叠态，但未含 composer 草稿、panel ratio、sidebar tab 选择、目录展开态等多个独立持久化需求。design 一致说「持久化」但未说介质。 |
| G-032 | D | API | R4 + design.md D3 | **api/ 命令的 id 关联策略**：design.md D3 + phase-1 G4 说 `command()` 用 `crypto.randomUUID()` 发 id，runtime 回填 id 关联 Promise。但 **mock 模式下**，mock 实现是直接 resolve Promise（不经 id 关联），还是模拟 id 往返？影响 mock 实现复杂度。 |
| G-033 | D | State | §2 + shell/spec.md ⌘B 三态 | **⌘B 三态优先级是否在 v1 实现**？shell/spec.md 定义了复杂的「sidebar 展开→折叠 / 折叠+无脏数据→展开 / 折叠+有脏数据→分支 popover」三态，其中第 3 态依赖「未保存编辑 dirty flag」（composer 输入中 / subagent 流式未读 / 流式代码未审阅）。v1 mock 阶段是否实现 dirty flag 追踪？还是先实现前两态、第 3 态留 TODO？ |
| G-034 | D | User Journey | P6 + design | **i18n 策略**：重建期组件文本是 `$t('key')` 全量铺键 + 补 zh-CN/en-US locale 文件，还是先硬编码中文、后续统一抽 key？前者增加每个组件开销，后者产生技术债。spec 未表态。 |
| G-035 | D | API / Failure | R4 + ipc.ts | **ipc bridge 扩展范围**（G-009 衍生）：v1 是否需要补齐 preload 已暴露但 ipc.ts 未封装的全部方法（窗口管理 8 个 + 对话框 + 外链 + 设置窗）？还是只补 P1-P6 各 phase 实际用到的子集？影响 R4「统一门面」的完整度。 |

---

## 追踪覆盖度小结

- **F 类（事实）gap：12 个**（G-001 ~ G-012）。集中在两类：(a) spec 引用的 main worktree 既有实现**在当前 worktree 不存在**（G-001 mock/data.ts、G-002 待迁移 composables、G-009 ipc 桥接面、G-012 断链测试）；(b) **设计稿之间、设计稿与代码规范之间的数值/命名不一致**（G-003 composer 6/9 态、G-004 token 名、G-005 status 枚举、G-007 radius、G-008 颜色）。
- **K 类（业务知识）gap：15 个**（G-013 ~ G-027）。集中在「spec UC 只写了 3 条 happy path，未覆盖」的场景：空态/关闭/删除、tool 审批、steer/followup、Overview 退出、settings 触发、search 范围、theme system 模式、mock 失败模拟。
- **D 类（决策）gap：8 个**（G-028 ~ G-035）。集中在 mock 实现的契约严格度（返回形状、是否模拟失败、id 往返）、持久化介质、状态派生 vs 协议扩展、⌘B/i18n 落地范围。

---

## 总结

追踪了 **5 视角中的 3 个完整 + 2 个降级**（P2 Data Lifecycle、P5 Failure Path 因 mock 驱动 + 前端重建性质降级，理由见降级表）。共发现 **35 个 gap**：F 类 12、K 类 15、D 类 8。

**最严重的 F 类发现**是 G-001 与 G-002：spec 反复引用 main worktree 的既有实现（mock/data.ts 725 行、~10 个待迁移 composables、灰度并存策略），但**当前 worktree 是纯 greenfield**——这些文件一个都没有。这导致 P5 的工作量评估和执行策略（「灰度替换」「复用 mock/data.ts」）描述错位，需要在 plan 阶段前澄清是「搬迁 main worktree 文件」还是「从零重写」。

**最集中的 K 类盲区**是 §7 业务用例：3 条 UC 全是 happy path，未追踪中途放弃/失败/重复/空态/删除等典型 gap 模式。建议主 agent 优先补 UC 覆盖 tool 审批、steer/followup、Overview 完整往返、空态 onboarding、删除/关闭 session 五条路径。

**最需要早期决策的 D 类**是 G-028/G-029/G-032：mock 实现的契约严格度（镜像 shared 类型 vs 简化 fixture、是否模拟失败、id 往返）直接决定 P5 工作量和 mock 可验收范围，应在 plan 阶段第一个 task 就定下。
