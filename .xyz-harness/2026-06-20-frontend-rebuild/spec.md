---
verdict: pass
title: 前端 v3 重建（基于已完成设计稿）
date: 2026-06-20
status: draft
---

# 前端 v3 重建

> 本 spec 不重新设计 UI——设计稿（`docs/designs/v3-demo/`，22 个 draft 叶子）与架构（`docs/architecture/design.md` R1-R5）已完成。本 spec 定义**如何照着设计稿重建 renderer**：范围、分层、路线、验收基准、关键决策。

## 1. 背景与现状

| 维度 | 状态 |
|------|------|
| 设计稿 | ✅ 完成。L0-L4 递归骨架（shell/sidebar/workspace/panel/overview/settings/overlays/flow-2/flow-3），5 个 ADR（0018-0022）已归位 |
| 架构文档 | ✅ 完成。`design.md` 全局架构 + Renderer R1-R5 细化 + `phase-1-api-client.md` 任务分解 |
| Runtime（T1-T4） | ✅ 已落地（infra/transport/services/plugins 齐全），可独立对接 |
| **Renderer 现状** | ❌ **纯 greenfield**。仅连接骨架：`App.vue`（占位）+ `composables/useConnection.ts` + `lib/ws-client.ts`（4 态连接机+15s 心跳+指数退避重连+HMR 复连+VITE_MOCK 分支）+ `lib/ipc.ts`（仅封装 4 个 runtime-port 方法）+ `mock/mock-ws.ts`（**53 行最小骨架，只模拟 ping→pong，无预制数据**）。无 components（0 个 .vue）/stores/views，shadcn-vue 未装，token 已清空待填。`composables/` 下有 2 个**断链 symlink**（指向不存在的 `__tests__/`，P0 清理）。i18n 已 wire（main.ts `app.use(i18n)` + `i18n/locales/`） |
| 旧前端参考 | `main` worktree 有完整旧实现（10 域 86 .vue + 11 store + `mock/data.ts` 725 行预制数据），作**参考**（可借鉴数据结构，不直接搬迁——本 worktree 是从零重建，不存在「灰度迁移」） |

**结论**：这不是改造，是从零重建。WS/IPC/mock 基础设施可复用，UI 全新建。

## 2. 范围

### In-scope
- Renderer 五层落地（R1-R5，见 §3）
- 视觉 token 对齐 ADR-0018（冷蓝暗色 `#4f8ef7`/`#0d0d0f`/Inter）
- shadcn-vue 组件库装机（plan 阶段）
- 按 v3-demo L0→L2 逐层重建（shell → sidebar → workspace → panel → overlays/overview/settings）
- API Client 层（R4）按 `phase-1-api-client.md` 落地，**mock 优先**
- 导航历史栈（navigation store，扩展支持 overview 第三 view）

### Out-of-scope（v1 不做，推迟）
- Flow-3 SubAgent 多 agent 编排完整呈现（护城河，Phase 6 单独做）
- 前后端联调（runtime 就绪但联调推迟，全 mock 驱动）
- 亮色主题打磨（ADR-0021：暗色为真默认，亮色备选，视觉未校准）
- vue-router（CLAUDE.md 裁决不用，状态驱动）
- **大量 design 交互**（tool 审批/steer·followup/关闭删除确认/⌘B 三态第 3 态等）→ 完整清单见 §9 DEFERRED，确保不丢失

## 3. 架构约束（design.md §4.1 R1-R5，强制）

Renderer 五层 + 三条依赖铁律：

```
R1 components/   展示层（按 v3-demo 设计单元分域 + ui/ shadcn 原子）
R2 composables/  features(业务编排) / effects(副作用) / logic(纯逻辑)
R3 stores/       Pinia setup store，互不 import
R4 api/          统一门面（WS+IPC），mock 注入点，session 路由第 2 层
R5 lib/          传输层纯管道（ws-client/event-bus/ipc）+ 纯函数
```

