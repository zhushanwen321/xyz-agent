# 远程化 P4 实施计划：移动 Web 验证（最小 mobile-renderer）

**日期**: 2026-07-26 | **spec**: [spec.md](spec.md)（决策编号 D1-D12 在此引用） | **前置**: P0（runtime 远程化 + file.signUrl + serve-web）+ P1（connection-config + ws-client auth + DirSelectPopover 含手动路径输入 + RemoteConnectModal 逻辑）+ P2/P3（可靠投递 + 审批补发）已实施

> 所有 Task 遵守：vitest；lint/hook 问题正面修复；**不主动 git commit**。

---

## 任务清单

### T1 — mobile-renderer 工程骨架

**文件**（新建 `packages/mobile-renderer/`）：
- `package.json`：name `@xyz-agent/mobile-renderer`，dependencies 对齐 renderer（vue/pinia/@xyz-ui 路径/tailwind）
- `vite.config.ts`：独立配置（port 不同，如 1421；alias `@` 指向 src）
- `tsconfig.json`：对齐 renderer
- `index.html`：viewport meta + mobile-web-app-capable（不做 PWA manifest，D12）
- `tailwind.config.js`：copy renderer 配置
- `src/main.ts`：入口（无 Electron IPC 注册，无 local-file:// 协议注册）
- `pnpm-workspace.yaml`：workspace 已包含 packages/*，无需改

**核实项**：
- pnpm-workspace.yaml 已含 `packages/*`（确认 mobile-renderer 自动被 workspace 纳入）
- renderer 的 vite.config.ts / tsconfig.json 作为模板

**测试**：`pnpm dev` 能启动 mobile-renderer（独立端口 1421），空白页加载成功

---

### T2 — copy 业务核心层 + sync 脚本（spec §二 copy 清单，D2，审查 M5）

**文件**（copy 自 `packages/renderer/src/`）：
- `api/` 全部 → `mobile-renderer/src/api/`
- `stores/` 全部（除 extension-ui.ts 若是 BrowserPane 配套）→ `mobile-renderer/src/stores/`
- `composables/features/` 的非桌面部分（useChat/useSidebar/useForkActions/useSessionDerivations/useSettings/useNewTaskFlow）→ `mobile-renderer/src/composables/features/`
- `composables/useSessionEvents.ts` + `composables/useConnection.ts` → 同位置
- `composables/effects/` 的消息流 effect → 同位置
- `components/ui/` 全部 → `mobile-renderer/src/components/ui/`
- `components/panel/message-stream/` 全部 → 同位置
- `lib/remote/`（P1 已建）→ `mobile-renderer/src/lib/remote/`
- `lib/ws-client.ts`（P1 改造后含 auth）→ 同位置

**改动**：
- `composables/useConnection.ts`：砍掉本地模式分支（getRuntimePort IPC / HMR fallback / DEV_PORT_OFFSET），只保留远程模式
- 核实并砍掉任何桌面专属路由分支（BrowserPane drawer 事件等）

**【审查 M5 新增】sync 脚本**：
- `scripts/sync-mobile-from-renderer.sh`（新建）：明确 copy 清单（上述文件列表），支持 `--dry-run` 显示 diff、`--force` 执行 copy。renderer 改动后跑此脚本同步。
- CI 加 diff 检查：renderer 的 api/stores/composables 变更时提示「记得跑 sync-mobile-from-renderer.sh」（best-effort，不阻塞 CI）

**测试**：tsc 编译通过（无类型错误）；store/composable 单测随 copy 带过来（若有）

---

### T3 — ipc.ts 全 no-op（spec D8）

**文件**：
- `mobile-renderer/src/lib/ipc.ts`（新建）：所有方法返回 `Promise.resolve(undefined)` 或默认值。**不注册 window.electronAPI**（保持 undefined，业务层优雅降级天然生效）

**测试**：grep mobile-renderer 确认无 `window.electronAPI` 调用（或调用点都在 ipc.ts 优雅降级覆盖范围内）

---

### T4 — MobileShell + 底部 tab（spec §三，D3）

**文件**（新建）：
- `mobile-renderer/src/components/shell/MobileShell.vue`：`h-[100dvh] flex flex-col` 布局，含 Header + Content + BottomTabBar
- `mobile-renderer/src/components/shell/BottomTabBar.vue`：Sessions / Files / Settings 三 tab，`h-[56px]` + safe-area-inset-bottom
- 注：**ConnectingScreen 不单独创建**——所有连接前态（connecting/failed/无 token 粘贴框）合并由 `MobileConnectScreen.vue`（T7）处理。App.vue 连接态门控：connected → MobileShell，否则 → MobileConnectScreen（覆盖 connecting/failed/无存档三态）。独立 ConnectingScreen 是冗余设计，spec §二已同步标注。
- `mobile-renderer/src/App.vue`：连接态门控（已连接 → MobileShell；未连接 → MobileConnectScreen）

**测试**（`MobileShell.test.ts` 新建）：
- mount MobileShell，断言三 tab DOM 存在
- 点击 tab 切换 activeTab（DOM 断言）
- 首屏冒烟：mount App（mock 已连接），断言 MobileShell + BottomTabBar + Content 区域存在

---

### T5 — Sessions tab：列表 + 新建（spec §三.2，D4 手动路径输入，审查 M6）

**文件**（新建）：
- `mobile-renderer/src/components/sessions/MobileSessionList.vue`：session 列表（复用 sidebar SessionList 逻辑，适配移动宽度）
- `mobile-renderer/src/components/sessions/MobileNewSession.vue`：新建会话（composer 输入框 + **手动路径输入** input，复用 P1 spec §九设计；不走 dir.list）
- `mobile-renderer/src/components/chat/MobileChatView.vue`：chat 主视图（复用 message-stream，header 返回按钮 + session 名）
- `mobile-renderer/src/components/chat/MobileComposer.vue`：简化输入框 + 发送按钮

**【审查 M6】手动路径输入**：MobileNewSession 的目录选择是 `<Input placeholder="输入服务器路径，如 ~/projects/xyz-agent" />` + 确认按钮，提交走 cwd 设置路径（与 P1 DirSelectPopover 远程模式手动输入同语义，`~` 服务端 expand）。**不调 dir.list RPC**。

**测试**：
- `MobileSessionList.test.ts`：空态/列表态/会话态切换（DOM 断言）
- `MobileNewSession.test.ts`：手动路径输入框存在（DOM 断言）；输入路径 + 提交 → 调 sessionApi.create（带 cwd）
- `MobileChatView.test.ts`：mock WS 消息 → message-stream 渲染（用户可见断言：消息文本可见）

---

### T6 — Files tab：只读文件树 + 详情（spec D6）

**文件**（新建）：
- `mobile-renderer/src/components/files/MobileFilesView.vue`：文件树只读查看（复用 FileTree.vue，砍掉新建/删除/重命名右键菜单）
- `mobile-renderer/src/components/files/MobileFileDetail.vue`：文件内容查看（图片走 file.signUrl，spec D6）

**测试**：
- `MobileFilesView.test.ts`：mount，断言树结构渲染；无新建/删除按钮（DOM 断言）

---

### T7 — 连接流程（spec §四，D9）

**文件**（新建）：
- `mobile-renderer/src/components/remote/MobileConnectScreen.vue`：首屏粘贴框（复用 P1 parse-connect-info 解析逻辑，UI 重写为移动全屏）
- `mobile-renderer/src/App.vue`：onMounted 读 location.hash → 命中 #token= → 自动连接；无 token → MobileConnectScreen

**测试**：
- `App.test.ts`：mock location.hash 含 token → 自动连接流程启动；无 token → MobileConnectScreen 渲染（DOM 断言）
- `parse-connect-info.test.ts`：复用 P1 测试（三种格式解析）

---

### T8 — Settings tab 简化版（spec §十.4）

**文件**（新建）：
- `mobile-renderer/src/components/settings/MobileSettings.vue`：连接信息（host/token 显示 + 断开按钮）+ theme 切换 + deviceName 编辑

**测试**：
- `MobileSettings.test.ts`：mount，断言连接信息区域 + 断开按钮存在（DOM 断言）

---

### T9 — runtime serve-web 托管 mobile-renderer（spec D10）

**文件**：
- `packages/runtime/src/transport/connection-manager.ts`（或 server.ts）：--serve-web 接受多 dist 路径，按 URL 前缀路由（`/` 桌面、`/m/` 移动）
- 或最简：--serve-web 接受目录，目录内含 `desktop/` + `mobile/` 子目录，runtime 按 UA 或路径分发
- 部署文档说明：访问 `http://<host>:<port>/m/` 拿移动端

**测试**：runtime --serve-web 启动后，curl `/m/` 返回 mobile-renderer index.html

---

### T10 — feature-map 同步 + verify 脚本

**文件**：
- `docs/feature-map/2026-07-26-remote.md`：
  - §九 P4 描述确认
  - §十一索引追加 P4 spec/plan 链接
- `tools/verify-mobile-web.cjs`（新建）：Playwright 连 runtime --serve-web 托管的 mobile-renderer
  - 场景：移动 emulation 访问 `/m/#token=...` → 连接成功 → 看到 session 列表 → 新建 session → chat 流渲染 → 文件树展开

---

## 依赖与顺序

```
T1（工程骨架）─→ T2（copy 业务层）─→ T3（ipc no-op）
                                └→ T4（MobileShell）─→ T5（Sessions）─→ T6（Files）
                                                     └→ T7（连接流程）
                                                     └→ T8（Settings）
T9（runtime serve-web）独立，可与 T1-T8 并行
T10 依赖 T1-T9 完成
```

**外部依赖**：P0（file.signUrl + serve-web）+ P1（connection-config + ws-client auth + DirSelectPopover 含手动路径输入）必须先完成。**不依赖 dir.list**（审查 M6，dir.list 在 P9）。

## DoD

0. **【R2-m4 前置 gate】** P0（file.signUrl + serve-web）+ P1（connection-config + ws-client auth + DirSelectPopover 含手动路径输入）+ P2（seq 回放）+ P3（审批补发）已实施——P4 验证这些阶段的移动端链路。**不依赖 dir.list**（M6）+ **不依赖 P5/P6/P7 协同协议**（presence/lease P4 阶段还不存在）
1. vitest 全绿（mobile-renderer，新增）
2. `tools/verify-mobile-web.cjs` exit 0（Playwright 移动 emulation 跑通完整流程）
3. spec §九测试计划全覆盖（首屏渲染 / MobileShell tab / Sessions 状态机 / chat 渲染 / 文件树只读 / 连接解析）
4. feature-map §九 P4 + §十一索引更新
5. `npm run lint` + pre-commit 全过
6. **客户端可见断言**（spec 测试视角规则 5/8）：
   - mount App（未连接）→ MobileConnectScreen 粘贴框 DOM 存在
   - mount MobileShell → 底部三 tab DOM 存在
   - mount MobileChatView mock 消息 → 消息文本可见
   - mount MobileFilesView → 无新建/删除按钮（只读验证）
7. **真机/模拟器验证**：手机浏览器（或 Chrome DevTools mobile emulation）访问 runtime 托管的 mobile-renderer，完整跑通 连接 → 新建 session → chat → 文件查看 流程
