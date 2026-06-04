---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 14
  issues_found: 4
  must_fix_count: 2
  low_count: 1
  info_count: 1
  duration_estimate: "45"
---

# Dev Business Logic Review v1

## 审查记录
- 审查时间：2026-06-02 22:30
- 审查模式：Dev（L1 + L2）
- 审查对象：use-cases.md + git diff a3b1ea4..HEAD
- 模拟数据路径数：5

## UC 覆盖追踪

| UC 编号 | UC 名称 | 覆盖状态 | 执行路径 | 发现的问题 |
|---------|---------|---------|----------|-----------|
| UC-1 | 用户升级 Extension 版本 | ❌ 阻断 | npm install → scanNpmExtensions → **piExtension guard 阻断所有包** | MUST_FIX #1 |
| UC-2 | 用户安装第三方 Extension | ⚠️ 部分 | git clone → scanThirdPartyExtensions → deduplicate | 去重 key 不匹配（LOW #1） |
| UC-3 | 开发者修复 Extension Bug 并验证 | ❌ 阻断 | 同 UC-1 路径 | 同 MUST_FIX #1 |
| UC-4 | Extension UI 数据到达前端 | ✅ 完整 | pi setWidget → event-adapter → WS → useExtensionWidget → Panel | — |
| UC-5 | 打包产物验证 | ⚠️ 部分 | extraResources → Resources/node_modules | npm 包无 piExtension 字段，打包后扫描失败（MUST_FIX #1 附带） |

## 问题清单

| # | 严重度 | UC 编号 | 描述 | 文件 | 行号/位置 | 修改建议 |
|---|--------|---------|------|------|----------|---------|
| 1 | MUST_FIX | UC-1,UC-3 | `scanNpmExtensions()` 检查 `pkg.piExtension` 字段，但所有 12 个 `@zhushanwen/pi-*` 包均无此字段，导致 npm 源返回空 Map | `extension-resolver.ts` | L89 | 方案 A（推荐）：删除 `piExtension` guard——`@zhushanwen/pi-*` scope + `pi-` 前缀已足够区分。方案 B：给所有 12 个包加 `"piExtension": true` |
| 2 | MUST_FIX | UC-2 | npm 与 bundled/third-party 的去重 key 语义不同：npm 用 `pkg.name`（如 `@zhushanwen/pi-goal`），bundled/third-party 用目录名（如 `goal`）。同名 extension 不会被去重 | `extension-resolver.ts` | L88 vs L141 | 统一 key 语义：bundled/third-party 的 key 应去掉 `pi-` 前缀后与 npm 的 `entry`（`pi-*` 部分的 `*`）比较，或反过来让 npm 用去掉 `@zhushanwen/` 前缀后的短名作 key |
| 3 | LOW | UC-5 | `electron-builder.yml` 硬编码了 `js-yaml` 和 `argparse` 作为传递依赖，但 preflight-check.sh 是动态扫描。若 pi-ext 新增非 `@zhushanwen/` scope 的依赖，electron-builder.yml 不会自动更新 | `electron-builder.yml` | L54-57 | 将传递依赖扫描结果写入构建时生成的 electron-builder 补充配置，或添加 CI check 验证 electron-builder.yml 与实际传递依赖一致 |
| 4 | INFO | UC-5 | spec FR-3.1 列出了 `@zhushanwen/pi-vision`，但 `package.json` 和 `node_modules/` 中均未包含 | `src-electron/package.json` | — | 若确认 pi-vision 暂不需要，从 spec FR-3.1 中移除 |

## 执行路径详情（Dev 模式）

### UC-1: 用户升级 Extension 版本

**模拟数据：**
```json
{
  "uc_id": "UC-1",
  "scenario": "npm update @zhushanwen/pi-goal 后重启",
  "input_data": {
    "npm_package": "@zhushanwen/pi-goal",
    "installed_path": "src-electron/node_modules/@zhushanwen/pi-goal",
    "package_json": {
      "name": "@zhushanwen/pi-goal",
      "main": "src/index.ts",
      "piExtension": "<undefined>"
    }
  }
}
```

**执行路径：**
```
SessionService.create()
  → getExtensionPaths()
    → new ExtensionResolver().resolve(projectRoot, false, [])
      → scanNpmExtensions(projectRoot)
        → readdirSync("node_modules/@zhushanwen/") → ["pi-goal", "pi-todo", ...]
        → for pi-goal:
          → readFileSync("pi-goal/package.json") → { name: "@zhushanwen/pi-goal" }
          → check: pkg.piExtension → undefined → falsy
          → ❌ continue (SKIP!)
        → result: Map(0) ← 空！所有 npm 包被跳过
      → scanBundledExtensions → Map(3) [hooks, subagent, usage-tracker]
      → scanThirdPartyExtensions → Map(0)
      → deduplicate → 最终只有 bundled 的 3 个 extension
  → extensionDirs: [hooks, subagent, usage-tracker 的目录路径]
  → pi 启动: --extension hooks --extension subagent --extension usage-tracker
  → ❌ pi-goal/pi-todo/pi-workflow 未被加载
```