**三条铁律**：
1. `composables/features/` 是**唯一**允许同时 import `api/` 和 `stores/` 的层
2. `stores/` 之间**禁止互相 import**（跨 store 协调由 features 做）
3. `lib/` 传输层**无业务语义**（业务在 features 订阅）

**展示 vs 容器**（R1）：`components/ui/` + 各域 `Base*` = 展示组件（只 props+emit）；各域根组件 = 容器组件（注入 store+composable）。

完整目录结构见 §7 附录。

## 4. 重建路线（P0-P6）

每 phase 结束**必须可运行 + 可视觉验收**，验收基准 = 对应 draft HTML。

| Phase | 内容 | 验收基准（draft） | 依赖文档 |
|-------|------|------------------|---------|
| **P0 基础对齐** | design-tokens 落 style.css + tailwind.config；shadcn-vue 装机；Inter 字体；CSS 变量体系；**删除断链 symlink**；**token 命名/色值归一**（见下注） | 启动=冷蓝暗色画布，token 正确 | `design-tokens.md` + ADR-0018 修复清单 |

> **P0 token 归一约定**（处理 G-004/G-007/G-008）：
> - **命名 SSOT** = `docs/designs/design-tokens.md`。画布底层变量名为 `--bg`（非 `--bg-base`，shell/spec.md 的 `--bg-base` 是笔误，待修正）
> - **色值 SSOT** = `design-tokens.md`（`--success:#22c55e`/`--warning:#f5a524`/`--danger:#ef4444`/`--info:#38bdf8`）。draft HTML 间的色值差异（如 composer draft 的 `#34d399`/`#fbbf24`/`#f87171`）是 draft 自带旧值，**不作为验收基准**，以 SSOT 为准
> - **radius 冲突**（G-007）：CLAUDE.md #10（1px/2px）vs design-tokens（3/8/12px）两份权威冲突，待用户裁决（见 §5 D5）
| **P1 L0 Shell** | App.vue 真 shell：aside-region(透明) + main-panel(float) + traffic light 安全区 + app-nav-controls + 全屏两态 | `shell/draft-overlay-states.html` | `shell/spec.md` |
| **P2 L1 Sidebar** | 容器四态 + segmented tab + 会话项 + 文件视图 + 折叠态 + Overview 入口按钮 | `sidebar/draft-five-states.html` 等 3 draft | `sidebar/spec.md` |
| **P3 L1 Workspace + L2 Panel 骨架** | 双 Panel 主从状态机 + Panel 5 zone 空壳（各 throw 占位） | `workspace/draft-dual-panel.html` | `workspace/spec.md` + `panel/spec.md` |
| **P4 L2 Panel 深化** | message-stream(7块+回合折叠) → composer(**9 态 S1-S9**) → companion-zones → detail-pane | `panel/` 4 draft + `flow-2/draft-cases.html` | `panel/spec.md` + flow-2 |
| **P5 API Client + mock** | api/ 五层落地 + domains + **mock fixture 从零编写**（**与 P1-P4 并行或先行**） | `VITE_MOCK=true npm run dev` 主流程跑通 | `phase-1-api-client.md` |

> **P5 性质澄清**（处理 G-001/G-002）：本 worktree 是**纯新建**，不存在「灰度迁移」。api/ 五层、domains、mock fixture、调用方 composables 全部从零写。main worktree 的 `mock/data.ts` 与旧 composables 仅作数据结构/模式**参考**，不搬迁文件。

| **P6 L1 Overlay/Overview/Settings** | ⌘K 搜索浮层 / 概览卡片网格 / settings modal 三模式 | `overlays/` `overview/` `settings/` 各 draft | 对应 spec + ADR-0020/0022 |

**P5 特殊性**：API Client 是数据基础，P1 即需要（store 要调 api）。实际执行：**P0 完成后立即起 P5 骨架**（api/transport + pending + events + mock 最小集），与 P1-P4 并行深化。

## 5. 关键决策记录

