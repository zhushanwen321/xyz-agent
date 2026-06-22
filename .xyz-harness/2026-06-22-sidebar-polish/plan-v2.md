# Sidebar v3-demo mock UI 收尾计划

> 续接本目录 `plan.md`。原 4 任务（3 行布局/搜索 ⌘K/hover 操作/文件视图）代码已完成并通过全部自动化检查。本计划聚焦**规范文本对齐**与**演示效果验证**。

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

### P0 · 重命名/删除改用 Dialog 组件 + 长期表单校验

**原因**：违反 CLAUDE.md「禁止原生交互元素，必须用 UI 组件库」+ 破坏 mock 展示效果。原生对话框不被自动检查抓，但与 v3-demo 视觉割裂。

#### 新增依赖（renderer 目录）

```bash
cd src-electron/renderer
npm install zod vee-validate @vee-validate/zod
```

> 会修改 `src-electron/renderer/package.json` 与 `package-lock.json`，属于本次工作产物，可提交。

#### 新增组件：`@/components/ui/form/*`

按 shadcn-vue 标准创建（项目已用 reka-ui，Form 系列不依赖 radix-vue）：

- `FormField.vue` — vee-validate `Field` 的薄封装，向下传递 `componentField`
- `FormItem.vue` — 提供唯一 id 上下文
- `FormLabel.vue` — 表单标签
- `FormControl.vue` — 绑定 `aria-describedby` / `aria-invalid`
- `FormMessage.vue` — 错误信息
- `useFormField.ts` — `provide/inject` 上下文
- `index.ts` — 统一导出

#### 新增组件：`components/sidebar/RenameSessionDialog.vue`

- Dialog + Input + 确认/取消按钮
- 使用 `useForm` + `toTypedSchema(zod...)` 做长期校验
- schema：
  ```ts
  z.string()
    .min(1, '请输入名称')
    .max(60, '名称不能超过 60 个字符')
    .regex(/^[a-zA-Z0-9\u4e00-\u9fa5_\- ]+$/, '仅允许中文、英文、数字、空格、横线和下划线')
  ```
- 允许与现有 session 同名（不做唯一性校验）
- 受控 `v-model:open` + `sessionId` prop + `confirm` emit

#### 新增组件：`components/sidebar/DeleteSessionDialog.vue`

- Dialog 确认（项目无 alert-dialog 组件，用普通 Dialog + warning 色调）
- 受控 `v-model:open` + `sessionId`/`sessionLabel` prop + `confirm` emit

#### 修改文件

- `components/sidebar/Sidebar.vue`
  - 移除 `window.prompt`/`window.confirm`
  - 添加 `renameOpen`/`deleteOpen` ref + `targetSessionId`
  - 挂载 `RenameSessionDialog` / `DeleteSessionDialog`
  - 接收 confirm 事件调用 `useSidebar.renameSession` / `deleteSession`
- `SessionItem.vue` / `Sidebar.vue` 顶部注释
  - 删除已实现的 DEFERRED 描述段

#### 验收

- `vue_rules_checker` + ESLint 0 错
- `npm run lint` 0 错
- 重命名：空值/过长/特殊字符校验生效，允许同名，确认后 store 更新
- 删除：二次确认，确认后列表刷新

### P1 · 视觉验证

```bash
VITE_MOCK=true npm run dev
```

启动后核对：
- 会话项 3 行对齐
- 搜索按钮/⌘K 弹出 SearchModal
- hover 会话项显示重命名/删除按钮
- 文件 tab 显示 M/A/D 文件树
- **重命名/删除 Dialog 弹出与交互正确**

### P2 · 提交

- 不要 rebase
- 仅 git add 本次修改/新增的文件（见下方清单），禁止 `git add -A`
- 提交信息示例：`feat(sidebar): replace native prompt/confirm with Dialog + vee-validate`

#### git add 清单

新增/修改代码文件：
- `src-electron/renderer/src/components/sidebar/RenameSessionDialog.vue`
- `src-electron/renderer/src/components/sidebar/DeleteSessionDialog.vue`
- `src-electron/renderer/src/components/sidebar/Sidebar.vue`
- `src-electron/renderer/src/components/sidebar/SessionItem.vue`
- `src-electron/renderer/src/components/ui/form/FormField.vue`
- `src-electron/renderer/src/components/ui/form/FormItem.vue`
- `src-electron/renderer/src/components/ui/form/FormLabel.vue`
- `src-electron/renderer/src/components/ui/form/FormControl.vue`
- `src-electron/renderer/src/components/ui/form/FormMessage.vue`
- `src-electron/renderer/src/components/ui/form/useFormField.ts`
- `src-electron/renderer/src/components/ui/form/index.ts`
- `src-electron/renderer/package.json`
- `src-electron/renderer/package-lock.json`

计划文件：
- `.xyz-harness/2026-06-22-sidebar-polish/plan-v2.md`

## 明确不做

| 项 | 理由 |
|----|------|
| `chat.clearSession` 清理消息分区 | mock 演示无害，session 不可再选 |
| `fixtureFileChanges` 转 api 调用 | ADR-0024 file-changes 通道 defer |
| 新建 alert-dialog 组件 | 用普通 Dialog 代替删除确认（YAGNI） |
| 魔数间距 → 标准 Tailwind scale | 检查器不覆盖此路径 + 方括号值是项目惯例 |
| rebase 修正提交历史 | 用户明确不要 rebase |

## 执行顺序

1. 安装依赖
2. 创建 `components/ui/form/*`
3. 创建 `RenameSessionDialog.vue` + `DeleteSessionDialog.vue`
4. 修改 `Sidebar.vue` 挂载 Dialog，移除原生 prompt/confirm
5. 修正 `SessionItem.vue` / `Sidebar.vue` 过时注释
6. 跑 lint / vue_rules_checker
7. 启动 `VITE_MOCK=true npm run dev` 视觉验证
8. 按清单 git add + commit（不 rebase）
