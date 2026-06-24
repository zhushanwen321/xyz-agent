---
verdict: APPROVED
review_target: code-architecture.md, code-architecture.html
upstream: system-architecture.md, issues.md, changes/tracing-round-14.md
reviewer: 独立代码架构审查 subagent（隔离上下文）
date: 2026-06-24
---

# 代码架构审查报告 — code-architecture（5 维）

## 结论：APPROVED

5 维审查均通过。发现 **0 个阻塞项**、**1 个推荐修复项（R-01）**、**4 个 cosmetic/minor 项**。tracing-round-14 已确认设计收敛（CONVERGED），本轮复核无回归、无新阻塞。唯一值得在进入 execution 前顺手修的是 R-01（F2 ack 回复类型未锚定到契约条目），但它不卡执行——下游不会因此猜错核心行为。

| 维度 | 判定 | 说明 |
|------|------|------|
| 1. 内部一致性 | 通过（含 1 推荐 + 2 cosmetic） | 签名表↔时序图大体自洽；F2 回复类型 `message.status` 未在 §3.9 契约登记（R-01）；§4 章节编号 4.12 错位（C-01）；DAG 与 Wave 表 F9 依赖不一致（C-02） |
| 2. 上游对齐 | 通过 | 忠实延伸 issues.md 13 个 issue 的方案决策，无偷改结论；[STALE]/[SURFACED] 处理清楚（U-01 为已知上游漂移，非本次材料引入） |
| 3. 可执行性 | 通过 | Wave 映射表 + DAG + 12 时序图（入口→底层完整）+ 异常路径 + 预编码确认点齐全；下游可直接拆 Wave |
| 4. 完整性 | 通过 | 工程目录树 / 包依赖图 / API 契约表 / 时序图 / Deep Module 决策五项均 substantive |
| 5. 可视化质量 | 通过 | HTML 用 `<pre>` ASCII 图规避 mermaid 渲染依赖，深色主题 + 表格 + badge + 图例，`overflow-x:auto` 防溢出，可正确渲染 |

---

## 维度 1：内部一致性

### R-01（推荐修复，非阻塞）— F2 写操作的 ack 回复类型 `message.status` 未锚定到契约

**位置**：code-architecture.md:461（§4.2 F2 时序图）、code-architecture.html F2 块。

**现象**：F2 stage 成功后 `reply(ws, id, 'message.status', {sessionId, status:'staged'})`。但 §3.9「Shared Protocol 新增契约」只登记了 `'git.status:result'` 一个新 ServerMessageType，**没有** `message.status`，也未声明它是既有类型。F1 的回复 `'git.status:result'` 有契约登记，F2 的 `'message.status'` 悬空。

**影响评估**：低。git domain 的 stage/unstage/commit 返回 `Promise<void>`（§3.1），请求-响应靠 pending registry 按 `id` 匹配，回复的 wire type 对调用方几乎透明。implementer 不会因此猜错核心行为（pending.resolve 是明确的）。唯一风险是严格 vue-tsc 契约检查时，若 `message.status` 不在 `ServerMessageType` 联合中会编译报错。

**为何不升 CHANGES_REQUESTED**：不会「卡住」执行，至多 5 分钟 grep 澄清。属契约文档的清晰度问题，非行为错误。

**修复**（二选一）：
- 若 `message.status` 是既有类型：在 §3.9 加一句「写操作 ack 复用既有 `message.status`（payload `{sessionId, status}`）」。
- 若是新类型：补入 §3.9 `ServerMessageType`/`ServerMessageMap` 新增条目，并定义 payload。

### C-01（cosmetic）— §4 章节编号 4.12 物理位置错位

**位置**：§4.7（F7，line 807）→ §4.12（F7-UI，line 865）→ §4.8（F8，line 910）。

**现象**：F7-UI 是 #13 [SURFACED] 升级后补入的时序图，为逻辑紧贴 F7 而插在 4.7 之后，但编号为 4.12，导致阅读顺序为 4.1…4.7 → **4.12** → 4.8…4.11。

**影响**：纯阅读体验，不影响可执行性。

**修复**：改为 §4.7b 或重新顺序编号为 4.8（后续顺延）。

### C-02（minor）— §6.2 DAG 与 §6.1 Wave 表对 F9 依赖不一致

**位置**：§6.2 DAG（line 1127 `F7 --> F9`）vs §6.1 Wave 表（line 1113「F9 widget 订阅 | W3 | F10 + F3」）。

**现象**：DAG 多出一条 `F7 --> F9` 边（暗示 F9 依赖 F7 chat store），但 Wave 表未列 F7 为 F9 的依赖。F9（widget 订阅）经 extension domain `events.on(sessionId)` 消费 `extension:widget`，并不经过 `chat-chunk-processor`，对 F7 无真实依赖。DAG 这条边是多余/无依据的。

