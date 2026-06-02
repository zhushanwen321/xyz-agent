---
verdict: fail
must_fix: 1
review_metrics:
  files_reviewed: 12
  boundaries_checked: 8
  issues_found: 4
  must_fix_count: 1
  low_count: 2
  info_count: 1
  duration_estimate: "30"
---

# Integration Review v1

## 审查记录
- 审查时间：2026-06-02 23:40
- 上游 BLR: business_logic_review_v1.md
- 模块边界点数：8
- 模拟数据验证路径数：5

## 边界检查矩阵

| UC 编号 | 边界点 | D1 格式转换 | D2 错误传播 | D3 契约一致 | D4 前后端 | 问题 |
|---------|--------|------------|------------|------------|----------|------|
| UC-1 | ExtensionResolver → session-service → rpc-client | ✅ | ✅ | ⚠️ | — | 文件型 extension 被丢弃 |
| UC-2 | npm package.json → ExtensionResolver key | ✅ | — | ✅ | — | 短名提取已修复 |
| UC-3 | ExtensionResolver → rpc-client --extension | ✅ | — | ✅ | — | 目录路径 pi 可接受 |
| UC-4 | event-adapter → WS broadcast → useExtensionWidget | ✅ | ✅ | ✅ | ✅ | — |
| UC-4 | useExtensionWidget → PanelSessionView → ChatPanel | ✅ | — | ✅ | ✅ | — |
| UC-4 | shared/extension.ts 类型一致性 | ✅ | — | ✅ | — | — |
| UC-5 | electron-builder extraResources → scanNpmExtensions | ✅ | — | ✅ | — | 传递依赖硬编码 |
| UC-5 | scanDirectory bundled → 无 entry 校验 | ⚠️ | — | ✅ | — | 旧代码校验 index.ts 现已移除 |

## 问题清单

### MUST_FIX

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 1 | MUST_FIX | UC-1 | session-service → ExtensionResolver | D3 | `scanUserExtensions()` 检查 `isDirectory()` 导致单文件 extension（`xyz-agent-extension.js`）被静默丢弃 | `extension-resolver.ts` | L152 | `scanUserExtensions` 需同时接受文件和目录路径。文件直接加入结果 Map，跳过目录名校验。或者在 `session-service.getExtensionPaths()` 中将文件路径直接追加到 `result.extensionDirs`，不经过 resolver |

### LOW

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 2 | LOW | UC-5 | electron-builder.yml | D1 | 传递依赖 `js-yaml`、`argparse` 硬编码在 extraResources 中。若 pi-ext 新增非 `@zhushanwen/` scope 的运行时依赖，此处不会自动更新 | `electron-builder.yml` | L57-61 | 与 BLR LOW #3 相同。建议构建时动态扫描或添加 CI check |
| 3 | LOW | UC-1 | ExtensionResolver → bundled | D1 | `scanDirectory()` 不再校验 entry 文件（index.ts/index.js）是否存在，直接返回目录名。旧代码会检查 entry 并跳过无效目录 | `extension-resolver.ts` | L173-181 | 若 pi 对空目录的 `--extension` 报错，可考虑恢复 entry 校验。若 pi 静默忽略则当前行为可接受 |

### INFO

| # | 严重度 | UC | 边界点 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-----|--------|------|------|------|------|---------|
| 4 | INFO | UC-4 | AppStatusbar ← useExtensionWidget | D4 | `AppStatusbar` 显示所有 session 的 extension status 不做 sessionId 过滤。多 session 并行时可能显示非活跃 session 的状态 | `AppStatusbar.vue` | L63-66 | 当前设计为全局状态栏，若需 session 隔离可在后续迭代中过滤 |

## 模拟数据验证详情

### UC-1: extensionDirs 传递 — session-service → rpc-client

**模拟数据：** `extensionPath = "/app/Resources/xyz-agent-extension.js"`（文件路径）

**旧代码路径：**
```
getExtensionPaths():
  if (this.extensionPath && existsSync(this.extensionPath)) {
    paths.push(this.extensionPath)  → 直接追加，无 isDirectory 检查
  }
  → paths = ["/app/Resources/xyz-agent-extension.js", ...]
  → rpc-client: --extension /app/Resources/xyz-agent-extension.js
```

