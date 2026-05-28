---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-28T23:30:00"
  target: ".xyz-harness/2026-05-28-plugin-system-frontend-dx/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第2轮，3条 MUST FIX（新增），3条上一轮 MUST FIX 已验证修复，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 3
  must_fix_resolved: 2
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:§FR-B1 & §FR-B4"
    title: "plugin:statusBarUpdate vs plugin:status_bar_update 消息名矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "已修复：FR-B1 命名风格章节明确要求改名，FR-B4 已同步为 camelCase，Server→Client 新增列表使用 plugin:statusBarUpdate，所有旧名引用已替换"

  - id: 2
    severity: MUST_FIX
    location: "spec.md:§FR-B4"
    title: "状态栏引用未定义的 WS 消息 plugin.executeCommand"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "已修复：plugin.executeCommand 已加入到 Client→Server 新增列表（FR-B1），AC-A4 已引用，FR-B4 中已正确引用"

  - id: 3
    severity: LOW
    location: "spec.md:§FR-B1, FR-B2, FR-B4"
    title: "事件监听防重复注册未提及（split mode 风险）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "已修复：Constraints 章节已添加：'事件监听防重复注册：Plugin store 和组件中监听 WS 事件时，必须使用模块级 refCount 保护'"

  - id: 4
    severity: LOW
    location: "spec.md:§AC-B3"
    title: "AC-B3 '刷新'语义模糊——前端刷新还是插件重启？"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:§AC-A2 & §AC-C3"
    title: "AC-A2 与 AC-C3 测试目标重叠"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md:§错误场景覆盖"
    title: "前端 WS 断连时 Plugin Store 缺少连接状态指示"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "spec.md:§FR-B4"
    title: "plugin:messageDecoration 无消息大小/频率限制"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: MUST_FIX
    location: "spec.md:§AC-B2 & §FR-B1 WS 消息扩展"
    title: "plugin.toggle WS 消息被引用但未在协议列表中定义"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 9
    severity: MUST_FIX
    location: "spec.md:§FR-B1 (Pinia Store) & §FR-B1 WS 消息扩展"
    title: "plugin.list WS 消息被引用但未在协议列表中定义"
    status: open
    raised_in_round: 2
    resolved_in_round: null

  - id: 10
    severity: MUST_FIX
    location: "spec.md:§FR-B3 (PluginSettingsForm)"
    title: "plugin.config.get/set WS 消息归属不明确"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2 — Spec 增量审查

## 评审记录
- **评审时间**：2026-05-28 23:30
- **评审类型**：增量计划评审（Spec 完整性，第 2 轮）
- **评审对象**：`.xyz-harness/2026-05-28-plugin-system-frontend-dx/spec.md`
- **模式**：增量审查 — 验证 v1 MUST FIX 修复 + 检查新问题

---

## 1. 上一轮 MUST FIX 修复验证

### ✅ 问题 #1（MUST FIX → 已修复）：plugin:statusBarUpdate 消息名统一

**检查位置**：FR-B1（WS 消息扩展 + 命名风格）+ FR-B4（状态栏）

| 检查项 | 结果 |
|--------|------|
| FR-B1 Server→Client 新增列表 | ✅ `plugin:statusBarUpdate` |
| FR-B1 命名风格章节 | ✅ "现有 AppStatusbar 中的 `plugin:status_bar_update` 需改为 `plugin:statusBarUpdate`" |
| FR-B4 状态栏章节 | ✅ "现有 `plugin:status_bar_update` 事件名需改为 `plugin:statusBarUpdate`" |
| 旧名 `plugin:status_bar_update` 残余 | ✅ 无残余引用（仅出现在"需改为"上下文中做说明） |

**结论**：修复完整，跨章节一致。✓

**检查方法**：逐项对照 FR-B1 WS 消息扩展、命名风格章节、FR-B4 状态栏段落，确认三处均统一使用 `plugin:statusBarUpdate`。

### ✅ 问题 #2（MUST FIX → 已修复）：plugin.executeCommand 添加到协议

**检查位置**：FR-B1（WS 消息扩展）+ FR-B4（状态栏 + SlashMenu）