**附带**：DAG 节点集为 {F11,F7,F1,F3,F8,F6,F7UI,F10,F9}，未含 F5（session.list）、F4（compact）——作为「关键依赖 DAG」可接受，但 F9 这条多余边应删，使图与表一致。

**修复**：删 DAG 中 `F7 --> F9` 边。

### C-03（cosmetic）— F2 异常路径图 exec 调用省略 cwd

**位置**：§4.2 异常路径时序图 `GS->>GE: exec('commit', ['-m', message])`。

**现象**：`IGitExecutor.exec(cwd, command, args)` 首参为 cwd，异常图简写为 `exec('commit', [...])` 省了 cwd。主路径图（`exec(cwd, 'stage', [...])`）是完整的。

**影响**：无，主路径已示范完整签名。异常图属缩写惯例。

---

## 维度 2：上游对齐

**结论：忠实延伸，无偷改。**

13 个 issue 的方案决策逐一核对，code-architecture 全部按 issues.md 既定方案延伸，无反向篡改结论：

| Issue | issues.md 决策 | code-arch 落点 | 对齐 |
|-------|---------------|----------------|------|
| #1 git 全栈 | 方案 A 完整 IGitExecutor | §5.1 GitService+IGitExecutor | ✓ |
| #2 domain 规范化 | 方案 A 删 get* 改订阅 | §3.5 settings.ts 不再暴露 get* | ✓ |
| #3 GitZone | 方案 A 独立组件 | §1.1 GitZone.vue | ✓ |
| #4 mock | 方案 A 固定剧本 + mock/git.ts | §4.6 F6 + §6.3 点4 | ✓ |
| #5 Extension | 方案 A 内联候选 | §4.3 F3 | ✓ |
| #6 compact | 方案 A slash command | §4.4 F4 | ✓ |
| #7 session.list | 方案 A onGlobalType | §4.5 F5 | ✓ |
| #8 stores/chat | 方案 A 补 case + unmerged | §4.7 F7 | ✓ |
| #9 SideDrawer | 方案 A 独立 | §4.10 F10 | ✓ |
| #10 FileView | 方案 A 聚合 chat store | §4.8 F8 | ✓ |
| #11 widget | 方案 A session 通道 | §4.9 F9 | ✓ |
| #12 契约裂缝 | 方案 A tools + unmerged | §4.11 F11 + §3.9 | ✓ |
| #13 retry/queue UI | P1/W2 [SURFACED] 修订 | §4.12 F7-UI | ✓ |

### [STALE] / [SURFACED] 冲突处理

- **[STALE] tool_call_pending**：code-architecture.md 自身四方自洽——§3.9（`ToolCallStatus = 'running'|'completed'|'error'`，无 pending）↔ §4.7（F7 无 pending 分支）↔ §4.11（[STALE] 注）↔ §6.4（grep 反向断言）。处理清楚。
- **[SURFACED] #13**：§4.12 F7-UI 用「P3 迷雾 → 按 spec P1 覆盖」箭头表述，清楚。唯一瑕疵：§4.7 的 [SURFACED] 注仍按「冲突原态」措辞（「issues.md #13 将其降为 P3 迷雾」，现在时），而 issues.md #13 现已升 P1。属历史记录措辞，tracing-round-14 已判定不计 gap。可顺手补「issues.md #13 已同步升 P1/W2」。

### U-01（既有上游漂移，非本次引入，非阻塞）

system-architecture.md §6.3 Port 清单仅列 ISessionStore/IConfigStore/IPiEngine/IGitExecutor，缺 IInstaller / IExtensionSettings。而 code-architecture §1.2 与 §5.4 引入了这两个 port。这是上游 system-architecture.md 的遗漏（tracing-round-14 U-01 已记录），不在本次审查的材料修正范围内，不阻塞。

---

## 维度 3：可执行性

**结论：可直接拆 Wave。**

- **Wave 映射**（§6.1）：12 个时序图 → W1/W2/W3 归属 + 依赖 + 可并行标注，清晰。
- **依赖 DAG**（§6.2）：除 C-02 一条多余边外，拓扑正确。
- **时序图完整性**：12 个图均含入口（组件/composable）→ 底层（git CLI / pi engine / 文件系统）完整链路，每个图配方法签名表 + 数据流链 + 关联。
- **异常路径覆盖**：
  - F1：isRepo=false / timeout / git 未安装 → 降级
  - F2：冲突态 / 路径越界 / git 未安装 / session 不存在 → 完整异常图
  - F3：URL 非法 / git clone 失败 → 异常图
  - F4：ensureActive 失败 / client 不存在 / pi engine 错误 → 异常图
  - F7：messageId 未命中兜底 / 未知 type default no-op
  - F8：无 fileChanges → []
  - F9：widgetKey 未知也推送 / 未知 key fallback
- **预编码确认点**（§6.3）：5 项（GitZone input 用 xyz-ui / SideDrawer tab 初始集合不含 Diff / 候选内联展开位置 / mock git fixture 以 issues.md 为准 / Panel.vue LOC 预算提取 useSideDrawer）。其中第 4 点主动表面化 spec-w11.md 与 issues.md 的表述差异并裁决，是高质量处理。
- **验收 grep 清单**（§6.4）：6 项可执行检查命令。