### D1. 路由方案：状态驱动 + 自管历史栈（长期方案）
- 不用 vue-router（CLAUDE.md 裁决 + Electron 无 URL 需求）
- 复用 `main` worktree `navigation.ts` 模式：`entries[]+pointer` + back/forward + 分支截断（splice pointer+1）+ `MAX_ENTRIES=50` 上限（超限丢最早）
- 扩展：加 `'overview'` 第三 view（chat/overview/settings）
- 栈条目 = `{view, sessionId|activeTab}`，未来可扩展 panel-scoped 导航
- **与 Flow 4 分支回退解耦**：分支回退走 Session Tree + 分支 pill，不走 chrome ←/→

### D2. 前端 mock 优先（短期方案，联调推迟）
- `VITE_MOCK=true` 驱动，mock 实现同一 `api` 接口（返回预制 Promise / emit 预制事件）
- `mock/mock-ws.ts`（53 行最小骨架）保留，**mock fixture 数据从零编写**（参考 main worktree `mock/data.ts` 的数据结构，但本 worktree 不存在该文件，需新建）
- runtime 已就绪但联调推迟，后端按需单独开发对接
- **性质**：短期方案。联调阶段切换到真 api 即可，mock 实现保留作开发/测试用
- **连接态策略**：mock 模式下 ws-client 的 4 态机 + 心跳 + 重连不变量全部保留（真 runtime 视觉对齐预演），但 mockConnect 直接 200ms 进 connected（不走真实心跳/重连循环）

### D3. shadcn-vue 装机时机：plan 阶段第一个 task
- 增量 `npx shadcn-vue add`（用到哪个装哪个），不一次装全 registry
- 装 `components.json` + `@/components/ui/` 基础结构
- 与 P0 token 对齐同步（shadcn 主题变量映射到 design-tokens）

### D4. 术语裁决（v3-demo 优先）
- **Overview 保留**并升级独立 L1 Region（ADR-0022），terminology R5 过时
- **Side Drawer** 取代 SideInspector（terminology R4 过时）
- **Panel Grid 废弃**（窗口内最多双 Panel，鸟瞰收敛到 Overview）
- 规范术语源：`docs/designs/v3-demo/architecture-and-terminology.html §1`

## 6. 验收标准

### 整体验收
- [ ] `npm run dev` 启动，冷蓝暗色画布（ADR-0018/0021）
- [ ] `VITE_MOCK=true npm run dev` 主流程跑通（session create/send/stream/switch/fork）
- [ ] `rg "from.*ws-client" renderer/src/` 仅剩 useConnection + api/transport.ts
- [ ] stores 间无互相 import（`rg "from.*stores/" renderer/src/stores/` 为空）
- [ ] `npm run lint` + `vue-tsc --noEmit` 通过

### 每 phase 验收
逐 draft HTML 像素级对照（P1-P6），每 phase 产出一个可运行增量。

## 7. 业务用例

### UC-1: 用户启动应用看到 v3 Shell
- **Actor**: 开发者用户
- **场景**: 冷启动应用
- **预期结果**: 冷蓝暗色画布 + 透明 sidebar（含 traffic light 安全区）+ 浮起 main panel，视觉对齐 `shell/draft-overlay-states.html`

### UC-2: 用户用 mock 数据完成一次对话
- **Actor**: 开发者用户
- **场景**: `VITE_MOCK=true` 启动，新建 session，发送消息
- **预期结果**: 消息流显示 user/assistant 块 + 流式光标 + 回合折叠，composer 9 态中主聊天路径的态正确（S1 空→S2 聚焦→S5 发送中→S6 停止→回 S1，S7-S9 steer/双队列/失败见 DEFERRED），全程不触达真 runtime

### UC-3: 用户在 sidebar 切换会话/文件/overview
- **Actor**: 开发者用户
- **场景**: segmented tab 切换会话列表 ↔ 文件视图，点 Overview 按钮
- **预期结果**: 容器四态正确切换，Overview 覆盖 main 区、sidebar 持久（ADR-0022）

## 8. 引用索引（不重复内容）