**异常路径：**
```
若第三方用户手动 clone pi-goal 到 ~/.xyz-agent/pi/agent/extensions/pi-goal:
  → scanThirdPartyExtensions() → key="pi-goal"
  → scanNpmExtensions() → 空（piExtension guard）
  → 去重后只有 third-party 的 pi-goal
  → 能工作但绕过了 npm 版本管理，与 spec 设计矛盾
```

**结论：** 主路径断裂。`piExtension` guard 是致命 bug，阻断所有 npm extension 加载。

---

### UC-2: 用户安装第三方 Extension

**模拟数据：**
```json
{
  "uc_id": "UC-2",
  "scenario": "git clone pi-goal 到第三方目录，同时 npm 有 @zhushanwen/pi-goal",
  "input_data": {
    "npm_ext": { "key": "@zhushanwen/pi-goal", "path": "/project/node_modules/@zhushanwen/pi-goal" },
    "third_party_ext": { "key": "pi-goal", "path": "/home/user/.xyz-agent/pi/agent/extensions/pi-goal" }
  },
  "expected": "npm 版本优先，third-party 版本被去重忽略"
}
```

**执行路径：**
```
scanNpmExtensions() → Map { "@zhushanwen/pi-goal" → "/npm/pi-goal" }  (假设 MUST_FIX #1 修复后)
scanThirdPartyExtensions() → Map { "pi-goal" → "/third-party/pi-goal" }
deduplicate():
  sorted by priority: [npm("@zhushanwen/pi-goal"), third-party("pi-goal")]
  merged.set("@zhushanwen/pi-goal", "/npm/pi-goal")  ← key 1
  merged.set("pi-goal", "/third-party/pi-goal")      ← key 2
  → 结果: Map(2)，两个都保留！
  → ❌ 去重失败：key 不同导致两个 pi-goal 都被加载
```

**异常路径：**
```
两个同名 extension 都传给 pi → pi 加载两次 pi-goal
  → tool 重复注册或行为不可预测
```

**结论：** 去重机制因 key 语义不一致而失效。spec AC-2（"只加载 npm 版本，第三方版本被忽略"）不满足。

---

### UC-3: 开发者修复 Extension Bug 并验证

**模拟数据：**
```json
{
  "uc_id": "UC-3",
  "scenario": "npm install @zhushanwen/pi-goal@0.2.1-beta.0 后 npm run dev",
  "input_data": {
    "version": "0.2.1-beta.0",
    "expected_tools": ["goal_manager"]
  }
}
```

**执行路径：**
```
同 UC-1 路径。
npm install 新版本 → package.json 更新 → 但 piExtension 字段仍不存在
→ scanNpmExtensions 跳过该包
→ ❌ 开发者无法验证修复
```

**结论：** 与 UC-1 同根因。

---

### UC-4: Extension UI 数据到达前端

**模拟数据：**
```json
{
  "uc_id": "UC-4",
  "scenario": "goal extension 调用 ctx.ui.setWidget('goal', ['Task 1: in_progress'])",
  "input_data": {
    "pi_event": {
      "type": "extension_ui_request",
      "method": "setWidget",
      "key": "goal",
      "lines": ["Task 1: in_progress", "Task 2: pending"]
    },
    "expected_ws_event": {
      "type": "extension.widget",
      "payload": {
        "sessionId": "sess-abc",
        "widgetKey": "goal",
        "lines": ["Task 1: in_progress", "Task 2: pending"]
      }
    }
  }
}
```

**执行路径：**
```
pi extension: ctx.ui.setWidget("goal", ["Task 1: in_progress", "Task 2: pending"])
  → pi RPC: extension_ui_request { method: "setWidget", key: "goal", lines: [...] }
  → EventAdapter.translate()
    → case 'extension_ui_request':
      → method === 'setWidget' ✅
      → this.send({ type: 'extension.widget', payload: { sessionId, widgetKey: "goal", lines: [...] } })
  → WS broadcast
  → useExtensionWidget.ts:
    → on('extension.widget', onWidget)
    → onWidget: p.widgetKey = "goal", p.sessionId = "sess-abc" ✅
    → widgets.value.set("goal", payload)
  → PanelSessionView.vue:
    → sessionWidgets computed: filter by props.sessionId → [goal widget]
  → ChatPanel.vue:
    → <ExtensionWidgetPanel widget-key="goal" :lines="['Task 1: in_progress', 'Task 2: pending']" />
    → 渲染可折叠面板 ✅
```

**异常路径：**
```
setWidget 无 key/lines:
  → widgetKey: String(event.key ?? '') → ""
  → lines: Array.isArray(undefined) ? [] : ... → []
  → onWidget: p.widgetKey = "" → falsy → return (跳过)
  → ✅ 防御性处理正确
```