| 检查项 | 结果 |
|--------|------|
| Client→Server 新增列表 | ✅ `plugin.executeCommand — { pluginId, commandId, args? }` |
| FR-B4 状态栏引用 | ✅ "点击触发插件注册的命令（通过 WS `plugin.executeCommand`）" |
| AC-A4 验收标准 | ✅ "`plugin.executeCommand` WS 消息已定义在 protocol.ts 中" |

**结论**：修复完整。消息定义、前端引用、验收标准三方一致。✓

**注意**：v1 评审中提到的 `plugin.executeSlashCommand` 已在当前 spec 中合并为单一的 `plugin.executeCommand`（通过不同 `commandId` 区分）。这是合理的合并而非遗漏。

### ✅ 问题 #3（LOW → 已修复）：事件监听防重复注册约束

**检查位置**：Constraints 章节

| 检查项 | 结果 |
|--------|------|
| Constraints 新增条目 | ✅ "事件监听防重复注册：Plugin store 和组件中监听 WS 事件时，必须使用模块级 refCount 保护"

**结论**：已按要求添加到 Constraints。✓

---

## 2. 新增 MUST FIX 问题

### 🔴 问题 #8（MUST FIX）：plugin.toggle WS 消息被引用但未在协议列表中定义

**位置**：
- AC-B2 — 明确引用 `plugin.toggle` 作为 WS 消息
- WS 消息格式约定 —在示例中提及 `plugin.toggle` 作为命名规范示例

**现象**：

AC-B2 原文：
> 点击 Toggle 禁用插件 → `plugin.toggle` 发送 → sidecar 返回更新列表 → UI 状态同步

WS 消息格式约定示例：
> Client → Server：点号分隔（`plugin.list`、`plugin.toggle`、`plugin.install`）

但 Client → Server 新增列表中**没有** `plugin.toggle`。当前列表仅包含：
- `plugin.install`
- `plugin.uninstall`
- `plugin.approvePermissions`
- `plugin.revokePermissions`
- `plugin.executeCommand`

**为什么这是问题**：
1. AC-B2 是验收标准，描述了一条完整的测试场景。如果 `plugin.toggle` 不是已定义的 WS 消息，该测试场景无法实现
2. 实现者不确定要发送的消息名——可能猜 `plugin.toggle`、`plugin.enable`/`plugin.disable` 或 `plugin.setEnabled`
3. sidecar 侧的 message handler 必须准确匹配，消息名偏差即功能失效

**修复方向**：
方案 A：在 Client → Server 新增列表中添加 `plugin.toggle — { pluginId: string, enabled: boolean }`。
方案 B：将 AC-B2 改为更明确的 `plugin.enable`/`plugin.disable` 两条消息（但需确认与 FR-B2 Toggle 开关的交互模型匹配）。
方案 C：使用现有 `plugin.executeCommand` 实现，但需在 AC-B2 中同步修改。

**推荐方案 A**，因为：
- 「Toggle」是一个原子操作（用户点一下开关，不区分 enable/disable），对应 `plugin.toggle` 语义最清晰
- 与 WS 消息格式约定中的示例一致
- 与 FR-B1 的 `togglePlugin(id, enabled)` Action 命名一致

### 🔴 问题 #9（MUST FIX）：plugin.list WS 消息被引用但未在协议列表中定义

**位置**：
- FR-B1 Pinia Store 描述 — 明确引用 `plugin.list`
- WS 消息格式约定 —在示例中提及 `plugin.list` 作为命名规范示例

**现象**：

FR-B1 原文：
> 初始化时发送 `plugin.list` 获取插件列表，监听 `config.plugins` 更新

但 Client → Server 新增列表中**没有** `plugin.list`。当前列表只包含插件操作类消息，缺少读取类消息。

**为什么这是问题**：
1. Store 初始化是整个前端插件功能的起点——`plugin.list` 不发送，`config.plugins` 就不会被触发
2. 实现者需要知道 `plugin.list` 是否已由 Phase 2 在 sidecar 侧实现。如果已实现，应标注"已存在于 Phase 2 协议"；如果未实现，应在本期协议扩展中定义