| 文档 | 用途 |
|------|------|
| `docs/architecture/design.md` §4.1 R1-R5 | Renderer 分层铁律（本 spec §3 来源） |
| `docs/architecture/plan/phase-1-api-client.md` | API Client 层任务分解（P5 来源） |
| `docs/designs/v3-demo/*.md` + `draft-*.html` | 各 phase 验收基准（§4 来源） |
| `docs/designs/design-tokens.md` | token SSOT（P0 来源） |
| `docs/architecture/adr/0018-0022` | 视觉/flow/资源/主题/overview 决策 |
| `docs/architecture/context.md` | 领域术语 + v3 UI 结构术语 |
| `main` worktree `stores/navigation.ts` | 路由历史栈参考实现（D1 来源） |

## 附录 A：Renderer 目标目录结构

```
renderer/src/
├── api/                    # R4 统一门面（phase-1-api-client.md）
│   ├── index.ts  transport.ts  pending.ts  events.ts
│   ├── domains/            # session chat config model tree extension plugin system
│   └── mock/               # 同接口假实现（fixture 从零写，参考 main worktree 结构）
├── components/             # R1 展示层（按 v3-demo 设计单元分域）
│   ├── ui/                 # shadcn-vue 原子
│   ├── shell/  sidebar/  workspace/  panel/
│   ├── overlays/  overview/  settings/
├── composables/            # R2 features/ effects/ logic/
├── stores/                 # R3 Pinia（navigation session chat panel tree...）
├── lib/                    # R5 ws-client event-bus ipc + 纯函数
├── design-system/  mock/  i18n/  types/
└── App.vue  main.ts        # 组合根
```

## 待办标记

以下决策在 spec 阶段已定，此处仅留需 plan 阶段进一步细化的次要项。

- [AMBIGUOUS] P4 message-stream 的「Summary 契约」（Agent 停止前必输出总结）落点：PRODUCT 行为契约还是 Panel 渲染约定？待 plan 阶段确认

## 追加决策记录（gap 处理后）

### D5. radius 冲突裁决：遵 design-tokens（3/8/12px）
- CLAUDE.md #10 的 1px/2px 是 Warm 时期遗留，已被推翻（已同步改 CLAUDE.md）
- design-tokens.md 是 v3 SSOT（ADR-0018），22 个 draft 全用它
- P0 装机：tailwind.config 的 `borderRadius` 映射 `sm:3px / DEFAULT:8px / lg:12px`

### D6. SessionStatus 5 态：前端派生（不动后端协议）
- `shared/session.ts` 的 `SessionStatus` 仅 `'active'|'idle'`，但 sidebar draft 要 5 态（running/waiting/done/stopped/error）
- **策略**：前端从 message/tool 状态派生（`isStreaming`→running、`isWaitingTool`→waiting 脉冲、`lastMessage.status==='error'`→error、正常→done/idle），不动 shared 类型（符合 mock 优先 + 联调推迟）
- 实现位置：`stores/session.ts` 的 computed 或 `composables/features/useSessionStatus.ts`

### D7. 工程默认包（mock 契约/持久化/i18n/ipc）

| 项 | 决策 | 理由 |
|---|---|---|
| mock 返回类型 | 严格镜像 shared 类型（全字段，非 Partial） | typing 安全 |
| mock 模拟失败 | **否**（v1 永远成功） | 失败 UI 联调阶段用真 stream_error 验；mock 模式不造错误 |
| mock id 往返 | mock 直接 resolve Promise（不模拟 UUID 关联） | 简化 mock 实现 |
| 持久化介质 | 全内存（reload 重置） | 符合 mock 短期性质 |
| i18n | 先硬编码中文，defer 抽 `$t` key | 避免每个组件铺键开销 |
| ipc bridge | 按各 phase 实际用到补齐，非一次全补 15+ 方法 | YAGNI |
| mock 连接态 | 保留 4 态机不变量，mockConnect 200ms 直进 connected | 真 runtime 视觉对齐预演 |

