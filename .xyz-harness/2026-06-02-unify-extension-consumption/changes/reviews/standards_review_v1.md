---
verdict: fail
must_fix: 2
---

# Standards Review v1 — Unify Extension Consumption

**审查范围**: `a3b1ea4..HEAD` (50 files, +1302 / -7092)
**审查日期**: 2026-06-02
**审查依据**: CLAUDE.md 编码规范 + 项目自动化检查

---

## Phase A: 自动化检查结果

### 1. Runtime 测试 (vitest)

| 指标 | 结果 |
|------|------|
| 通过 | 51 files / 551 tests |
| 失败 | 1 file / 3 tests |

**失败详情**: `test/plugin-worker-rebuild.test.ts` — 3 个 assertion 失败（crash count 预期 1 实际 0）。该文件**不在本次 diff 范围内**，属于预存问题，不阻塞本次合入。

### 2. 前端类型检查 (vue-tsc --noEmit)

✅ **通过** — 零错误

### 3. ESLint

| 指标 | 结果 |
|------|------|
| errors | 0 |
| warnings | 98 |

warnings 全部为 `no-magic-numbers`、`taste/no-silent-catch`、`max-lines`，均为 runtime 侧预存问题，不在本次新增范围内。本次新增文件无 ESLint 错误或 warning。

---

## Phase B: CLAUDE.md 编码规范逐项审查

### ✅ 通过项