**检查点**：spec 的 "已存在的 Client → Server" 段落写着 "暂无（前端从未发送 plugin 相关消息）"。这明确说明 `plugin.list` **不是**已存在的消息。因此它必须作为新增消息添加。

**修复方向**：
在 Client → Server 新增列表中添加：
- `plugin.list` — `{}`（无参数或空参数）→ 获取已安装插件列表
- 与服务端已有的 `config.plugins` 响应组成 request-response 配对

### 🔴 问题 #10（MUST FIX）：plugin.config.get/set WS 消息归属不明确

**位置**：FR-B3（PluginSettingsForm）

**现象**：

FR-B3 原文：
> 配置值通过 `plugin.config.get/set` WS 命令读写（sidecar → Worker RPC）

问题在于：
1. 如果 `plugin.config.get` / `plugin.config.set` 是**前端到 sidecar 的 WebSocket 消息**，它们**不在** Client → Server 新增列表中（缺失定义）
2. 如果它们是 **sidecar 内部到 Worker 的 RPC 调用**，FR-B3 中 "WS 命令" 的说法会产生误导，让开发者误以为是 WebSocket 消息
3. 无论哪种情况，FR-B3 都没有解释前端的配置读写命令到底是哪个 WS 消息，导致实现者无法确定前端如何与 sidecar 交互

**为什么这是问题**：
- 若开发者按字面理解为 WS 消息去编码（前端发送 `plugin.config.get`），而 sidecar 未实现此 handler，则 AC-B3（修改/刷新/保留配置）无法通过
- 若开发者理解为内部 RPC 而寻找其他 WS 通道，可能写出错误的协议绑定

**修复方向**：

方案 A（若 `plugin.config.get/set` 是 WS 消息）：
1. 在 Client → Server 新增列表中补充：
   - `plugin.config.get` — `{ pluginId: string, keys?: string[] }` → 读取配置（部分或全部）
   - `plugin.config.set` — `{ pluginId: string, values: Record<string, unknown> }` → 写入配置
2. 在 Server → Client 新增列表中补充（如果需要异步通知）：
   - `plugin.config.updated` — `{ pluginId: string, key: string, value: unknown }` → 配置变更推送

方案 B（若 `plugin.config.get/set` 是 sidecar 内部 RPC）：
1. 将 FR-B3 中的 "WS 命令" 改为 "内部 RPC 命令"
2. 说明前端通过哪条 WS 消息与 sidecar 交互来读写配置 —— 例如通过 `plugin.executeCommand` 转发，或通过 `plugin.config.get/set` 作为 WS 消息桥接到 Worker RPC

**推荐方案 A（明确声明为 WS 消息）**，因为前端需要直接读取和写入配置值，这天然适合 request-response 模式的 WS 消息。

---

## 3. 未修复的 LOW / INFO 问题（跨轮次保留）

以下 v1 中标记的 LOW/INFO 问题在当前 spec 版本中仍然存在，建议一并修复以提升 spec 质量：

### ⚠️ 问题 #4（LOW）：AC-B3 "刷新"语义模糊（未修复）

**状态**：当前 spec 的 AC-B3 仍是 "修改值 → 刷新后值保留"

"刷新" 在不同语境下含义不同：
- **页面 F5 刷新**：要求 sidecar 持久化配置（写入磁盘/缓存），刷新后从 sidecar 重新加载
- **插件重新激活**：只要求在插件生命周期内保持，不需要跨进程持久化

建议明确为 "页面刷新后值保留（需 sidecar 侧持久化）" 或 "插件重启后值保留"。

### ⚠️ 问题 #5（LOW）：AC-A2 与 AC-C3 测试目标重叠（未修复）

AC-A2 测试 "阻止生效 + 消息不发送" 场景，AC-C3 测试 "串行化" 场景。两者都使用相同的 executeHooks 串行化功能。

建议明确分层：
- **AC-A2**：端到端功能验证 —— 阻止生效后 LLM 侧未收到消息
- **AC-C3**：质量维度验证 —— 串行执行顺序、超时行为、blocked 链终止

### 📝 问题 #6（INFO）：WS 断连时 Plugin Store 无连接状态指示（未修复）