## 8.5 本期范围裁决（v1 = 最小可用）

> 追踪发现 design 稿定义了大量交互，v1 mock 阶段只做主流程，其余 **DEFERRED**（联调/后续阶段补）。**DEFERRED 项完整记录在 §9，确保下次能定位继续，不丢失。**

**v1 In-scope（本次做）**：主聊天流（UC-1/UC-2）+ session 切换/创建（UC-3 基本部分）+ 基础空态 + Overview 进入**与基本退出** + message-stream auto-scroll 基础版。

> Round 2 追踪修正：原「Overview 进入」若退出全 DEFERRED 会成单向陷阱，故基本退出（Esc + 点卡片载入 session 返回 chat view）拉回 v1；auto-scroll 是主聊天流可用性依赖，基础版（新消息滚到底）拉回 v1，高级行为（用户上滚暂停）DEFERRED。
>
> Round 3 追踪修正：
> - **v1 快捷键范围**（G3-003）：`⌘N`（新建 session）、`⌘[`/`⌘]`（后退/前进，navigation store）**v1 做**；`⌘K`（搜索）、`⌘,`（settings）、`⌘⇧O`（Overview 切换）**v1 不做**（随对应 DEFERRED 项）。
> - **DEFERRED 功能的入口渲染统一规则**（G3-002）：DEFERRED 项若在 v1 已渲染的组件中存在触发入口（如 sidebar 的搜索/重命名按钮、panel 的 split 按钮），统一采用**「hide 隐藏」**策略（v1 不显示该入口），不保留 disabled 占位（避免误导）。例外：核心功能入口（新建 session `⌘N` / Overview 进入）v1 保留。

### §4 P1-P6 v1 交付边界（处理 G3-001，scope 三分自洽）

每 phase 交付「**骨架 + v1 主路径渲染**」，draft HTML 作为骨架视觉验收基准；phase 中超出 §8.5 v1 范围的设计细节（companion-zones / detail-pane / 折叠态微交互 / 全屏两态切换 / Overview 卡片筛选排序 / Settings 三模式等）**随对应 §9 DEFERRED 项处理**，不独立验收。

| Phase | v1 做（骨架+主路径） | DEFERRED 细节（见 §9） |
|-------|-------------------|---------------------|
| P1 Shell | aside/main 两区域 + traffic light 安全区 | 全屏两态切换微交互 |
| P2 Sidebar | 容器四态骨架 + 会话项 + 折叠态 + Overview 按钮 + ⌘N 新建 | rename/删除确认、收起态导航迁移 |
| P3 Workspace+Panel | 双 Panel 主从 + 5 zone 空壳 | split 单 session 场景 |
| P4 Panel | message-stream 7 块 + 回合折叠 + composer S1/S2/S5/S6 + auto-scroll 基础版 | S3/S4/S7-S9、companion-zones、detail-pane、abort 流转 |
| P6 Overlay/Overview | Overview 卡片网格骨架 + 进入/基本退出 | 卡片筛选排序、Settings 三模式、⌘K 搜索范围 |

## 9. DEFERRED 清单（联调/后续阶段补，不丢失）

> **以下交互 v1 不做，但必须记录以免丢失。下次继续时优先查这里。** 记录格式：`[gap来源] 交互 → 何时做`。

### 交互类（G-013/018/019/020/021/022/023/024/025/027/033 + G2-002/003/005）

