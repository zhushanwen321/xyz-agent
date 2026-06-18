# 阶段 5 · 防护加固（可选，长期）

> 上游：[migration-plan.md](../migration-plan.md) · 关联决策：D6b / D1

## 目标

把架构不变量固化为可自动检查的防护，防止重构后回退。

## 前置依赖

阶段 1（API Client 已建，防护才有意义）。各子项独立，可按需做。

## 改动清单（独立子项）

### 5.1 session 路由第 2 层强制（D6b）

- `api/events.ts`：session-scoped 消息无 `payload.sessionId` → 丢弃 + dev 模式 `console.warn`。
- 单测覆盖：无 sessionId 的 session.created 等消息被丢弃。

### 5.2 启动时序契约集成测试（D1）

- 测试 8 步时序（**按 phase-0 订正后的真实顺序**：createWindow 先于 spawn）。
- 模拟 Runtime 重启 → onRuntimePort 推新端口 → 渲染进程重连（G5 收尾，见 phase-1 task 3）。

### 5.3 pre-commit：禁止 send 直调 ws-client（扫全 renderer）

- 脚本扫描 **`renderer/src/**/*.ts` + `*.vue`**（**非仅 composables/**），除 useConnection（传输层合法）+ api/transport.ts（封装层）外，禁止 `from '.../lib/ws-client'` 的 send 直调。
- **覆盖 phase-1 迁移范围**：含 stores/plugin.ts + 4 个组件（ExtensionsPane/PanelSessionView/SkillDrawer/AppStatusbar），否则这些文件的 send 直调永不被拦（plan-review-round-1 发现）。

### 5.4 pre-commit：禁止跨 service 具体类循环 import（可选）

- 扫描 `runtime/src/services/**/*.ts` 的 import，若 import 同级具体 service 类（非接口），提示用 `interfaces.ts` 接口或事件。
- 防 D6c 误诊再现（虽无循环，但防护未来引入循环）。

### 5.5 pre-commit：plugin-service Facade 边界（T5，可选）

- 扫描 `plugin-service/` 外的代码 import `plugin-service/` 内部模块（非 `IPluginService`）→ 报错。
- 落实 design.md T5「只有 IPluginService 越界」。

## 验证标准

- [ ] 各子项对应测试通过。
- [ ] pre-commit 在违规时拦截，合法时放行。
- [ ] 现有代码不误报（先跑一遍全量检查）。

## 回滚

各子项独立 commit，单独 revert。

## 备注

本阶段是「加固」而非「必需」。阶段 1–4 完成后系统已可正常运行；本阶段提升长期可维护性。优先级：5.1（session 路由）> 5.3（禁止直 send）> 其余。
