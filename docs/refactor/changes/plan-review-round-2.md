# 产出文档审查（Round 2）

> 审查方法：逐条核对 plan-review-round-1.md 的 27 项发现，对存疑点用 read 核实代码（tsup.config.ts / interfaces.ts / useChat.ts / index.ts / window-manager.ts / session-service.ts）。客观一致性（链接/编号/行号/数字）已由主 agent grep 验证通过，本轮聚焦判断性维度（修订质量/可执行性/新矛盾）。

## 摘要

- 维度 A（27 项修订核对）：已修复 19 / 部分修复 6 / 未修复 2
- 维度 B（修订引入的新矛盾/未消解旧矛盾）：4
- 维度 C（可执行性问题）：7
- 总体判断：**基本 OK 有小瑕疵，但有 3 处硬伤必须先修（全在 phase-2）**。修掉后计划可照做落地。

> 抽查 round-1 代码行号全部真实：`index.ts:12` 证明 extension-service.ts 在根目录；`tsup.config.ts` 确认 bundle 模式 + 仅 2 entry；`interfaces.ts` ISessionService 恰 21 方法；`useChat.ts` createGlobalHandlers 返回 23 项 Map；`window-manager.ts` panelTree 递归 + sessionIds 字段并存。

---

## 维度 A：27 项修复核对

### Phase 0（5 项）

| round-1# | 发现 | 判定 | 证据 |
|---|---|---|---|
| 1 | D1 八步时序与代码相反 | ✅ | design.md §D1 订正框「按代码现状写：createWindow 先于 spawn」；phase-0 task 1 明确「不改代码」并要求同步修正 spec |
| 2 | M1 spawn 去重无承接 | ✅ | 决策映射表「M1 → 阶段 2.5」；phase-2.5 task 2 抽 `startAndNotify(win)` |
| 3 | M3 window-manager 不存 tree 无承接 | ✅ | 决策映射表「M3 → 阶段 2.5」；phase-2.5 task 3 去 panelTree、改 sessionIds |
| 4 | task 2 commit 未列 terminology-alignment-plan.md | ⚠️ | phase-0 task 2 清单仍只列 architecture-design/review-issues/tracing-round-1/migration-plan/plan/，**仍未含 terminology-alignment-plan.md**，phase-4 R1–R5 依赖它 |
| 5 | 验证无法捕获时序相反 | ✅ | 时序已订正（#1），验证现与代码一致 |

### Phase 1（12 项）

| round-1# | 发现 | 判定 | 证据 |
|---|---|---|---|
| 6 | send 不止 7 composable，漏 store+组件 | ✅ | phase-1 现状表扩到 11 行：stores/plugin.ts(9)、ExtensionsPane(8)、PanelSessionView(4)、SkillDrawer(1)、AppStatusbar 全列入 |
| 7 | 验证 rg 只扫 composables/ | ✅ | phase-1 验证改为扫全 renderer；phase-5 5.3 同步改扫 `**/*.ts+*.vue` |
| 8 | useChat refCount 与全局单例不匹配 | ✅ | phase-1 列 23 事件清单；task 3 G6 reconcile「全局单例保持，refCount 只适用组件级 on」区分清楚 |
| 9 | mock 低估 + VITE_MOCK 漏 useConnection | ⚠️ | VITE_MOCK 已补 useConnection.ts:45,53；总量改 998 行重写。**但重写步骤仍偏声明**，未列 mock 需覆盖哪些 api domain 方法（见 C-3） |
| 10 | useTree 3 非 8 | ✅ | 改为 8（含 5 个 tree.*） |
| 11 | useModel 2 非 3 | ✅ | 改为 3（含 setThinkingLevel） |
| 12 | useExtensionUI plugin.uiResponse 误标 | ✅ | 改为「跨 extension/plugin 两 domain」 |
| 13 | useSession switch 实际在 useTree | ✅ | useSession 改 6，useTree 改 8（含 switch） |
| 14 | Runtime id 回填已实现，task 4 误导 | ✅ | 标注「已就绪，仅需前端 pending.ts 发 id」+ 5 handler 85 处 |
| 15 | G5 不续传与 messageQueue flush 冲突 + effects 碰 store | ⚠️ | 清队列已补；useConnection 碰 store 违规已解决（改 emit 信号）。**但 events.ts 调 markSessionError 引入新的层级张力**（见 B-2） |
| 16 | command 与 messageQueue 交互未定义 | ✅ | task 2 明确「断连期 command 不入队」 |
| 17 | 验证未覆盖 store+组件 | ✅ | 同 #7 |

