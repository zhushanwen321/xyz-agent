---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-02T18:30:00"
  target: ".xyz-harness/2026-06-02-unify-extension-consumption/spec.md"
  verdict: pass
  summary: "Spec 评审第 2 轮，2 条 MUST_FIX 均已修复，0 条新 MUST_FIX，2 条新 LOW（文档回归），通过"

statistics:
  total_issues: 10
  must_fix: 0
  must_fix_resolved: 2
  low: 3
  low_resolved: 3
  info: 0
  info_resolved: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-2.1 + FR-4.2/FR-4.3"
    title: "discoverExtensionsInDir 无法发现 dist/index.js 入口"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-7.1/FR-7.2"
    title: "打包未覆盖 npm 包传递依赖，pi 子进程无法 resolve"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "spec.md:FR-1.3 + FR-1.4"
    title: "第三方目录与用户安装目录职责重叠"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md:FR-4 (整体)"
    title: "跨项目协调计划缺失（pi-ext 构建→发布→xyz-agent 安装）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "spec.md:FR-5.3"
    title: "WS 事件类型定义文件位置用'或'表述，不够明确"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: LOW
    location: "spec.md:整体"
    title: "Extension 加载失败的错误处理场景缺失"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 7
    severity: INFO
    location: "spec.md:AC-1"
    title: "'行为完全一致' 缺乏可量化的验证方法"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 8
    severity: INFO
    location: "spec.md:FR-6 + FR-8"
    title: "FR-8 排除了 ctx.ui.custom() 但未说明对第三方 extension 的 UI 影响范围"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 9
    severity: LOW
    location: "spec.md:FR-1.7 + FR-5.3"
    title: "extension.error 事件类型未在 FR-5.3 中定义"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 10
    severity: LOW
    location: "spec.md:FR-2.1"
    title: "FR-2.1 描述与 FR-4.4 修复后的实际行为不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null

---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-06-02 18:30
- 评审类型：Spec 评审（增量审查，第 2 轮）
- 评审对象：`.xyz-harness/2026-06-02-unify-extension-consumption/spec.md`

## v1 MUST_FIX 修复验证

### [FIXED] #1: discoverExtensionsInDir 无法发现 dist/index.js 入口

**修复方案**: FR-4.4 新增 `pi.extensions` manifest 字段。

**验证结果**: 通过。对照 pi 源码（`packages/coding-agent/src/core/extensions/loader.ts`），确认：

1. `resolveExtensionEntries` 函数（L473-503）**优先读取** `package.json` 的 `pi.extensions` 字段（L474-490）
2. `PiManifest` 接口（L440-445）定义 `extensions?: string[]`，与 FR-4.4 的 `"pi": {"extensions": ["dist/index.js"]}` 格式完全匹配
3. 对每个 manifest entry 调用 `path.resolve(dir, extPath)` 后检查文件存在性（L481-483），不存在则静默跳过
4. 当 manifest entry 全部不存在时，fallback 到 `index.ts`/`index.js` 检查（L493-500）

关键行为链路：`--extension <dir>` → `discoverAndLoadExtensions` (L552) → `resolveExtensionEntries` (L586) → 读取 `pi.extensions` → 解析 `dist/index.js`。整条链路在 pi 源码中完整存在，无需修改 pi。

### [FIXED] #2: 打包未覆盖 npm 包传递依赖

**修复方案**: FR-7.3 传递依赖白名单 + FR-7.4 preflight 检查。

**验证结果**: 通过。修复方案分两层防御：

1. **构建时显式包含**（FR-7.3）：扫描每个 `@zhushanwen/pi-*` 的 `package.json` dependencies/peerDependencies，将非 `@zhushanwen/` scope 的依赖逐个加入 `files` 白名单。`electron-builder` 的 `files` 是白名单机制——显式列出的路径不会被 auto-pruning 移除。
2. **构建后验证**（FR-7.4）：preflight-check.sh 增加 (a) `dist/index.js` 存在性检查、(b) 传递依赖在打包产物中存在性检查。即使白名单遗漏了某个依赖，构建阶段就会被拦截。

这个双层防御与 CLAUDE.md Rule #12 的"打包配置变更逐个 commit 验证"要求一致。

### v1 LOW/INFO 修复验证

| # | 问题 | 修复方式 | 状态 |
|---|------|---------|------|
| #3 | FR-1.3/FR-1.4 目录职责重叠 | 描述更详细但核心重叠仍在 | open（不阻塞） |
| #4 | 跨项目协调计划缺失 | C-7 约束已添加时序要求和 npm link 方案 | resolved |
| #5 | FR-5.3 文件位置模糊 | 已改为 `shared/src/extension.ts`（新文件），去掉了"或" | resolved |
| #6 | 加载失败错误处理缺失 | FR-1.7 已添加：日志+跳过+`extension.error` WS 事件 | resolved |
| #7 | AC-1 缺乏量化基线 | AC-1 已补充 baseline checklist（goal/todo/workflow 的 tool 和 command 名称） | resolved |
| #8 | FR-8 UI 影响范围不清 | FR-8.3 已明确第三方 extension 也受益于 setWidget/setStatus 桥接 | resolved |

## 新发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 9 | LOW | spec.md:FR-1.7 + FR-5.3 | **[REGRESSION] `extension.error` 事件类型未在 FR-5.3 中定义**。FR-1.7 新增了 `extension.error` WS 事件用于通知前端加载失败，但 FR-5.3 的 `shared/src/extension.ts` 类型定义仅覆盖 `extension.widget` 和 `extension.status`。开发者实现 FR-1.7 时无法确定该事件的 payload schema。 | 在 FR-5.3 中补充 `extension.error` 事件类型（`{ extensionPath: string, error: string }`），或明确将其排除在 extension UI 事件之外并说明定义位置。 |
| 10 | LOW | spec.md:FR-2.1 | **[REGRESSION] FR-2.1 描述与 FR-4.4 修复后的实际行为不一致**。FR-2.1 仍写"让 pi 的 `discoverExtensionsInDir` 自动发现 index.ts/index.js"，但 FR-4.4 添加 manifest 后，实际发现机制是：先读 `pi.extensions` manifest → 解析 `dist/index.js` → fallback 到 index.ts/index.js。FR-2.1 的描述未反映这一变化。 | 更新 FR-2.1 描述为"传**目录路径**而非文件路径，让 pi 通过 `package.json` 的 `pi.extensions` manifest 或 `index.ts/index.js` 自动发现入口文件，同时 jiti 能正确 resolve extension 同目录下的 `node_modules/`"。 |

## 结论

通过。

两轮 MUST_FIX 均已通过 pi 源码验证确认修复充分。FR-4.4 的 manifest 方案准确匹配了 pi 的 `resolveExtensionEntries` 实现（L473-503）；FR-7.3/FR-7.4 的双层防御覆盖了传递依赖的构建时包含和构建后验证。新发现的 2 条 LOW 均为文档描述精度问题（#9 事件类型定义遗漏、#10 FR-2.1 描述未同步更新），不影响功能正确性。

### Summary

Spec 评审完成，第 2 轮通过，0 条 MUST_FIX，2 条新 LOW（文档回归），2 条历史 MUST_FIX 已修复。