| Gap | DEFERRED 交互 | 触发条件（何时做） |
|-----|--------------|-------------------|
| G-013 | 关闭最后一个 panel / 删除当前激活 session 的确认流 | 联调阶段（需真 session 生命周期） |
| G-018 | Tool 审批 UI（`tool.approve`/`deny`/`always_allow`） | 联调阶段（需真 tool 调用流） |
| G-019 | Steer/Followup 提交态（composer S7-S8，设计稿 §4-5） | 联调阶段（需真 AI 工作中排队） |
| G2-002 | Composer S3（@/#// 命令浮层）/ S4（附件） | 联调阶段（无真命令表/附件源） |
| G-020 | Overview 高级退出（⌘⇧O 快捷键切换） | P6 Overview 骨架后 |
| G2-003 | File View 内容渲染（文件树） | 联调阶段（文件树来自 runtime，mock 无源）；v1 只渲染 tab 切换骨架 |
| G-021 | Settings modal 三模式触发入口（⌘, / sidebar 头像） | P6 Settings 骨架后 |
| G-022 | ⌘K Search Modal 搜索范围 + mock 数据源 | P6 Overlays 骨架后（跨项目范围永久 defer） |
| G2-005 | Session rename（hover 重命名按钮） | 联调阶段（不在切换/创建核心路径） |
| G-023 | Panel split 单 session 场景（新建/选择器/禁用） | P3 Workspace 后 |
| G-024 | Sidebar 收起态（C）导航按钮迁移到 workspace 顶栏 | P2/P3 后（需定 workspace 顶栏是否存在） |
| G-025 | 用户 abort（S6）后的状态流转 + 中断回合折叠 + 重发 | P4 后（需真 abort 行为） |
| G-027 | ThemeMode='system' 模式（跟随 OS） | 亮色校准后（spec §2 Out-of-scope） |
| G2-007 | message-stream auto-scroll 高级行为（用户上滚暂停、新消息“跳到底部”提示） | P4 后 |
| G-033 | ⌘B 三态第 3 态（折叠+有脏数据→分支 popover，依赖 dirty flag） | v1 只做前两态，第 3 态留 TODO |

### Round 2 新增 DEFERRED 验收契约说明

> G2-004 / G2-006 是 scope 边界划定，不是新增 DEFERRED 项，在此明确：

- **空态收敛定义（G2-004）**：v1 「基础空态」= (a) sidebar 会话数=0 时显示引导新建入口；(b) message-stream 在空 session 时显示欢迎语。File View 空态随 G2-003 defer。
- **mock fixture 块丰富度（G2-006）**：mock 需含足够块类型让 UC-2 可验收——user / assistant text / tool_call（简化展示，无审批按钮）/ summary / error 等主要块，回合折叠 pill 可验。S3/S4 相关块不造。具体 fixture 在 plan/mocking 阶段细化。

### 持久化/契约类（G-015/016/028/029/031/032/034/035）

| Gap | DEFERRED 项 | 触发条件 |
|-----|------------|---------|
| G-015 | mock session 跨 reload/HMR/重启持久化 | 联调阶段（切真 runtime） |
| G-016 | composer 草稿跨 session/panel 持久化 | localStorage 持久化统一做时 |
| G-029 | mock 模拟失败路径（已定不做，失败 UI 仍需联调验证） | 联调阶段 |
| G-031 | 折叠态/composer 草稿/panel ratio/sidebar tab/目录展开持久化介质 | localStorage 统一做时 |
| G-032 | mock id 往返模拟（已定不模拟） | 非必要，不做 |
| G-034 | i18n 全量 `$t` key 抽取（已定先硬编码） | 国际化需求启动时 |
| G-035 | ipc bridge 全量补齐（已定按需补） | 用到即补 |

### 设计稿不一致（P0 验收前必须收口）

| Gap | 问题 | P0 处理 |
|-----|------|--------|
| G-004 | token 命名 `--bg` vs `--bg-base` | SSOT=`--bg`，shell/spec.md 笔误待修 |
| G-008 | draft 间 success/warning/danger 色值差异 | SSOT=design-tokens，draft 旧值不作验收基准 |

## 追踪产出索引

- `changes/tracing-round-1.md` — Round 1 隔离追踪（35 gap，5 视角 3 完整 + 2 降级）
- `changes/tracing-round-2.md` — Round 2 收敛复核（7 个 scope 边界 gap，已处理）
- `changes/tracing-round-3.md` — Round 3 收敛复核（3 个一致性 gap，已处理）
- `changes/tracing-round-4.md` — Round 4 收敛复核（见下）
