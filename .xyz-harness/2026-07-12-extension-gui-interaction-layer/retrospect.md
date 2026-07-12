# 复盘：Extension GUI 交互层协议 + 协议包架构重构

> **Topic**: cw-2026-07-12-extension-gui-interaction-layer
> **完成日期**: 2026-07-12

## 做了什么

### 功能交付

xyz-agent 侧的 ask-user 富交互桥接层，使 ask-user extension（使用 `ctx.ui.custom()`）能在 GUI 前端呈现富交互表单：

1. **协议包（extension-protocol）**：`AskUserQuestion` / `AskUserOption` / `AskUserAnswers` 类型 + `ASK_USER_MARKER` + `askUserInteract()` helper + 解析 helper（`getAskUserAnswer/Other/Comment`）
2. **runtime**：event-adapter 检测 `ASK_USER_MARKER`，从 select 的 options[0] 解析 JSON payload，透传为 `extension.ui_request` 的 `askUser` + `askUserQuestions` 字段；同时修复了普通 select options 拍扁 bug（`.map(o=>o.label)` → `.map(String)`）
3. **前端**：`AskUserOverlay.vue` 富交互组件（tab 切换 / 单选 / 多选 / Other / comment / Submit）+ ExtensionUIDialog 的 ask-user 分支路由

### 架构重构（开发中途的决策转向）

原计划是"通用富交互协议"（InteractionQuestion / guiInteract），用户指出这是 ask-user 特别定制而非通用协议后，整体重构：

- 协议包拆成 `core/`（通用：GuiComponent + 布局原语 + 传输编码）+ `extensions/`（特定 extension 契约）
- 已有的 task-list/goal-status/workflow-runs/subagent-trace 从扁平 types.ts 拆到 `extensions/<name>/` 子目录
- Interaction* 全部改名为 AskUser* 前缀

## 做对了什么

1. **select 通道复用**：不新建 method，走 select + marker + options[0] JSON payload，零管道重复代码。runtime 的 timeout-manager / response builder / queue 全部复用。
2. **TUI 模式抛错而非返回 null**：避免与"用户取消"语义混淆，强制 extension 按 ctx.mode 分支。
3. **协议包目录隔离**：用户要求"通用逻辑和定制逻辑隔离"是对的——InteractionQuestion 确实带着 ask-user 的设计烙印，不该冒充通用协议。
4. **消费方 import 路径不变**：目录重构是协议包内部组织，index.ts 统一 re-export，外部零改动。

## 做错了什么

1. **初始定位错误**：spec 设计为"通用富交互协议"，实际是 ask-user 定制协议。浪费了 W1 的初始实现 + 需要全仓库 rename。根因：没有先确认"这套类型是否真的通用"就开始编码。
2. **CW dev 传空 tasks**：误触状态跳转（planned → developed），导致 dev gate 一直 false。应确认 tasks 格式后再调。
3. **CW expected 过期**：rename 后没同步更新 CW plan 的 expected，导致 test 阶段全 fail。CW 不允许 tested 状态 replan，只能直接改数据库修复。根因：rename 前没评估对 CW 测试断言的影响。
4. **InteractionOverlay.vue 原生 button**：tab 用了 `<button>` 被 ESLint 拦截，应一开始就用 Button 组件。

## 教训提炼

1. **命名要反映归属**：通用名（Interaction）用于定制逻辑（ask-user）会误导后续开发者，以为这是通用能力。命名应明确归属（AskUser 前缀）。
2. **协议包需要目录隔离**：当通用层和定制层混在同一个 interface（GuiComponentProps）里，归属只靠注释维护，存在漂移风险。目录隔离让归属在文件系统层面可见。
3. **rename 是 breaking change**：即使没发布到 npm，内部的 CW 测试断言、消费方代码都需要同步更新。rename 前要全仓库 grep 影响面。

## 数据

- 3 个 Wave（W1 协议包 + W2 runtime + W3 前端），4 个 commit
- 75 个测试全绿（协议包 35 + runtime 30 + 前端 10）
- 所有 typecheck（tsc + vue-tsc）+ lint（ESLint + 代码规范检查）通过
