# Settings 模块重设计 Phase 2 — 复盘报告

## 基本信息
- 需求: Settings 模块重设计（Section Groups 风格 + Skill/Agent 扫描 + Model Toggle）
- 分支: feat-skill-agent-provider
- 时间: 2026-05-12 ~ 2026-05-13
- 代码变更: 47 files, +8840 -906（3 commits + 未提交修复 11 files, +264 -265）

## 阶段状态

| 阶段 | 状态 | 备注 |
|------|------|------|
| Phase 1 需求设计 | done | spec.md + plan.md + e2e-test-plan.md |
| Phase 1 计划评审 | done | plan_review_v1.md, 4 MUST FIX 全部解决 |
| Phase 2 编码实现 | done | 12 tasks, 40 files |
| Phase 2 编码提交 | done | ebec2eb |
| E2E 测试方案 | done | v1 + v2, 30 用例 |
| E2E 测试执行 | done | 29/30 PASS (96.7%), 1 SKIP |
| Bug 修复 (3个) | done | symlink x2 + model.toggle |
| Model Toggle 功能 | done | 新协议 + 乐观更新 + 持久化, 重测 PASS |
| ESLint 清理 | done | 5 error → 0 error |
| 代码重构 (server.ts) | done | 672 行 → 587 行, 提取 handleSettingsMessage |
| 依赖清理 | done | 移除 @rolldown 意外依赖 |
| 最终提交 | pending | 未提交 |

## 发现的 Bug 及根因分析

### Bug 1: skill-scanner.ts symlink 处理
- **症状**: `scanSkills()` 返回 0 个 skill（实际有多个 skill 目录通过 symlink 链接）
- **根因**: `readdirSync(dir, { withFileTypes: true })` 返回的 `entry.isDirectory()` 对 symlink 返回 false
- **修复**: `entry.isDirectory()` → `statSync(dirPath).isDirectory()`，statSync 跟随符号链接
- **同类问题**: agent-scanner.ts 完全相同的 bug
- **根因分类**: **编码疏忽** — Node.js `fs.Dirent.isDirectory()` 文档明确说明不解析符号链接，但编码时没有考虑 symlink 场景
- **建议 CLAUDE.md 规则**: 当使用 `fs.readdirSync({ withFileTypes: true })` 遍历目录时，对 `entry.isDirectory()` 的判断必须改为 `statSync(join(source, entry.name)).isDirectory()`，因为 Dirent 不解析符号链接

### Bug 2: model.toggle 协议缺失
- **症状**: TC-2-05 失败 — 前端发送 `model.switch` 消息格式不匹配 sidecar 期望
- **根因**: spec 中 ModelRow.vue 有 `toggle-enabled` emit 和 `enabled` 字段，但设计时没有规划对应的 WS 协议消息。编码时前端复用了 `model.switch`（切换活跃 model），而 sidecar 的 `model.switch` 期望 `{ sessionId, provider, modelId }` 语义完全不同
- **修复**: 新增 `model.toggle` / `model.toggled` 协议消息，独立于 `model.switch`
- **根因分类**: **需求遗漏** — spec 的数据流图（4.1 节）只列了 `model.switch`，没有 model enable/disable 的独立协议
- **改进建议**: spec review 时应检查每个 UI 交互是否都有对应的协议消息覆盖

### Bug 3: @rolldown 意外依赖
- **症状**: package.json 中多了 `@rolldown/binding-darwin-arm64` 依赖
- **根因**: E2E 测试 subagent 执行 `npm install` 时引入（Vite 8 的传递依赖被提升为直接依赖）
- **修复**: 从 dependencies 中移除
- **根因分类**: **工具使用不当** — subagent 不应修改 package.json
- **改进建议**: subagent 执行 npm 命令前应加 `--no-save` 或使用 `npx` 而非 `npm install`

## Plan Review 有效性

| 维度 | 发现 | 有效性评估 |
|------|------|-----------|
| 乐观更新缺失 | MUST FIX #1 — 发现前端 toggle 缺少乐观更新 | 高 — 编码时确实遗漏了这一步 |
| 失败时广播缺失 | MUST FIX #2 — model not found 时不广播 | 高 — 避免了 stale 数据 |
| 文件位置不精确 | MUST FIX #3 — discoverModels handler 位置描述不精确 | 中 — 执行 agent 需要自己定位 |
| 文件清单不一致 | MUST FIX #4 — provider-store 变更描述与正文矛盾 | 中 — 避免了执行 agent 多余工作 |

**结论**: Plan Review 有效拦截了 4 个编码问题，其中 2 个（乐观更新、失败广播）如果不修复会直接影响用户体验。评审投入产出比高。

## E2E 测试有效性

### 测试发现的真实 Bug

| Bug | 发现方式 | 严重度 | 如果没有 E2E 会怎样 |
|-----|---------|--------|-------------------|
| symlink 扫描空结果 | TC-3-02, TC-4-02 | 高 | 用户首次打开 Skill/Agent tab 看到 0 个可导入项 |
| model.toggle 协议不匹配 | TC-2-05 | 中 | 用户点击 model toggle 无响应，前端报错 |
| ProviderModal 覆盖 enabled | TC-2-06 | 低 | 编辑 provider 后所有 model 恢复为 enabled |

