# Sidebar v3-demo 收尾计划（规范对齐 + 演示验证）

> 续接 `plan.md`。原 4 任务（3 行布局/搜索 ⌘K/hover 操作/文件视图）代码已完成并通过全部自动化检查。本计划聚焦**规范文本对齐**与**演示效果验证**。

## 目标 · 基准 · 约束

- **目标**：提供一个可用 mock 数据展示操作的 UI
- **基准**：v3-demo 设计稿（`docs/designs/v3-demo/sidebar/`）
- **约束**：项目规范（CLAUDE.md + 自动化检查）

## 规范核查结果（已确认）

| 检查 | 覆盖 `src-electron/renderer/src/` | 结果 |
|------|---|---|
| vue_rules_checker（原生元素/Emoji/Tab/CSS/行数≤400/300/v-model） | ✅ | 通过 |
| taste-lint base（any/silent-catch/allsettled） | ✅ | 通过 |
| taste-lint no-hardcoded-colors/no-magic-spacing | ❌ 仅 `frontend/src/` | 不适用 |
| 方括号精确值 `text-[12.5px]` | — | 项目惯例（SegmentedTab 等既有代码） |

**结论**：4 任务代码合规。唯一违反规范文本（且破坏演示目标）的是 `window.prompt`/`window.confirm`。

## 任务

### P0 · 重命名/删除改用 Dialog 组件【必须】

**原因**：违反 CLAUDE.md「禁止原生交互元素」+ 破坏 mock 展示效果。原生对话框不被自动检查抓，但与 v3-demo 视觉割裂。

**新建文件**：
- `components/sidebar/RenameSessionDialog.vue` — Dialog + Input + 确认/取消
- `components/sidebar/DeleteSessionDialog.vue` — Dialog 确认（无 alert-dialog 组件，用普通 Dialog + warning 色调）

**修改文件**：
- `components/sidebar/Sidebar.vue` — 移除 `window.prompt`/`confirm`，改持有 `renameOpen`/`deleteOpen` ref + `targetSessionId`，挂载两个 Dialog，接收 confirm 事件回调 `useSidebar.renameSession`/`deleteSession`

**Dialog API**（复用 SearchModal 模式）：
- 受控 `v-model:open` + `sessionId`/`sessionLabel` prop + `confirm` emit
- 组件：`Dialog/DialogContent/DialogHeader/DialogTitle/DialogDescription/Input/Button`（均已有）
- 缺 `DialogFooter` → 用 `<div class="flex justify-end gap-2">` 代替

**表单校验决策**（form-validation.md 要求 zod+vee-validate，但项目无 FormField 组件）：
- **短期方案（采纳）**：重命名 Dialog 用简单 ref + `trim()` + 非空校验 + 内联 `text-danger` 错误文字。标 `// ponytail: 项目补齐 FormField 组件后升级为 zod + vee-validate`
- 理由：长期方案需引入 3 依赖 + 建 3 组件，仅为一个 input 字段，不值得（YAGNI）

**验收**：
- vue_rules_checker + ESLint 0 错
- 重命名：空值禁用确认、trim 后回写 store、Esc/点遮罩取消
- 删除：二次确认、确认后 session 从列表移除

### P1 · 视觉验证【应该】

**步骤**：
1. `VITE_MOCK=true npm run dev`（background 模式启动）
2. 核对：会话项 3 行对齐 / 搜索 ⌘K / hover 重命名删除 / 文件树 M/A/D 配色 / **新 Dialog 弹出与交互**
3. 修复发现的视觉偏差

### P1 · 注释修正【应该】

- `SessionItem.vue` 顶部注释删「hover 操作 DEFERRED」段（已实现）
- `Sidebar.vue` 顶部注释删「File View 内容 G2-003 defer」（已实现）

### P2 · 提交卫生【可选】

commit `46ddc144` 误带 `.xyz-harness/2026-06-22-composer-ux-fixes/plan.md`。4 commit 未 push，rebase 修正成本最低。push 后改用 filter-branch 成本高。

## 明确不做（YAGNI / defer）

| 项 | 理由 |
|----|------|
| `chat.clearSession` 清理消息分区 | mock 演示无害，session 不可再选 |
| `fixtureFileChanges` 转 api 调用 | ADR-0024 file-changes 通道 defer |
| 引入 zod + vee-validate + FormField 组件 | 仅一个 input 字段，成本不匹配（见 P0 校验决策） |
| 新建 alert-dialog 组件 | 用普通 Dialog 代替删除确认 |
| 魔数间距 → 标准 Tailwind scale | 检查器不覆盖此路径 + 方括号值是项目惯例 |
| typecheck（vue-tsc） | 未安装；dev server 能跑即可验证 mock UI |

## 执行顺序

P0 Dialog → P1 视觉验证（启动 dev server 实际看效果，含新 Dialog）→ P1 注释修正 → P2 提交卫生。