**新代码路径：**
```
getExtensionPaths():
  userExtPaths = ["/app/Resources/xyz-agent-extension.js"]
  resolver.resolve(projectRoot, packaged, userExtPaths):
    scanUserExtensions(userExtPaths):
      statSync("/app/Resources/xyz-agent-extension.js").isDirectory() → false
      → continue (SKIP!)
      → result: Map(0) ← 文件被丢弃
  → extensionDirs 不含 xyz-agent-extension.js
  → rpc-client: 不传 --extension xyz-agent-extension
  → ❌ xyz-agent 的 navigate extension 丢失
```

**结论：** MUST_FIX。文件型 extension 在 resolver 中被静默丢弃。回归 bug。

---

### UC-2: npm key 去重 — ExtensionResolver 内部

**模拟数据：**
```json
{
  "npm": { "pkg.name": "@zhushanwen/pi-goal", "dir": "node_modules/@zhushanwen/pi-goal" },
  "third_party": { "entry": "pi-goal", "dir": "~/.xyz-agent/pi/agent/extensions/pi-goal" }
}
```

**执行路径：**
```
scanNpmExtensions():
  entry = "pi-goal", pkg.name = "@zhushanwen/pi-goal"
  shortName = "pi-goal".replace(/^@[^/]+\//, '') = "pi-goal"
  extName = "pi-goal" ✅

scanThirdPartyExtensions():
  scanDirectory() → result.set("pi-goal", path) ✅

deduplicate():
  sorted: npm(priority=0) first, third-party(priority=2) second
  merged.set("pi-goal", npm_path)     ← first write
  merged.has("pi-goal") → true → SKIP third-party
  → 去重成功 ✅
```

**结论：** BLR MUST_FIX #2 已修复。key 语义统一为短名 `pi-goal`。

---

### UC-3: ExtensionResolver 返回值 → rpc-client --extension

**模拟数据：** `extensionDirs = ["/app/node_modules/@zhushanwen/pi-goal", "/app/node_modules/@zhushanwen/pi-subagent"]`

**执行路径：**
```
session-service.getExtensionPaths():
  → result.extensionDirs = ["/app/node_modules/@zhushanwen/pi-goal", ...]
  → return extensionDirs

session-service.create():
  allExtPaths = [...bundleExtPaths, ...userExtPaths]
  → client = pm.createSession(id, cwd, { extensionPaths: allExtPaths })

rpc-client:
  if (this.options.extensionPaths?.length):
    for extPath of this.options.extensionPaths:
      args.push('--extension', extPath)
  → pi --extension /app/node_modules/@zhushanwen/pi-goal ✅
```

**结论：** 目录路径传递正确。pi 的 `--extension` 接受目录，内部通过 `discoverExtensionsInDir` 扫描 entry。

---

### UC-4: setWidget 事件 — event-adapter → WS → useExtensionWidget

**模拟数据：**
```json
{
  "pi_event": { "type": "extension_ui_request", "method": "setWidget", "key": "goal", "lines": ["Task 1: in_progress"] },
  "session_id": "sess-abc"
}
```

**执行路径（逐边界验证）：**

**边界 1: event-adapter 构造 payload**
```
case 'extension_ui_request':
  method === 'setWidget' ✅
  widgetType = EXTENSION_EVENTS.WIDGET = 'extension.widget'
  this.send({
    type: 'extension.widget',
    payload: {
      sessionId: "sess-abc",       ← 来自 this.sessionId
      widgetKey: String("goal"),   ← event.key
      lines: ["Task 1: in_progress"].map(String)  ← Array.isArray check ✅
    }
  })
  → 与 ExtensionWidgetPayload { sessionId, widgetKey, lines } 完全匹配 ✅
```

**边界 2: WsSender → WS broadcast**
```
this.send(msg) → interceptor.send(msg) → interceptor.downstream(msg) → server.broadcast(msg)
  → msg.type = 'extension.widget' ∈ ServerMessageType ✅（protocol.ts L175 已声明）
  → broadcast → 所有 WS 客户端收到
```