### Phase 2（7 项）

| round-1# | 发现 | 判定 | 证据 |
|---|---|---|---|
| 18 | extension-service.ts / timeout-manager 分类错误 | ❌ | **未修复，且三处自相矛盾**。`index.ts:12` 证明两文件在根目录。phase-2 现状表仍列「services/（已存在，保持）」= 不动作；task 1 mv 命令无对应；**风险表却写「已补入 task 1」**——三处打架 |
| 19 | git-info.ts / session-history.ts 未入盘点 | ⚠️ | 现状表 services 行未单列（位置正确，仅影响核对） |
| 20 | tsup entry 描述错误 | ❌ | **未修复**。`tsup.config.ts` 实测 bundle 模式 + 仅 2 entry。phase-2 task 4 仍写「entry 数组更新新路径（含 transport/server.ts 等）」——照做会产生多余产物 |
| 21 | utils/path-utils.ts、plugins/demo 未提及 | ⚠️ | 现状表「待定」行只有 trash.ts |
| 22 | SidecarServer 注释残留归属不清 | ⚠️ | server.ts 注释归 task 3。但 5 个 handler 头注释 + shared/protocol.ts:1,166 + process-manager/plugin-types/stores/plugin/tsup 注释仍无明确归属 |
| 23 | handler→service 跨层 import 联动未列 | ⚠️ | task 2 仍泛泛，未列具体文件（低影响，build 即暴露） |
| 24 | electron-builder 不受影响 | ✅ | 无需改 |

### Phase 3（6 项）

| round-1# | 发现 | 判定 | 证据 |
|---|---|---|---|
| 25 | 方法归属表未覆盖全部方法 | ✅ | v1.1 归属表列全 21 方法（核对 interfaces.ts ISessionService 恰 21）；getSummary/rebindAfterFork/destroyAll 均已归属 |
| 26 | 私有 helper 共享模型未定义 | ⚠️ | 模型已定义（Facade 持有，子模块经受限视图调用）。**但「受限视图」接口签名未给出**，存在循环 import 风险（见 C-4） |
| 27 | 共享状态模型未定义 | ✅ | 单写者模型：sessions Map 唯一持有于 Facade；验证加「rg 确认子模块不持有 Map」 |
| 28 | pm.onSessionExit 回调归属未定 | ✅ | 明确归 Facade 构造函数协调各子模块 |
| 29 | switchModel 留 Facade 切分依据 | ✅ | round-1 标「非错误」 |
| 30 | 验证无法捕获 helper 共享破坏 | ⚠️ | 加单写者 rg + TDD 先行；但 this 绑定/受限视图循环仍靠运行期暴露 |

### Phase 4（2 项）

| round-1# | 发现 | 判定 | 证据 |
|---|---|---|---|
| 31 | R1 残留扫描范围不明 | ⚠️ | phase-4 R1 仍写「已大部分完成，扫残留」，**无具体清单**（17 处 sidecar 散落点未列出） |
| 32 | R1 与 phase-2 注释归属重叠 | ✅ | phase-2 task 3 做 server.ts，phase-4 聚焦 R2–R5，已分开 |

### Phase 5（2 项）

| round-1# | 发现 | 判定 | 证据 |
|---|---|---|---|
| 33 | 5.2 启动时序测试依赖 phase 0 修正 | ✅ | phase-0 时序已订正；phase-5 5.2 改为「按真实顺序」 |
| 34 | 5.3 pre-commit 只扫 composables/ | ✅ | phase-5 5.3 改扫全 renderer，显式列 stores/plugin.ts + 4 组件 |

### 跨阶段
M1/M3/D1/G6/G5 五项已由 #2/#3/#1/#8/#15 解决。D2「原子 claim 搁置」已标注「超出 scope」✅。