**setStatus 路径：**
```
pi extension: ctx.ui.setStatus("goal", "3/5 tasks completed")
  → EventAdapter:
    → onStatusSetUpdate callback 调用 ✅
    → send({ type: 'extension.status', payload: { sessionId, statusKey: "goal", text: "3/5 tasks completed" } })
  → AppStatusbar.vue:
    → extStatuses → extStatusItems → 渲染 <span>{{ text }}</span> ✅
  → ChatPanel.vue:
    → extensionStatuses → 底部状态栏渲染 ✅
```

**结论：** setWidget/setStatus 桥接链路完整，从前端到渲染各环节通畅。

---

### UC-5: 打包产物验证

**模拟数据：**
```json
{
  "uc_id": "UC-5",
  "scenario": "npm run build 后验证 DMG 产物中 pi-ext 可用",
  "input_data": {
    "packaged_mode": true,
    "cwd": "process.resourcesPath",
    "extraResources_copies": [
      "node_modules/@zhushanwen/ → Resources/node_modules/@zhushanwen/",
      "node_modules/js-yaml/ → Resources/node_modules/js-yaml/",
      "node_modules/argparse/ → Resources/node_modules/argparse/"
    ]
  }
}
```

**执行路径：**
```
npm run build:
  → electron-builder processes electron-builder.yml
  → extraResources:
    → from: node_modules/@zhushanwen → to: Resources/node_modules/@zhushanwen ✅
    → from: node_modules/js-yaml → to: Resources/node_modules/js-yaml ✅
    → from: node_modules/argparse → to: Resources/node_modules/argparse ✅

runtime 启动 (packaged):
  → cwd = process.resourcesPath
  → projectRoot = process.cwd() = Resources/
  → getExtensionPaths():
    → isPackaged = true
    → scanNpmExtensions(Resources/):
      → scopeDir = Resources/node_modules/@zhushanwen ✅ (extraResources 复制到此)
      → 读取各 pi-* 包 → pkg.piExtension → undefined → ❌ 全部跳过
    → scanBundledExtensions(Resources/, true):
      → packaged=true → return empty ✅ (正确，bundled 由 migrateToPiSubdir 同步)
    → scanThirdPartyExtensions():
      → ~/.xyz-agent/pi/agent/extensions/ (由 migrateToPiSubdir 从 Resources 同步)
      → subagent, hooks, usage-tracker (bundled 通过 migrateToPiSubdir 到达此目录)
    → 结果: 只有 third-party (ex-bundled) 的 3 个 extension，无 npm 包
  → ❌ npm extension 全部缺失

preflight-check.sh:
  → step 7: 扫描 node_modules/@zhushanwen/pi-*/package.json ✅
  → 验证 main 入口文件存在 ✅
  → step 8: 检查传递依赖 ✅
  → 但不检查 piExtension 字段（guard 只在 runtime 时生效）
```

**结论：** 打包路径本身正确（extraResources 配置合理），但受 MUST_FIX #1 影响，打包后 npm 包仍不会被 scanNpmExtensions 加载。

---

## AC 覆盖验证

| AC | 描述 | 状态 | 说明 |
|----|------|------|------|
| AC-1 | Extension 加载无回归 | ❌ | npm 包全被 piExtension guard 跳过 |
| AC-2 | 去重无冲突 | ❌ | key 语义不一致导致去重失效 |
| AC-3 | 第三方 extension 依赖解析 | ✅ | 传目录路径，pi discoverExtensionsInDir + jiti 解析 |
| AC-4 | setWidget 数据到达前端 | ✅ | event-adapter → WS → useExtensionWidget → Panel 完整 |
| AC-5 | setStatus 数据到达前端 | ✅ | event-adapter → WS → AppStatusbar + ChatPanel 完整 |
| AC-6 | 打包产物包含 npm extension | ⚠️ | extraResources 配置正确，但运行时扫描被 guard 阻断 |
| AC-7 | bundled 副本已删除 | ✅ | git diff 确认 goal/todo/workflow 目录已删除 |
| AC-8 | 现有 subagent/usage-tracker/hooks 不受影响 | ✅ | bundled → migrateToPiSubdir → third-party 路径不受影响 |

## 结论

**2 条 MUST FIX**，verdict = **fail**。

1. **MUST_FIX #1（阻断级）**：`piExtension` guard 使所有 npm extension 源失效。测试通过是因为 mock 数据设置了 `piExtension: true`，但真实包无此字段。这是 UC-1/UC-3/UC-5 的共同根因。推荐直接删除 guard——`@zhushanwen/pi-*` scope + `pi-` 前缀已是充分条件。

2. **MUST_FIX #2（功能级）**：去重 key 语义不一致。npm 用全限定名 `@zhushanwen/pi-goal`，bundled/third-party 用短名 `pi-goal`。两者永远不会碰撞，AC-2 无法满足。修复方向：统一为短名（`pi-goal`）或统一为全限定名。