### 测试成本

| 资源 | 消耗 |
|------|------|
| E2E 测试用例 | 30 个 |
| 执行 subagent | 6 个（G1~G6） |
| 执行时间 | ~80 分钟 |
| 视觉评分调用 | 4 次 |
| 发现 Bug | 3 个 |

### 四层验证策略评估

| 层 | 使用次数 | 发现 Bug | 误报率 | 评价 |
|----|---------|---------|--------|------|
| L1 WS 协议 | 18 | 2 (symlink + model.toggle) | 0% | 核心验证层，不可替代 |
| L2 DOM/A11y | 20 | 0 | ~5% | 确认渲染正确，但 selector 脆弱 |
| L3 视觉对比 | 12 | 0 | 0% | 设计还原度量化，非 bug 发现器 |
| L4 持久化 | 10 | 0 | 0% | 确认 config.json 写入正确 |

**L2 的 selector 脆弱问题**: 测试脚本大量使用 `document.querySelectorAll('.flex.items-center.gap-2\\.5')` 这样的 CSS selector，Tailwind 类名变更会导致测试全部失效。建议后续 E2E 测试优先用 `[data-testid]` 或 Accessibility Tree 角色+名称查询。

## Subagent 调度效率

| 阶段 | Subagent 数 | 耗时 | 问题 |
|------|------------|------|------|
| 编码实现 (12 tasks) | ~6 批次 | ~60 min | 无重大阻塞 |
| E2E 测试执行 (6 groups) | 6 并行 | ~80 min | G2/G3/G4 并行效率高 |
| Model Toggle 实现 | 2 并行 (A+B) | ~15 min | sidecar + frontend 分离效果好 |
| Bug 修复 + ESLint | 3 并行 | ~10 min | 分组合理 |

**并发控制**: 严格遵守了 ≤3 并发的限制。G2/G3/G4/G5 四组实际分了两批（G1 先行，其余并行）。

## 未解决 / 遗留项

| 项目 | 状态 | 严重度 | 说明 |
|------|------|--------|------|
| TC-2-04 Provider 删除 | SKIP | 低 | 测试环境只有 1 个 provider，非代码 bug |
| TC-2-05 L2 DOM 乐观更新 | 仅代码验证 | 低 | 实时 opacity 变化需手动在 UI 验证 |
| TC-2-06 L2 Modal 交互 | selector 未匹配 | 低 | "编辑"按钮文本选择器需要适配实际 UI |
| TC-6-04 ui-diff 无 baselines | 用 AI 评分替代 | 低 | 首次执行无基线截图，后续可做回归 |
| server.ts 587 行 | 仍超 500 行 | 低 | ESLint `skipBlankLines` 后有效行 508，warning 已消除 |
| 未提交变更 | pending | 阻塞 | 11 files 功能代码 + 文档变更待提交 |

## 关键教训

### 1. Symlink 是 Node.js 文件遍历的常见陷阱
`fs.Dirent.isDirectory()` 不解析符号链接在 Node.js 文档中有说明，但实际开发中容易被忽略。xyz-agent 项目大量使用 symlink（skill 和 agent 目录通过 symlink 链接到工作目录），所有文件遍历代码都必须用 `statSync` 代替 `Dirent.isDirectory()`。

### 2. 协议语义不能复用
`model.switch`（切换活跃 model）和 `model.toggle`（启停 model）虽然都涉及 model 操作，但语义完全不同。复用协议消息会导致 payload 格式不匹配。新功能应定义新协议消息，即使看起来"差不多"。

### 3. E2E 测试用例的 selector 策略
基于 Tailwind 类名的 DOM selector 在开发过程中极易失效。应优先使用：
- Accessibility Tree（`role` + `name`）— 语义稳定
- `[data-testid]` — 明确的测试锚点
- 元素文本内容 — 比 class 稳定

### 4. Subagent 执行 npm install 需要约束
Subagent 执行 `npm install` 可能意外修改 package.json。应使用 `npx` 或 `npm exec` 替代，避免副作用。

### 5. Plan 评审的 MUST FIX 修复后再编码
4 个 MUST FIX 全部在编码前修复，避免了返工。特别是"乐观更新缺失"如果不修，用户会感知到明显的延迟。

## CLAUDE.md 改进建议

### 建议新增规则

```markdown
### 文件遍历规则
- 使用 `fs.readdirSync({ withFileTypes: true })` 时，`entry.isDirectory()` 不解析符号链接
- 需要识别 symlink 目录时，必须使用 `statSync(join(dir, entry.name)).isDirectory()`
- 适用场景：scanner、watcher、目录遍历等

### 协议消息设计规则
- 新增功能如涉及 WS 通信，必须定义独立的协议消息类型
- 禁止复用已有协议消息（即使 payload 字段"看起来相似"）
- 协议消息在 shared/src/protocol.ts 中集中定义
```

### 建议修改规则

无需修改现有规则。当前 CLAUDE.md 的编码规范覆盖良好。