**边界 3: ws-client → event-bus**
```
ws.onmessage → JSON.parse → emit(msg.type, msg)
  → emit('extension.widget', { type: 'extension.widget', payload: { sessionId, widgetKey, lines } })
```

**边界 4: useExtensionWidget handler**
```
on('extension.widget', onWidget)
  → onWidget({ payload: { sessionId: "sess-abc", widgetKey: "goal", lines: [...] } })
  → p?.sessionId = "sess-abc" ✅, p?.widgetKey = "goal" ✅
  → widgets.value.set("goal", payload)
```

**边界 5: PanelSessionView 过滤**
```
sessionWidgets computed:
  for w of allWidgets.values():
    if (w.sessionId === props.sessionId) → 按当前 session 过滤 ✅
  → 传递给 ChatPanel as extensionWidgets prop
```

**边界 6: ChatPanel 渲染**
```
<ExtensionWidgetPanel v-for="w in extensionWidgets" :widget-key="w.widgetKey" :lines="w.lines" />
  → props 类型 { widgetKey: string, lines: string[] } 与 ExtensionWidgetPayload 匹配 ✅
```

**结论：** setWidget 链路完整，D1/D2/D3/D4 全部通过。setStatus 链路结构对称，同样通过。

---

### UC-5: 打包模式 — extraResources → scanNpmExtensions

**模拟数据：** `packaged = true, cwd = process.resourcesPath = "/app/xyz-agent.app/Contents/Resources/"`

**执行路径：**
```
electron-builder:
  extraResources:
    from: node_modules/@zhushanwen → to: node_modules/@zhushanwen
    from: node_modules/js-yaml → to: node_modules/js-yaml
    from: node_modules/argparse → to: node_modules/argparse
  → 产物: Resources/node_modules/@zhushanwen/pi-goal/, Resources/node_modules/js-yaml/ 等

runtime 启动 (packaged):
  projectRoot = process.resourcesPath = Resources/
  scanNpmExtensions(Resources/):
    scopeDir = Resources/node_modules/@zhushanwen/ ✅ (extraResources 已复制)
    读取 pi-goal/package.json → pkg.name = "@zhushanwen/pi-goal"
    shortName = "pi-goal"
    result.set("pi-goal", "Resources/node_modules/@zhushanwen/pi-goal") ✅
  → npm extension 加载成功
```

**异常场景：传递依赖缺失**
```
若某 pi-ext 运行时 require('js-yaml'):
  → 查找路径: Resources/node_modules/js-yaml ✅ (extraResources 已包含)
  → 若未来新增了非 @zhushanwen/ scope 的依赖:
    → extraResources 未包含 → require 失败
    → preflight-check.sh step 8 会检测但不会自动修复
```

**结论：** extraResources 路径映射正确。传递依赖硬编码问题已在 BLR 中记录（LOW）。

## 结论

**verdict: fail**，1 条 MUST FIX。

**MUST_FIX #1（回归 bug）：** `ExtensionResolver.scanUserExtensions()` 的 `isDirectory()` 检查导致文件型 extension（`xyz-agent-extension.js`）被静默丢弃。旧代码直接将 `this.extensionPath` 追加到结果数组，无 `isDirectory` 校验。这是一个功能性回归——打包后 xyz-agent 的 navigate extension 将丢失。

**修复方向（二选一）：**
- **方案 A（推荐）**：在 `session-service.getExtensionPaths()` 中，对 `this.extensionPath` 单独处理——直接追加到 `result.extensionDirs`，不传入 resolver：
  ```typescript
  const dirs = result.extensionDirs
  if (this.extensionPath && existsSync(this.extensionPath)) {
    dirs.push(this.extensionPath)
  }
  return dirs
  ```
- **方案 B**：在 `scanUserExtensions()` 中移除 `isDirectory()` 限制，同时接受文件和目录路径。

BLR 报告的 MUST_FIX #1（piExtension guard）和 MUST_FIX #2（去重 key）在当前代码中已修复——`scanNpmExtensions` 不再检查 `piExtension` 字段，且 key 统一为短名。