R-01（回复类型）是唯一的可执行性疑点，但已在维度 1 评估为非阻塞。

---

## 维度 4：完整性

**结论：五项均 substantive。**

| 完整性项 | 位置 | substantive 判定 |
|---------|------|-----------------|
| 工程目录树 | §1.1 renderer / §1.2 runtime / §1.3 shared | ✓ 三棵树 + 变化轴 + 依赖方向表 + #n 新建标注 |
| 包依赖图 | §2 mermaid + import 规则表 + 4 个循环依赖检测点 | ✓ |
| API 契约表 | §3.1–§3.9（9 张表：git/extension/chat/events/settings+config/GitHandler/GitService/IGitExecutor/Shared protocol） | ✓ 含方法签名/返回/边界条件/Spec-Issue 关联 |
| 时序图 | §4 F1–F11 + F7-UI（12 图） | ✓ 每图含方法签名表 + 数据流链 + 异常路径 |
| Deep Module 决策 | §5.1–§5.4（GitService+IGitExecutor / events.ts / chat-chunk-processor / ExtensionService） | ✓ 每项含 Interface/Depth/Seam/Port 决策/Deletion test |

§5 选了 4 个真正有深度的模块（其余如 GitMessageHandler 是薄路由，无需 deep-module 写up），取舍合理。

---

## 维度 5：可视化质量

**结论：可正确渲染。**

code-architecture.html 审查：
- 用 `<pre>` ASCII 框线图替代 mermaid，规避了 mermaid CDN/版本渲染依赖——可靠性强，是正确选择。
- 深色主题（`--bg:#0b0f14`）+ 表格 border-collapse + badge（new/stale/surfaced 三色）+ 图例，排版可读。
- `.graph-wrap { overflow-x: auto }` 防窄屏溢出。
- [STALE] note 块独立高亮。
- HTML 为 .md 的精简视图（§1 包依赖 + §2 核心 7 个时序 + §3 Wave 表），文末指向 .md 取全文，定位清晰。

无渲染风险。HTML 与 .md 的 F2 回复类型一致使用了 `message.status`（即 R-01 在两处一致出现，非 HTML 独有错误）。

---

## 发现清单（按严重度）

| ID | 严重度 | 维度 | 摘要 | 阻塞? |
|----|--------|------|------|-------|
| R-01 | 推荐 | 1/3 | F2 ack 回复类型 `message.status` 未锚定 §3.9 契约 | 否 |
| C-01 | cosmetic | 1 | §4.12 章节编号物理位置错位（4.7→4.12→4.8） | 否 |
| C-02 | minor | 1 | §6.2 DAG 多出 `F7-->F9` 边，与 §6.1 Wave 表不一致 | 否 |
| C-03 | cosmetic | 1 | F2 异常图 exec 省略 cwd 首参 | 否 |
| U-01 | 上游漂移 | 2 | system-arch §6.3 Port 清单缺 IInstaller/IExtensionSettings（非本次引入） | 否 |

---

## 建议修复（进入 execution 前可顺手清理，均非阻塞）

1. **R-01**：§3.9 补 `message.status` 的契约登记或注明「复用既有」，同步 HTML F2 块。
2. **C-01**：F7-UI 改编号 §4.7b，或重排为 §4.8（后续顺延）。
3. **C-02**：删 §6.2 DAG 中 `F7 --> F9` 边。
4. **C-03**（可选）：F2 异常图 exec 补 cwd 参数。
5. **U-01**（上游）：system-architecture.md §6.3 补 IInstaller / IExtensionSettings 两个 port。

完成 1–3 可使 code-architecture.md 内部完全自洽；不完成亦不影响 execution 正确性。

---

## 已确认对齐 / 无回归项

- 13 个 issue 方案决策全部忠实延伸，无偷改（见维度 2 表）。
- [STALE] tool_call_pending 四方自洽（§3.9/§4.7/§4.11/§6.4），与 tracing-round-14 N-01/N-02 结论一致。
- [SURFACED] #13 P1/W2 升级已在 §4.12 F7-UI + §6.1 Wave + §6.2 DAG + §1.1 组件枚举 + issues.md #13 全链对齐，与 tracing-round-14 N-03/M-01/M-02 结论一致。
- Deep Module port 决策（GitService true-external / events.ts in-process / chat-chunk-processor in-process / ExtensionService local-substitutable）与 system-architecture §6.3 + §10 特化决策一致。
- git-status-parser 纯函数分层豁免（§5.1）有明确论证，未破坏 IO 边界闭合原则。

---

**最终判定：APPROVED。** 设计已收敛，5 维通过。建议同批清理 R-01 + C-01 + C-02（共 3 处，约 10 行改动）使文档完全自洽，但不阻断从设计进入执行。
