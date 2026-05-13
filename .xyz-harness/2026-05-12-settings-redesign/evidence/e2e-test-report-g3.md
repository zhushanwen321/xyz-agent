# E2E Test Report: G3 — Skill Tab

**日期**: 2026-05-13
**执行者**: AI Agent (自动化)
**环境**: Sidecar WS ws://localhost:3210, Electron CDP :9333, Vite :1420

---

## 总体结果

| 用例 | 结果 | 严重程度 |
|------|------|---------|
| TC-3-01 | **PASS** | P2 |
| TC-3-02 | **PASS** (需修复 bug) | P1 |
| TC-3-03 | **PASS** | P1 |
| TC-3-04 | **PASS** | P2 |
| TC-3-05 | **PASS** | P1 |
| TC-3-06 | **PASS** | P2 |

**G3 COMPLETE: 6 passed, 0 failed, 0 skipped**

---

## 详细执行记录

### TC-3-01: Skill 扫描源 Chips 交互 — PASS

**测试目标**: 验证 3 个 source chips（Pi/Claude/Agents）渲染，Pi 默认 active，计数文案「已选 1 个来源」。

**L2 DOM/A11y**:
- A11y 树中找到 3 个 StaticText 元素："Pi Skills"、"Claude Code"、"Agents" ✅
- Pi chip 的 className 包含 `border-[var(--accent)] bg-[var(--accent-light)] text-[var(--accent)]`（active 状态）✅
- Claude Code 和 Agents chip 使用 `border-border bg-surface`（非 active）✅
- 文本「已选 1 个来源」在 DOM 中找到 ✅

**L3 视觉对比**:
- 截图保存: `tc-301_skill-scan.png` (84KB)

**备注**: 无 baseline 可对比，仅做截图存档。

---

### TC-3-02: Skill 扫描执行 — PASS (需修复 bug)

**测试目标**: 点击扫描后 WS config.scanSkills → config.scannedSkills，扫描结果列表渲染。

**发现并修复的 Bug**:
- `skill-scanner.ts` 使用 `readdirSync(source, { withFileTypes: true })` + `entry.isDirectory()` 扫描 skill 目录
- skill 源目录中的条目是 **符号链接**（symlink），`Dirent.isDirectory()` 对 symlink 返回 `false`
- 修复：改用 `readdirSync(source)` + `statSync(dirPath).isDirectory()`（statSync 跟随 symlink）
- 修复文件：`src-electron/sidecar/src/skill-scanner.ts`

**L1 WS 协议**:
- `config.scanSkills` → `config.scannedSkills` ✅
- `success: true` ✅
- `skills count: 50`（来自 ~/.pi/agent/skills/）✅
- first skill: `{name: "batch-tracer", sourceType: "pi"}` ✅

**L2 DOM/A11y**:
- 扫描结果显示 50 行 skill 项 ✅
- 注意：UI 使用自定义 div 实现复选框（`w-4 h-4 rounded-[3px]`），非原生 checkbox，A11y 树中无 checkbox role
- 每个扫描项显示名称、来源标签（Pi）、描述 ✅

**L3 视觉对比**:
- 截图保存: `tc-302_skill-results.png` (117KB)

---

### TC-3-03: Skill 导入选中项 — PASS

**测试目标**: WS config.setSkill → config.skills broadcast，已导入列表更新，skills.json 持久化。

**L1 WS 协议**:
- 导入 batch-tracer: `config.setSkill` → `config.skillUpdated` + `config.skills` (count: 1) ✅
- 导入 code-trace: `config.setSkill` → `config.skillUpdated` + `config.skills` (count: 2) ✅

**L2 DOM/A11y**:
- 已导入区域出现 batch-tracer 和 code-trace section ✅
- section 包含 toggle switch (`role="switch"`, `aria-checked="true"`) ✅

**L3 视觉对比**:
- 截图保存: `tc-303_skill-imported.png` (150KB)

**L4 文件验证**:
- `src-electron/.xyz-agent/skills.json` 存在 ✅
- 包含 2 条记录：pi-batch-tracer、pi-code-trace ✅
- 注：sidecar 从 src-electron 目录启动，skills.json 位于 src-electron/.xyz-agent/ 下

---

### TC-3-04: Skill Toggle 启停 — PASS

**测试目标**: toggle 切换 skill 启停状态。

**L2 DOM/A11y**:
- 点击 batch-tracer 的 toggle switch:
  - `aria-checked` 从 "true" → "false" ✅
  - section 添加 `opacity-60` 类 ✅
- 恢复 toggle:
  - `aria-checked` 从 "false" → "true" ✅
  - `opacity-60` 移除 ✅

**L1 WS 协议**:
- 连接后收到 config.skills broadcast，确认 batch-tracer enabled=true ✅

---

### TC-3-05: Skill 删除 — PASS

**测试目标**: 删除后 section 消失，skills.json 更新。

**L1 WS 协议**:
- `config.deleteSkill` → skills count 2→1 ✅

**L2 DOM/A11y**:
- code-trace section 从已导入列表消失 ✅
- batch-tracer section 仍在 ✅

**L4 文件验证**:
- skills.json 从 2 条减少到 1 条 ✅
- 仅剩 pi-batch-tracer ✅

---

### TC-3-06: Skill 展开详情 — PASS

**测试目标**: 点击 section header 展开详情，MetaGrid 可见。

**L2 DOM/A11y**:
- 点击 batch-tracer 的 section header → 展开成功 ✅
- MetaGrid 显示详细元信息：
  - 名称: batch-tracer ✅
  - 触发词: batch-tracer、批量分析 ✅
  - 来源: pi · /path/to/SKILL.md ✅
  - 文件大小/依赖工具字段存在 ✅
- Chevron 旋转：CSS transform 未检测到（可能使用 Vue class 切换动画），但展开/折叠功能正常

**L3 视觉对比**:
- 截图保存: `tc-306_skill-expanded.png` (141KB)

---

## Bug 修复记录

### BUG-1: skill-scanner.ts 无法扫描 symlink 目录

**文件**: `src-electron/sidecar/src/skill-scanner.ts`
**原因**: `readdirSync({ withFileTypes: true })` 返回的 `Dirent.isDirectory()` 对符号链接返回 false
**修复**: 改用 `readdirSync()` + `statSync(dirPath).isDirectory()`，statSync 跟随符号链接
**影响**: 所有 skill 扫描源目录（~/.pi/agent/skills/、~/.claude/skills/、~/.agents/skills/）均使用符号链接，修复前扫描结果为空

## 证据文件清单

| 文件 | 大小 | 说明 |
|------|------|------|
| tc-301_skill-scan.png | 84KB | Skill tab 初始状态，source chips |
| tc-302_skill-results.png | 117KB | 扫描结果列表 |
| tc-303_skill-imported.png | 150KB | 导入 skill 后状态 |
| tc-306_skill-expanded.png | 141KB | Skill 展开详情 |