---

## 维度 B：新矛盾 / 未消解旧矛盾

### B-1【硬伤】phase-2 三处自相矛盾：extension-service 到底迁不迁
现状表（保持）+ task 1（无 mv 命令）+ 风险表（声称已补入 task 1）三处打架。代码事实：根目录。

### B-2 phase-1 让 api/events.ts 直接调 chatStore，与 design.md §4.1 依赖图张力
G5 链路自洽，但 events.ts（api 层）调 markSessionError 违反依赖图「features 是唯一同时碰 api+store 的层」。原 useConnection 违规解决了，却把碰 store 下移到 api 层。建议：events.ts 只 emit 内部事件，由 useChat(features) 订阅后调 markSessionError；或在 design.md §4.1 给 api/events.ts 开例外。

### B-3 shared/protocol.ts:1 注释「Client → Sidecar」无人认领
phase-2 task 3 只改 server.ts，phase-4 R1「扫残留」无清单。protocol.ts:1,166 两处注释两边都没承接（违反 D7）。

### B-4 phase-2 task 1 自带错误命令 + 纠错注释
`git mv event-adapter.ts ... transport/  # 误——这些是 adapters`——命令本身错，靠行尾注释提醒。可执行性差。

---

## 维度 C：可执行性问题

- **C-1【硬伤】** phase-2 task 1 含错误 git mv 命令（见 B-4）
- **C-2【硬伤】** phase-2 task 4 tsup entry 指导错误（见 #20）
- **C-3** phase-1 task 6 mock 重写缺覆盖范围清单（未列 mock 需覆盖哪些 api domain 方法）
- **C-4** phase-3「受限视图」接口未定义，存在 Facade↔子模块循环 import 风险
- **C-5** phase-2.5 改 WindowState 影响面：未给全仓 panelTree 使用点扫描清单（仅提 main/ 侧）；且 window-manager.ts:108 已有 sessionIds[] 字段，M3 实际比 design.md 描述更轻
- **C-6** phase-1 G5 清空队列「执行时定」（可接受，建议给默认：全部清空最简单）
- **C-7** phase-4 R1 扫残留无清单（见 #31）

---

## 必须修复（硬伤） vs 可选（瑕疵）

### 🔴 必须修复（全在 phase-2）
1. **extension-service.ts/timeout-manager 分类**：现状表改「根目录→需 mv」，task 1 补 mv 命令，风险表对齐（消除三处打架）
2. **task 4 tsup entry**：改「entry 零改动（bundle 模式，server.ts 被 bundle 进 index.cjs）」
3. **task 1 删除错误 git mv 命令**：移除带「误」注释的命令行，只保留分类表

### 🟡 建议修复
4. phase-1 task 6 补 mock 必须覆盖的 api 方法最小集（C-3）
5. phase-3 补「受限视图用 interface 解耦，避免循环 import」一句（C-4）
6. phase-1 明确 events.ts 碰 store 的层级，或改由 features 层订阅收尾（B-2）
7. phase-2.5 补全仓 panelTree 扫描（含前端）+ 注明 sessionIds 已存在（C-5）
8. phase-4 R1 补 sidecar 残留点清单（A-#31/C-7）
9. phase-0 task 2 commit 清单补 terminology-alignment-plan.md（A-#4）

### 🟢 可不改
git-info/session-history 未入盘点、utils/demo 未标注、handler import 联动、注释残留分散、compact/getRpcCommand 行号笔误

---

## 结论

修订主体到位：27 项中 19 项正确修复，跨阶段掉缝（M1/M3/D1/D2/G6）全部补齐，phase-1 send 范围/23 事件/验证盲区、phase-3 21 方法归属/状态模型等关键项均落实，代码核对证实 round-1 行号真实。

**但 phase-2 有 3 处硬伤**（extension-service 分类三处打架 + tsup entry 误导 + 错误 mv 命令），会让「低风险机械重构」实际执行时漏迁文件 + 误改打包配置 + 跑错 mv。必须先修这 3 处。

其余为可执行性瑕疵，不阻塞落地。**修完 3 处 phase-2 硬伤后，计划可进入执行。**
