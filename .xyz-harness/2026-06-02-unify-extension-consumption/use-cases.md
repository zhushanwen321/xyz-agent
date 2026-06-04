---
verdict: pass
---

# 业务用例 — 统一 Extension 消费架构

## UC-1: 用户升级 Extension 版本

- **Actor:** xyz-agent 用户
- **Preconditions:** xyz-agent 已安装，至少一个 session 存在
- **Main Flow:**
  1. pi-ext 仓库发布新版本 `@zhushanwen/pi-goal@0.3.0`
  2. 用户在 xyz-agent 项目目录执行 `cd src-electron && npm update @zhushanwen/pi-goal`
  3. 用户重启 xyz-agent 应用
  4. ExtensionResolver 扫描 `node_modules/@zhushanwen/pi-goal`，发现新版本
  5. 用户创建新 session，pi 子进程通过 `--extension /path/to/pi-goal` 加载新版本
  6. goal extension 注册的 tools/commands 可用且行为正确
- **Alternative Paths:**
  - npm update 失败（网络问题）→ 用户看到 npm 错误，extension 保持旧版本，无功能影响
  - 新版本有 breaking change → extension 加载失败 → ExtensionResolver 记录日志 → session 正常启动（无 goal tool）
- **Postconditions:** 新版本 goal extension 已加载并可用
- **Module Boundaries:** npm CLI → node_modules → ExtensionResolver (runtime) → rpc-client → pi subprocess
- **AC Coverage:** AC-1（加载无回归）

## UC-2: 用户安装第三方 Extension

- **Actor:** xyz-agent 用户
- **Preconditions:** xyz-agent 已安装
- **Main Flow:**
  1. 用户发现社区 pi extension `pi-hashline-edit`
  2. 用户执行：
     ```bash
     mkdir -p ~/.xyz-agent/pi/agent/extensions/
     cd ~/.xyz-agent/pi/agent/extensions/
     git clone https://github.com/example/pi-hashline-edit.git
     cd pi-hashline-edit && npm install
     ```
  3. 用户重启 xyz-agent session
  4. ExtensionResolver.scanThirdPartyExtensions() 发现 `pi-hashline-edit`
  5. pi 子进程通过 `--extension ~/.xyz-agent/pi/agent/extensions/pi-hashline-edit` 加载
  6. pi jiti 解析 extension 的 `index.ts`，正确 resolve 同目录下的 `node_modules/`
  7. extension 注册的 tools/commands 可用
- **Alternative Paths:**
  - extension 名与 npm 包冲突（如也叫 `pi-goal`）→ ExtensionResolver.deduplicate() 优先使用 npm 版本，第三方版本被忽略
  - extension 的 `node_modules/` 缺失依赖 → jiti 加载失败 → ExtensionResolver 记录日志 → session 正常启动
  - extension 使用 `ctx.ui.custom()` → TUI overlay 在 RPC 模式下不可用 → 其他功能正常
- **Postconditions:** 第三方 extension 已加载并可用
- **Module Boundaries:** filesystem (~/.xyz-agent/) → ExtensionResolver (runtime) → rpc-client → pi subprocess → jiti
- **AC Coverage:** AC-2（去重）、AC-3（依赖解析）

## UC-3: 开发者修复 Extension Bug 并验证

- **Actor:** pi-ext 开发者
- **Preconditions:** pi-ext monorepo 已 clone，xyz-agent worktree 已存在
- **Main Flow:**
  1. 开发者在 pi-ext monorepo 中修复 goal extension bug
  2. 开发者在 pi-ext 执行 `npm run build`（tsc 编译各包到 dist/）
  3. 开发者发布 beta 版：`npm publish --tag beta` → `@zhushanwen/pi-goal@0.2.1-beta.0`
  4. 开发者在 xyz-agent worktree 执行 `cd src-electron && npm install @zhushanwen/pi-goal@0.2.1-beta.0`
  5. 开发者运行 `npm run dev` 启动 xyz-agent
  6. 创建新 session，验证 goal tool 行为正确
- **Alternative Paths:**
  - tsc 编译失败 → `dist/index.js` 未生成 → preflight-check.sh 检测到缺失 → 打包失败（安全拦截）
  - beta 版加载后 regression → 开发者 `npm install @zhushanwen/pi-goal@0.2.0` 回退
- **Postconditions:** 修复后的 extension 已在 xyz-agent 中验证通过
- **Module Boundaries:** pi-ext monorepo (tsc) → npm registry → xyz-agent npm install → ExtensionResolver
- **AC Coverage:** AC-1（加载无回归）、AC-7（bundled 副本已删除，不存在回退路径）

## UC-4: Extension UI 数据到达前端

- **Actor:** xyz-agent 用户（隐式，由 extension 触发）
- **Preconditions:** session 已启动，goal extension 已加载
- **Main Flow:**
  1. 用户在 chat 中输入 `/goal`，触发 goal extension
  2. goal extension 调用 `ctx.ui.setWidget("goal", ["Task 1: in_progress", "Task 2: pending"])`
  3. pi RPC 转发 `extension_ui_request` 事件到 xyz-agent runtime
  4. event-adapter.ts 检测到 `method === 'setWidget'`，生成 `extension.widget` WS 事件
  5. 前端 `useExtensionWidget` composable 接收事件
  6. ExtensionWidgetPanel 渲染 goal 任务列表
- **Alternative Paths:**
  - event-adapter 处理失败 → 错误日志 + `extension.error` WS 事件 → 前端显示错误提示
  - widgetKey 已存在 → 更新现有 widget 内容（Map.set 覆盖）
- **Postconditions:** extension 的 widget 数据在 GUI 中可见
- **Module Boundaries:** pi extension → RPC → event-adapter (runtime) → WS → useExtensionWidget (renderer) → ExtensionWidgetPanel (Vue)
- **AC Coverage:** AC-4（setWidget）、AC-5（setStatus）

## UC-5: 打包产物验证

- **Actor:** CI/CD 流水线
- **Preconditions:** 代码已合并到 main 分支
- **Main Flow:**
  1. CI 执行 `npm run build`（electron-builder 打包）
  2. electron-builder 根据 `files` 规则包含 `node_modules/@zhushanwen/pi-*/**/*`
  3. `asarUnpack` 将 pi-ext 从 asar 解压到 `app.asar.unpacked/`
  4. CI 执行 `scripts/postbuild-validate.sh` 验证产物
  5. CI 运行 smoke test：`ELECTRON_RUN_AS_NODE=1 <electron> <runtime> --port=<random>` → `/health` 返回 ok
  6. 打包产物发布到 GitHub Releases
- **Alternative Paths:**
  - preflight-check.sh 失败 → 打包中断，无产物生成
  - pi-ext 传递依赖缺失 → postbuild 验证失败 → CI 红灯
- **Postconditions:** DMG/ZIP 中包含完整的 pi-ext npm 包
- **Module Boundaries:** npm install → electron-builder (files + asarUnpack) → validate scripts → CI
- **AC Coverage:** AC-6（打包产物包含 npm extension）