当前错误场景覆盖了 "前端 WS 断连" 但未建议在前端展示连接状态。建议在 Plugin Store 中增加 `connectionStatus: 'connected' | 'disconnected' | 'reconnecting'` 字段，在 PluginsPane 中以黄色 banner 或 badge 提示。

### 📝 问题 #7（INFO）：plugin:messageDecoration 无大小/频率限制（未修复）

如果某插件频繁推送大量装饰器数据（如 50KB/100ms），前端渲染性能会受影响。建议增加上限约定，或标注 "本期不做限流"。

---

## 4. 发现的问题汇总

| # | 优先级 | 位置 | 描述 | 状态 | 修改方向 |
|---|--------|------|------|------|----------|
| 1 | MUST FIX | 命名章节 + FR-B4 | 消息名矛盾 | ✅ 已修复 | — |
| 2 | MUST FIX | FR-B4 → FR-B1 | executeCommand 未定义 | ✅ 已修复 | — |
| 3 | LOW | Constraints | 防重复注册遗漏 | ✅ 已修复 | — |
| **8** | **MUST FIX** | AC-B2, 命名示例 | **plugin.toggle 被引用但未定义** | **⚠️ 新增** | 加入 Client→Server 列表 |
| **9** | **MUST FIX** | FR-B1 Store | **plugin.list 被引用但未定义** | **⚠️ 新增** | 加入 Client→Server 列表 |
| **10** | **MUST FIX** | FR-B3 | **plugin.config.get/set 归属不明确** | **⚠️ 新增** | 明确 WS 消息或内部 RPC |
| 4 | LOW | AC-B3 | "刷新" 语义模糊 | 未修复 | 明确刷新场景 |
| 5 | LOW | AC-A2/AC-C3 | 测试目标重叠 | 未修复 | 分层明确 |
| 6 | INFO | 错误场景 | 无连接状态指示 | 未修复 | 增加 store 字段 |
| 7 | INFO | FR-B4 | decoration 无限制 | 未修复 | 增加上限约定 |

> **优先级定义**：
> - **MUST FIX**：不修复则评审不通过，会导致实现错误或功能不可用
> - **LOW**：建议修复，但不阻塞流程
> - **INFO**：观察记录，无需操作

---

## 5. 等级判定校准

根据校准规则验证本次 MUST FIX 的合理性：

| 规则 | 涉及问题 | 符合性 |
|------|---------|--------|
| 1. 数据丢失 | 问题 9：plugin.list 缺失 → store 无法加载插件列表 | ✅ MUST FIX |
| 2. 功能失效 | 问题 8：plugin.toggle 缺失 → AC-B2 无法实现 | ✅ MUST FIX |
| 2. 功能失效 | 问题 10：config.get/set 不明确 → 配置读写两条路径都可能出错 | ✅ MUST FIX |
| 3-5 | 不适用 | — |

**判断口诀验证**：三个问题在生产环境都会导致功能不可用（列表加载失败、切换操作失败、配置读写失败），因此 MUST FIX 判定正确。

---

## 6. 结论

**需修改后重审**（verdict: fail）。

**上一轮修复评估**：
- 3 条 MUST FIX 全部通过 ✓ — 修复完整性、一致性均良好
- 跨章节命名统一，无残余旧名引用 ✓
- 新增的 `plugin.executeCommand` 从协议定义到验收标准全覆盖 ✓
- 防重复注册约束已集成到 Constraints ✓

**新增问题**：
- 3 条新的 MUST FIX —— 均为协议定义缺失或不明确，修复成本低：
  - `plugin.toggle` 需加入 Client → Server 列表（问题 #8）
  - `plugin.list` 需加入 Client → Server 列表（问题 #9）
  - `plugin.config.get/set` 需明确归属并补全协议定义（问题 #10）
- 4 条 LOW/INFO 从 v1 继承未修复（不阻塞流程）

**修复后预期下一轮可以 pass**。

### Summary

Spec 增量评审完成，第2轮，3条MUST FIX（新增），需修改后重审。上一轮3条MUST FIX全部通过验证，新增问题均为协议定义层缺失，修复明确且成本低。
