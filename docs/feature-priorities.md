# 功能与用例分级（P0-P3）

> **本文件是 xyz-agent 全部功能模块与用例分级的 SSOT**。三个用途：① tech-design 设计期风险打分的锚定源（见「维护规则」）；② 测试回归与审查资源的排序依据（P0 全量每版、P2 抽样）；③ dev-flow 交付时的同步登记目标。
>
> 姊妹指针：[AGENTS.md](../AGENTS.md) 文档索引 · [TEST-STRATEGY.md](../TEST-STRATEGY.md) 回归排序 · 各 extension 包内文档头注（有 ARCHITECTURE.md / docs/ 的包）。

## 1. 分级判据

| 级 | 定义（以「挂掉后用户视角」判） |
|----|------------------------------|
| **P0** | 最核心部分。挂了，整个项目对用户毫无价值 |
| **P1** | 核心部分。挂了，项目大体还能用一部分，但用户体验非常差 |
| **P2** | 非核心部分。挂了，项目基本可用，用户能稍微忍受 |
| **P3** | 无关紧要部分。挂了影响很少，甚至只有特定人群受影响 |

判定规则：按「挂掉后果」而非「代码量/复杂度」判；一个模块跨级时按其最高级用例整模块取级；拿不准时查「边界判例」节先例，无先例按后果更严重侧判并在判例节补记。

## 2. P0 — 核心链路（挂了 = 对用户毫无价值）

| 模块 | 关键用例组 | 代码锚点 |
|------|-----------|---------|
| 应用启动与进程编排 | Electron 窗口创建、runtime 子进程拉起、WS 握手、renderer 加载、单实例锁 | `apps/electron/main/` + `packages/runtime/src/server.ts` |
| 会话创建与首发 | 新建任务旅程（Landing → 选目录 → 首发提交）、pi 进程绑定 | `useSidebar` / `SessionService`（testing 01） |
| 对话发送与流式渲染 | composer 输入三态、发送、流式 delta 回显、错误作为 assistant 消息入流、isGenerating 重置 | composer / `run-send-stream`（testing 02/03） |
| pi RPC 适配 | EventAdapter 协议翻译、session-pool、sendCommand success 检查、pi stdout tee 落盘 | `packages/runtime/src/` pi 适配层 |
| session 持久化与恢复 | pi session 文件延迟写入、live ≡ reload（同一 applyEntry reducer）、重开一致、全 entry 类型 | entry reducer 链（关键规则 9） |
| per-session 隔离 | 消息 sessionId 路由三层过滤、ADR-0049 Map 分区、updateFor(capturedSid) | `useSessionScopedState` 工厂（ADR-0049） |

## 3. P1 — 核心体验（挂了 = 大体能用，体验非常差）

| 模块 | 关键用例组 | 备注 |
|------|-----------|------|
| 多会话管理 | 侧边栏会话列表、切换 12 步链、删除清理编排、LRU、未读标记 | 切换链 SSOT 在 `use-session.ts selectSession` |
| 文件树与文件查看 | 懒加载、过滤、git 角标、文件预览 | testing 04 |
| 工具调用过程展示 | bash/edit/read 过程与结果渲染、变更集展示 | 挂了只见黑盒 |
| 权限审批闭环 | permission extension + GUI 审批浮层、approve/deny 透传 | 挂了工具调用卡死 |
| 模型与 thinking level | 能力注册表、生效回执（RPC 状态化）、模型切换 | pi 边界可靠性 U5/U6 |
| 中断/取消 | turn 取消链、取消后状态一致性 | 挂了失控烧 token |
| Markdown 渲染 | shiki 高亮、CSP 兼容、降级路径 | 曾 CSP 事故全量降级纯文本 |
| 扩展装载框架 | builtin 21 包装载、分组守卫（infrastructure 不可禁）、worker 隔离 | 挂了所有 feature 扩展全灭 |

## 4. P2 — 常用辅助（挂了 = 基本可用，稍微忍受）

| 模块 | 关键用例组 |
|------|-----------|
| subagent/workflow 面板与派发 | subagent 列表/运行计数、workflow 面板、通知链（边界判例 #2） |
| 双 Panel / split mode | 分屏会话并行、split 下 listener 防重复 |
| 搜索 modal | ⌘K 四类搜索、recents、跳转（testing 06） |
| 设置页 | provider 管理、主题、系统提示词编辑、用量入口 |
| 自动更新 | 更新检查、下载、安装（update-e2e） |
| 通知系统 | 桌面通知、pending-notifications 汇聚 |
| 插件系统 | PluginService、trusted/sandbox 隔离、statusBar（testing 13） |
| zcode 引擎 | app-server RPC、会话库隔离、凭据注入（边界判例 #4） |
| ask-user overlay | agent 提问浮层、Other 保留、pi 恢复 turn（边界判例 #3） |
| session-reader | 通知链 session_read 指针解析、跨进程读 |
| smart-context | 自动压缩、双模式摘要接管、分档提醒（手动 compact 兜底） |
| structured-output / plan / todo 面板 | workflow 结构化输出、计划面板、todo 渲染 |
| i18n | zh/en 切换、消息键完整（边界判例 #1） |
| 快捷键与 side drawer | 全局快捷键、文件预览/diff/git tab（testing 05） |
| session 导入 | ImportSessionDialog |
| 后台任务侧边栏 | background task 展示（testing 14） |