| 规则 | 状态 | 说明 |
|------|------|------|
| **禁止 `any`** | ✅ | diff 中未发现 `any` 类型使用 |
| **禁止原生 HTML 表单元素** | ✅ | 新增 Vue 文件无 `<button>`/`<input>`/`<select>` 等原生元素 |
| **禁止 Emoji** | ✅ | diff 中无 emoji |
| **禁止硬编码颜色** | ✅ | 全部使用 CSS 变量引用（`text-muted`、`bg-surface`、`border-border` 等） |
| **禁止魔数间距** | ✅ | 使用标准 Tailwind scale（`px-3`、`py-1.5`、`gap-2` 等） |
| **Tailwind 样式三层结构** | ✅ | 无 `<style scoped>`，全部 Tailwind 工具类，无 `@apply` |
| **xyz-ui 组件** | ✅ | 无需 UI 组件的场景（展示型 `<span>`/`<div>`/`<ul>` 不属于表单元素） |
| **行数上限** | ✅ | 所有新增/变更 Vue 文件在限制内（ChatPanel 261 行 / PanelSessionView 274 行 / 其余均 < 100 行） |
| **emit 单对象 payload** | ✅ | diff 中无 emit 调用 |
| **refCount 保护** | ✅ | `useExtensionWidget.ts` 正确实现模块级 `refCount` 防重复注册（Rule #2） |
| **Session 隔离 (Rule #7)** | ✅ | 所有 extension 事件都带 `sessionId`，前端按 `props.sessionId` 过滤 widget/status |
| **数据目录隔离 (Rule #10)** | ✅ | ExtensionResolver 使用 `~/.xyz-agent/` 路径，不读写 `~/.pi/agent/` |
| **Promise.allSettled** | ✅ | diff 中无独立的并行数据源请求场景 |
| **border-radius** | ✅ | 使用 `rounded-sm`（1px），符合规范 |

### ❌ 未通过项

#### MUST-FIX 1: ExtensionStatusBar.vue 是死代码

**文件**: `src-electron/renderer/src/components/extension/ExtensionStatusBar.vue`
**问题**: 该组件已创建但**整个项目无任何文件 import 或引用它**（grep 确认零匹配）。AppStatusbar.vue 中直接内联了相同的 status 渲染逻辑（`<span class="inline-flex items-center gap-1 text-[10px] text-muted">`），未使用此组件。
**违反**: CLAUDE.md §General "不加推测性功能" — 未被使用的代码不应合入
**修复**: 删除 `ExtensionStatusBar.vue`，或将 AppStatusbar.vue 中的内联 status 渲染替换为该组件

#### MUST-FIX 2: ExtensionResolver 返回目录路径 vs 旧代码返回文件路径 — 行为变更未充分验证

**文件**: `src-electron/runtime/src/extension-resolver.ts`
**问题**: 旧的 `getExtensionPaths()` 返回 **index.ts/index.js 文件路径**（如 `/path/to/goal/index.ts`），新的 ExtensionResolver 返回**目录路径**（如 `/path/to/goal`）。

pi 的 `loadExtensionModule()` 使用 jiti 加载：`jiti.import(extensionPath)`。jiti 对目录路径会自动查找 `index.ts`/`index.js`，理论上可行。但这是一个**行为变更**，且：
1. `ExtensionResolver` 的单元测试只验证了返回目录名，未验证 jiti 能否正确解析这些目录路径
2. 旧代码对 `extensionPath`（`xyz-agent-extension.js`）是文件路径，与 ExtensionResolver 返回的目录路径混合在同数组中传给 pi，两种路径类型混用
3. npm extension 的路径结构可能不包含 `index.ts`（npm publish 后可能是 `dist/index.js` 或其他入口），ExtensionResolver 未检查实际入口文件是否存在

**违反**: CLAUDE.md Rule #4 "外部系统对接先验证再编码" — 应先用验证脚本确认 jiti 对目录路径 + npm 包目录的解析行为
**修复建议**:
- Option A: ExtensionResolver 增加入口文件查找逻辑（与旧代码一致），返回文件路径
- Option B: 编写 `tools/verify-extension-resolver.cjs` 验证 jiti 对各类路径的解析，确认目录路径可行后保留当前设计

---

## 建议项（不阻塞合入）

### ADVISORY 1: electron-builder.yml 硬编码了传递依赖

`electron-builder.yml` 新增了 `js-yaml` 和 `argparse` 作为 `extraResources`：
```yaml
- from: node_modules/js-yaml
  to: node_modules/js-yaml
- from: node_modules/argparse
  to: node_modules/argparse
```
这些是 pi-ext 的传递依赖。如果依赖变更（新增/移除），需手动同步此文件。建议在 preflight 脚本中增加自动化校验（第 8 步已部分覆盖，但 extraResources 的 from 列表仍是手动的）。

### ADVISORY 2: preflight-check.sh 编号不一致

注释中写 `# 7.` `# 8.` `# 9.`，但早期步骤显示 `[1/9]` 到 `[6/9]`，第 5 步 echo 显示 `[5/7]`（应为 `[5/9]`）。编号不连续，不影响功能但影响可读性。

---

## 变更文件清单（本次 diff 范围）

### 新增文件
| 文件 | 行数 | 规范状态 |
|------|------|---------|
| `extension-resolver.ts` | 192 | ⚠️ MUST-FIX 2 |
| `ExtensionStatusBar.vue` | 12 | ❌ MUST-FIX 1（死代码） |
| `ExtensionWidgetPanel.vue` | 36 | ✅ |
| `useExtensionWidget.ts` | 40 | ✅ |
| `extension.ts` (shared) | 16 | ✅ |
| `extension-resolver.test.ts` | 309 | ✅ |
| `event-adapter-bridge.test.ts` | 139 | ✅ |

### 变更文件
| 文件 | 规范状态 |
|------|---------|
| `event-adapter.ts` | ✅ |
| `session-service.ts` | ✅ |
| `AppStatusbar.vue` | ✅ |
| `ChatPanel.vue` | ✅ |
| `PanelSessionView.vue` | ✅ |
| `protocol.ts` | ✅ |
| `index.ts` (shared) | ✅ |
| `electron-builder.yml` | ✅ (advisory) |
| `package.json` | ✅ |
| `preflight-check.sh` | ✅ (advisory) |

### 删除文件
Bundled extensions（goal/todo/workflow）从 `resources/pi/agent/extensions/` 删除，迁移为 npm 包消费。✅ 符合统一消费的目标。
