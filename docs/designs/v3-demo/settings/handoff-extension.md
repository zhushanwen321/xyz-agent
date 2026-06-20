# Handoff · settings · Extension

> Extension 菜单 · 左导航第 4 项。
> MCP 服务器/扩展：安装（npm / local dir / git URL）+ 启用/卸载。安装走「发现候选 → 多选 → 安装」工作流。
> 字段与交互源自 `~/Code/xyz-agent-workspace/main/.../settings/ExtensionsPane.vue` + `ExtensionSection.vue`。

## 1. 定位

- 主用模式：**C · Entity List**（已安装扩展）+ 安装区（tab + input + 发现候选多选）。
- 与 Skill 的扫描导入形似但不同：Skill 扫描本地目录，Extension 走 npm / 路径 / git 三种**远程/本地来源** + 后端发现 + 真实安装。

## 2. 数据模型（字段）

```
ExtensionInfo { name, version, description, enabled: bool,
                dirName, tools?: string[] }
```

## 3. 布局

- page-header：`Extension` + 「MCP 服务器与扩展…」。
- 安装区（可折叠 card）：tab bar（npm / Local Dir / Git URL）+ 统一 input + Install 按钮 + hint。
- 发现阶段：候选多选列表 / 扫描中 / 安装中 / 错误+hint。
- 已安装列表（Entity List，模式 C）。
- 空状态。

## 4. 关键交互（特异点）

- **安装（核心工作流，三 tab）**：
  - `npm`：包名（`npm:pkg`，缺 `npm:` 前缀自动补）→ 直接安装。
  - `Local Dir`：本地路径 → 后端发现候选（`extension.installDir`）→ 候选多选 → 安装选中（`extension.finishInstall`）。
  - `Git URL`：URL → 后端 clone + 发现 → 候选多选 → 安装。
  - 进度态：`discovering`（scanning/cloning）/ `selecting`（候选多选）/ `installing`。按钮文案随态变（Cloning…/Scanning…/Installing…）。
  - **60s 超时** → 错误「Operation timed out after 60 seconds」。
  - 错误 + hint（后端返回 `code`/`message`/`hint`）。
- **列表行**：name + version pill + description（line-clamp 1）+ 启用开关（`extension.toggle`）+ 卸载。
- **卸载确认 Dialog**：`Uninstall {name}?` + Cancel / Uninstall（danger）。

## 5. 校验

- 字段级：input 非空（Install 按钮 disabled 当空）；npm 包名格式。
- 表单级：安装错误 → inline（红字 message + 斜体 hint），不用 modal 级 toast。

## 6. 状态枚举

- 空（无扩展）/ 发现中 / 发现结果空（「No pi extensions found」）/ 候选多选 / 安装中 / 安装错误 / 卸载确认。

## 7. 验收 P0

- [ ] 三 tab 安装来源都能触发后端工作流，进度态文案正确
- [ ] 候选多选 → 「Install Selected (N)」按选中数启用
- [ ] 60s 超时有反馈
- [ ] 卸载走确认 Dialog（防误删）
- [ ] 启用开关即时生效（`extension.toggle`）

## 8. Plugins 归属（已裁决）

Plugins **保留为独立第 6 菜单，不折叠进 Extension/Skill**（2026-06-19 决策，见 `spec.md §8`）。理由：Plugins 的 per-item config 与 Extension 的「远程安装 + 启用」职责不同，折叠需给 `ExtensionInfo` 加 `configSchema`，耦合过重。Plugins 菜单由用户单独实现，不在本 draft 队列内。

## 9. 参考

- 现有 impl：`ExtensionsPane.vue` / `ExtensionSection.vue`（事件：`extension.list` / `extension.install` / `extension.installDir` / `extension.installGit` / `extension.discovered` / `extension.finishInstall` / `extension.cancelInstall` / `extension.toggle` / `extension.uninstall` / `extension.installError`）
- 对齐：`PRODUCT.md` / `docs/designs/design-system.md` / `form-validation.md`
- **本菜单细化稿**：`draft-extension.html`（2026-06-19）—— §1 安装工作流状态机 5 卡（idle/discovering/selecting/installing/error+60s 超时）+ §2 Entity List 三行变体（built-in/user-installed 已连接/断开+重连）+ 空状态 + §3 卸载确认 Dialog（真实可弹）+ §4 ExtensionInfo 字段表 + WS 事件清单。复用 shell token + 原语，全部可交互。