## 5. P3 — 特定人群/低影响

| 模块 | 关键用例组 | 受影响人群 |
|------|-----------|-----------|
| cache-probe | 前缀指纹采集、analyze.py 归因 | 缓存分析用户 |
| cw-tool / coding-workflow | cw 工作流工具族 | cw 用户 |
| goal | 目标管理 | goal 用户 |
| scheduler | 定时调度 | 定时任务用户 |
| session-manager | agent-managed session 6 工具 | 高级编排用户 |
| rename-session | 会话重命名 | 全体但低频、有手动路径 |
| system-prompt-trace | xyz:system-prompt 留痕 | 观测/调试 |
| 用量统计页 | Settings → 用量 W1-W5 | 配额敏感用户 |
| 视觉细节与动画 | 过渡动画、traffic light 布局数值 | 全体但纯视觉 |
| Mock 开发轨 | VITE_MOCK 拦截层 | 仅开发者 |

## 6. 引擎与 extension 分级表

**引擎**：pi 引擎接入 = **P0**（主力，唯一不可替代）；zcode 引擎 = **P2**（第二引擎，边界判例 #4）。

| 包 | 组 | 分级 | 依据 |
|----|----|------|------|
| agent-ext | taiji | P1 | xyz-agent 集成基座，挂了集成能力降级但 pi 主链路存活 |
| msg-id-mapper | taiji | P1 | 挂了消息映射错乱 |
| plugin-bridge | taiji | P2 | 跟随插件系统分级 |
| system-prompt | taiji | P1 | 挂了 agent 裸人格、所有会话质量崩 |
| system-prompt-trace | taiji | P3 | 观测留痕 |
| ask-user | universal | P2 | 边界判例 #3 |
| base-tool-enhance | universal | P1 | bash 前台链挂了 agent 失去执行能力（原生回退仅保底） |
| cache-probe | universal | P3 | 特定人群 |
| cw-tool | universal | P3 | 特定人群 |
| goal | universal | P3 | 特定人群 |
| pending-notifications | universal | P2 | 通知汇聚 |
| permission | universal | P1 | 审批闭环（见 §3） |
| plan | universal | P2 | 面板能力 |
| rename-session | universal | P3 | 低频有手动路径 |
| scheduler | universal | P3 | 特定人群 |
| session-manager | universal | P3 | 高级编排人群 |
| session-reader | universal | P2 | 通知链依赖 |
| smart-context | universal | P2 | 手动 compact 兜底 |
| structured-output | universal | P2 | workflow 模式依赖 |
| subagent-workflow | universal | P2 | 边界判例 #2 |
| todo | universal | P2 | 面板能力 |
| unified-hooks（deprecated） | universal | — | 已废弃，残留安装需先卸载 |

**包内标注规则**：包内有 `ARCHITECTURE.md` / `docs/*.md` 的（当前：ask-user、todo、session-reader），文件头加一行 `> 功能分级：P<x>（依据见 docs/feature-priorities.md §6）`；只有 CHANGELOG/README 的包**只登记本表**（CHANGELOG 是发布记录、README 面向用户，均不作登记载体）。

## 7. 维护规则 [MANDATORY]

1. **dev-flow 收尾同步**：交付引入新功能/新用例，或既有功能的「挂掉后果」变化导致分级依据改变 → 同 commit 更新本表对应行 + 受影响包内头注；纯内部重构/等价修复不触发（规则落点：dev-flow `flow/acceptance.md` 收尾节）
2. **tech-design 风险锚定**：设计文档头部标注「本设计触及的最高 P 级」；每方案风险分 = P 级基数（P0=9 / P1=7 / P2=4 / P3=2）+ 可逆性修正（数据迁移/协议变更/不可逆 +1）+ 新颖度修正（仓内无先例机制 +1），clamp 1-10（规则落点：tech-design skill）
3. **测试回归排序**：P0 每版全量、P1 每版核心用例、P2 抽样/变更触发、P3 变更触发（指针见 TEST-STRATEGY.md）
4. **新增/删除 extension 或功能模块**：更新 AGENTS.md 列举时同步本表登记

## 8. 边界判例（拿不准项的判决记录，新判例追加于此）

| # | 项 | 判决 | 理由 |
|---|----|------|------|
| 1 | i18n | P2 | fallback 英文可用、功能无损；中文体验降级明显但不到「非常差」 |
| 2 | subagent/workflow 派发 | P2 | 产品核心卖点、重度用户视作 P1；但一般用户不派 subagent 也能完成 P0 主链路 |
| 3 | ask-user overlay | P2 | 触发时硬阻塞该 turn，但频率低且有超时/拒绝路径，不影响主链路其余部分 |
| 4 | zcode 引擎 | P2 | 对 zcode 用户群挂了=完全不可用，但 pi 引擎可用时主链路完整 |
| 5 | base-tool-enhance | P1 | bash 是 agent 执行能力的主体；原生工厂回退只保底不保等价（后台模式/审计全失） |
