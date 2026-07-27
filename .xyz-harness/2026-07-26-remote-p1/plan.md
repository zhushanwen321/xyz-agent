# 远程化 P1 实施计划：桌面 Electron 远程模式

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D10 在此引用） | **前置**: P0 已交付（auth 协议、file.signUrl、server CLI）

> 所有 Task 遵守：vitest（`cd packages/renderer && npx vitest run`）；每条用例至少一个用户可见断言；lint/hook 问题正面修复；**不主动 git commit**。

---

## 任务清单

### T1 — lib/remote 三模块（解析 / 配置 / 探测）

**文件**（新建）：
- `packages/renderer/src/lib/remote/parse-connect-info.ts`（spec §三：四格式解析 + networkKind 识别）
- `packages/renderer/src/lib/remote/connection-config.ts`（spec §二：localStorage CRUD + clientId + mode）
- `packages/renderer/src/lib/remote/probe.ts`（spec §7.5：probeConnect / probeOnline；auth 消息构造导出纯函数供 T2 复用）
- `packages/renderer/src/lib/remote/ws-origin.ts`（ws(s)→http(s) origin 推导）

**测试**：`parse-connect-info.test.ts`、`connection-config.test.ts`、`probe.test.ts`（mock WebSocket）

**验收**：spec §三表格四格式 + error 分支全过；probe 三分支全过。

### T2 — ws-client：auth 握手 + close code + RTT

**文件**：`packages/renderer/src/lib/ws-client.ts`

- `connect(url, opts?: {auth?})`（spec §4.1）：onopen 发 auth（构造用 T1 纯函数）、10s 超时、auth.ok 前不翻转 connected、onmessage 拦截层消化 auth 回复
- onclose 读 `event.code`（spec §4.2 表格）：4001→failed(auth)、4002→failed(replaced)、其他现状退避；`getState()` 增 `failReason`
- RTT：ping 带 id、pong 匹配计时、`lastRtt` ref（spec §4.3）
- auth opts 存模块变量供重连复用

**测试**：`ws-client.test.ts` 扩展（spec §十三表格行 3）

**验收**：本地模式（无 auth opts）现有测试全绿不变。

### T3 — useConnection 远程分支 + App.vue failed 变体

**文件**：
- `packages/renderer/src/composables/useConnection.ts`（spec §五：init 远程分支、跳过 IPC 监听、retryRuntime 分模式）
- `packages/renderer/src/App.vue`（spec §六：failReason 三分支文案/按钮 + standalone RemoteConnectModal 挂载点 + onRetry 分模式）

**测试**：useConnection 远程分支单测；App failed 变体 render 测试（failReason=auth → 「修改连接信息」按钮可见，点击挂 modal）

**验收**：本地模式启动链逐字节不变（现有测试全绿）。

### T4 — RemoteConnectModal 四组件

**文件**（新建，spec §七）：
- `packages/renderer/src/components/remote/RemoteConnectModal.vue`（壳 + tab + footer + 连接流程状态机）
- `RemotePasteTab.vue`（textarea 即输即解析 + 预览 + 剪贴板探测预填）
- `RemoteManualTab.vue`（URL/Token/设备名 + 校验）
- `RemoteSavedTab.vue`（列表 + probeOnline + 删除/重命名 + 添加新服务器）
- i18n：zh-CN / en-US 按 spec §十一清单新增 key

**约束**：template ≤400 行 / script ≤300 行；xyz-ui 组件（Button/Input/Dialog）；禁止原生表单元素、emoji、硬编码颜色。

**测试**：`RemoteConnectModal.test.ts`（渲染 gate：三 tab + 粘贴框 DOM 存在；粘贴合法串 → 预览三行可见 + 按钮解禁；非法串 → 橙色提示）

### T5 — DirSelectPopover + Landing 接线

**文件**：
- `packages/renderer/src/components/new-task/DirSelectPopover.vue`（spec §九：远程连接动作项 + 远程模式隐藏打开文件夹 + 手动路径输入）
- `packages/renderer/src/components/new-task/Landing.vue`（popover emit 接线开 modal；spec §八 远程状态条：host + RTT + 切换/断开按钮；modal open state 持有）
- presetCwd 远程分支（spec §九.3：records[0] 自动预选）
- i18n：`dirSelect.remoteNotSupported` 删除，新增 key

**测试**：DirSelectPopover 两模式断言；Landing 状态条远程可见/本地不可见

### T6 — DetailPane 图片签名 URL

**文件**：
- `packages/renderer/src/api/domains/file.ts`（+ `signUrl` RPC）
- `packages/renderer/src/components/panel/DetailPane.vue`（spec §十：imageUrl computed→ref+watch 防竞态；远程走 signUrl + http origin，本地原样）

**测试**：远程模式断言调 signUrl 且 img src 为 http origin；本地模式 `local-file://` 不变

**依赖**：P0 的 `file.signUrl` 协议（spec §2.2）。P0 未实施时本 Task 阻塞，可先写代码联调置后。

### T7 — 集成验证 + 文档

- 手动 E2E 清单执行（spec §十三末行）：真 server CLI + dev Electron 全链路
- `docs/testing/` 新增远程模式测试文档（mock/非 mock 步骤 + 已知坑）
- feature-map §十一索引表追加 P1 spec/plan 行
- `docs/feature-map/2026-07-26-remote.md` P1 行状态更新

---

## 依赖与顺序

```
T1（lib 三模块）─┬─→ T2（ws-client）─→ T3（useConnection + App.vue）
                └─→ T4（modal）──────→ T5（popover + Landing 接线）
T6（DetailPane）独立于上，依赖 P0 file.signUrl
T7 最后
```

T1/T4 无 P0 依赖可先行；T2/T3/T6 联调需 P0 server。

## DoD

0. **【R2-m4 前置 gate】** P0 已实施且其 verify 脚本（`tools/verify-auth.cjs` 等）exit 0——P1 的 auth 握手/ws-client 改造依赖 P0 的 token-file/Map<clientId>/close code 4001-4002 基础设施
1. `cd packages/renderer && npx vitest run` 全绿（新增 + 现有）
2. 渲染 gate 过：modal 三 tab、Landing 状态条、DirSelectPopover 两模式、App failed 变体均有 DOM 断言
3. `npm run lint` + pre-commit hook 全过
4. 手动 E2E：真 server 上「粘贴连接 → reload 自动连 → 状态条 → 聊天 → 图片预览 → 错误 token 4001 变体」全通
5. 本地模式零回归：本地启动、failed 屏、local-file:// 图片、mock 模式逐一手动确认
