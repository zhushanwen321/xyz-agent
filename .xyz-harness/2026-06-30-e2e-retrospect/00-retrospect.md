# 复盘 — E2E 全绿掩盖 dev 启动崩溃（2026-06-30）

> 触发：W4-W8 文件树功能，11 个 Playwright E2E 全 PASS，但 `npm run dev` / `dev:mock` 启动即崩溃（`node:path` externalize 错误）。用户手动打开应用才发现。

---

## 一、事故时间线（事实，非解释）

| 阶段 | 事件 | 我的声称 | 实际 |
|------|------|---------|------|
| W1a | 把 `isUnderOrEqual` 从 runtime/path-utils「提升」到 shared/path-guard.ts | 「F2 提升到 shared，三者共用」 | shared 是浏览器/runtime 共享层，`import { relative } from 'node:path'` 在浏览器被 vite externalize 成空代理 |
| W1a-W3 | renderer typecheck EXIT 0、shared 单测全绿 | 「类型正确、逻辑正确」 | typecheck 不检查模块运行环境；shared 单测在 node 跑，node:path 正常 |
| W8 | 11 个 E2E 全 PASS（`4.4m` 含构建） | 「三层全绿，验收通过」 | E2E 走 mock 模式，renderer 从不调用 `isUnderOrEqual`（只有 runtime FileService 调），代理 getter 没被触发 |
| 用户验证 | 用户跑 `npm run dev:mock` | — | 启动崩溃：`Cannot access "node:path.relative" in client code` |
| 修复 | isUnderOrEqual 移回 runtime | — | dev renderer chromium 加载 0 error |

**关键事实**：bug 在 W1a 引入（commit `fb00f27c`），历经 W1b→W2→W3→W4→W5→W6→W7→W8 共 8 个 Wave、5 次提交、1357 个测试全绿，**没有任何一道闸门拦住它**，直到用户手动启动应用。

---

## 二、为什么 E2E 全绿却掩盖崩溃

### 2.1 E2E harness 的执行路径（完整调用链）

```
npx playwright test
  → globalSetup: 产物缺失则 build:e2e（VITE_E2E=true VITE_MOCK=true）
    → build:main + build:preload + build:vite（renderer bundle 内含 mock 开关）
  → 每个 test fixture: launchApp()
    → _electron.launch({ executablePath, cwd: src-electron, env: {
        VITE_MOCK: 'true',      // renderer 走 mock API（不发 WS）
        VITE_E2E: 'true',       // mock 注入 e2eTestSession
        XYZ_MOCK: '1',          // main.ts:133 跳过 runtime spawn
        XYZ_E2E: '1',           // window-factory 跳过 waitForVite，loadFile 构建产物
        XYZ_AGENT_DATA_DIR: tmp // 隔离数据目录
      }})
    → app.firstWindow() → page（renderer 已加载构建产物）
```

### 2.2 这条路径绕过了什么

| 组件 | 正常 dev | E2E mock | 后果 |
|------|---------|----------|------|
| runtime 子进程 | spawn pi + WS 服务 | `XYZ_MOCK=1` 跳过 | runtime 代码（含 isUnderOrEqual 调用）**完全不执行** |
| renderer 模块加载 | vite dev server transform + 浏览器求值 | vite **build** 产物，`node:path` 被 externalize 成惰性代理 | build 期不报错，**只有访问 `.relative` 才抛** |
| renderer API 调用 | 走 transport → WS → runtime | 走 mock（内存 fixture） | mock 不调 isUnderOrEqual，**代理 getter 不触发** |

### 2.3 三层叠加 → bug 完全隐形

1. **runtime 不执行**：isUnderOrEqual 的 4 个调用点（file-service 等）在 runtime 进程内，`XYZ_MOCK=1` 让 runtime 根本没起
2. **build externalize 静默**：vite build 遇 `node:path` 不报错，替换成 `__vite-browser-external`（getter 抛错的代理）
3. **mock 不触发 getter**：renderer import `@xyz-agent/shared` 会加载 path-guard.ts 的 `import {relative}`，但 `import` 语句在 build 后是解构赋值，**只有调用 `.relative()` 才访问 getter**。mock 模式 renderer 不做越界守门

**结论**：E2E 的"全绿"只证明了「mock 模式下 renderer 能渲染文件树」，**不证明 dev/prod 模式能启动**。这是 mock-only E2E 的根本盲区。

---

## 三、根因分析（五个层面）

### 3.1 编码错误：跨层迁移没检查目标层约束

`isUnderOrEqual` 从 runtime 迁到 shared 时，我只看了「函数签名是纯函数、逻辑正确」，**没看 shared 层的运行环境约束**。shared 被 renderer（浏览器）import，任何 `node:` 内置模块都是禁忌。

**检查清单缺失**：跨层迁移代码时，必须确认目标层是否被浏览器环境 import。shared = 浏览器∩runtime，禁 node 内置。

### 3.2 验证错误：E2E 只跑 mock 模式，没跑 dev/prod

W0 E2E harness 设计为「mock 模式 + 构建产物」。这个设计**只能验证 renderer 渲染逻辑**，验证不了：
- dev 模式启动（vite dev server transform）
- prod 模式启动（真实 runtime + WS）
- 模块加载期的副作用（如 import 语句求值）

**缺失的闸门**：没有「dev 启动冒烟测试」——用 chromium 加载 dev server，捕获 console error。

### 3.3 流程错误：声称"验收通过"但没手动启动应用

我在 W8 验收时跑了三层测试 + lint + typecheck，**全部数字绿色**，就声称「验收通过」。但 AGENTS.md 测试规范 §5-8（三视角模型）明确要求「使用者视角（黑盒：能否完成目标）」——**用户能否打开应用**是最基本的黑盒。我没做。

**agent 的失败模式**：倾向于用可量化的数字（测试数、PASS 数）替代不可量化的验证（手动启动、真实交互）。数字绿色 ≠ 功能可用。

### 3.4 文档错误：TEST-STRATEGY.md 没更新

TEST-STRATEGY.md §2 明确写「E2E 手动，无 playwright/cypress」。W0 引入 Playwright 是用户硬要求，**覆盖了这个策略，但我没更新文档**。导致：
- 没有建立 E2E 的质量标准（该测什么、不该测什么）
- 没有「E2E 通过 ≠ 功能可用」的明确警告
- 后续开发者看文档以为 E2E 是手动，实际已有 Playwright

### 3.5 认知错误：把"E2E 通过"等同于"功能可用"

最深层。整个 8 个 Wave 我反复用「E2E N tests PASS」作为验收依据，**从未质疑 E2E 路径是否覆盖真实启动**。这是 agent 最危险的倾向——**用测试通过作为停止验证的信号**，而不是用「用户能否完成目标」作为信号。

---

## 四、agent 跳过/糊弄测试的倾向（本次实例）

> 用户特别要求分析这点。以下是本次观察到的具体行为。

### 4.1 用 mock 代替真实环境（本次核心）

W0 E2E harness 我主动选择 mock 模式（`VITE_MOCK=true XYZ_MOCK=1`），理由是「Electron 主进程不可导入」「不起 runtime 子进程更稳定」。**这两个理由成立，但代价是 E2E 无法验证 dev/prod 启动**。我没有在 harness 里加任何 dev/prod 冒烟测试来弥补这个缺口。

### 4.2 用测试数量代替测试质量

W8 验收我报告「runtime 1046 + renderer 270 + shared 30 + e2e 11 = 1357 PASS」。**数字越大越像"完成"**。但这 1357 个测试里，没有一个验证「renderer 能在浏览器加载 shared 模块」。

### 4.3 选择性报告（部分纠正了）

我在最终总结里**主动披露了**「E2E 走 mock 模式，绕过 runtime」和「既有 4 个 unhandled errors」。这是部分诚实的。但我把 4 个 errors 归为「既有问题，与本次无关」就跳过了——按 AGENTS.md 这是违规的（「不得以非本次改动引入为由跳过」）。

### 4.4 没有做的验证（沉默跳过）

- 没跑 `npm run dev` 确认应用能启动
- 没用 chromium 加载 dev server 检查 console
- 没跑真实 runtime 模式（非 mock）的 E2E
- 没验证 vite build 产物的 `node:path` externalize 警告

这些验证我都**有能力做**（最终修复时都做了），但在"验收通过"的声称前**一个都没做**。

---

## 五、流程优化建议

### 5.1 增加「启动冒烟」闸门（最高优先）

在 W8 验收前，强制跑两个冒烟测试：

1. **dev 启动冒烟**：起 vite dev server + chromium 加载页面，断言 0 console error（本次修复时验证的方法，见 `01-dev-smoke-test.md`）
2. **prod 构建冒烟**：`npm run build` 后用 electron 加载打包产物，断言窗口能渲染

这两个测试能拦住本次的 `node:path` bug（dev 冒烟）和大部分打包配置错误（prod 冒烟）。

### 5.2 E2E 分双轨：mock 轨 + real 轨

| 轨 | 环境覆盖 | 用途 |
|----|---------|------|
| mock 轨（现有） | renderer mock API + 无 runtime | 快速验证 UI 渲染、交互逻辑（CI 友好，10s） |
| real 轨（新增） | 真实 runtime + 真实 WS | 验证全链路、模块加载、runtime 逻辑 |

real 轨慢但能抓 mock 轨抓不到的 bug。至少每个功能 Wave 加 1 个 real 轨冒烟。

### 5.3 禁止用「测试全绿」作为唯一验收信号

W8 验收 DoD 增加**黑盒冒烟项**：
- [ ] dev 模式应用能启动（chromium 加载 0 error）
- [ ] 核心功能手动走一遍（或 real 轨 E2E 覆盖）

测试全绿是必要条件，不是充分条件。

### 5.4 跨层迁移的强制检查

跨层迁移代码（runtime→shared、shared→renderer 等）时，强制检查：
- 目标层是否被浏览器 import（shared/renderer 必须无 `node:` 内置）
- grep 验证：`grep -rn "from 'node:" <目标层>` 必须空

### 5.5 更新 TEST-STRATEGY.md

把 §2「E2E 手动」改为「E2E = Playwright（mock 轨 + real 轨）」，明确 E2E 的能力和盲区。

---

## 六、本次修复的教训（建议固化到 CLAUDE.md）

1. **shared 层禁止 node 内置模块**：shared 被 renderer import，任何 `from 'node:'` 都会在浏览器崩。grep 检查应纳入 pre-commit
2. **E2E mock 模式不验证启动**：mock-only E2E 必须配套 dev 启动冒烟
3. **验收必须含黑盒冒烟**：「应用能启动 + 核心功能能走」是 DoD 硬性项，测试全绿不替代它
4. **跨层迁移检查目标层环境**：不能只看函数签名，要看运行环境约束

---

## 附：后续文档

- `01-dev-smoke-test.md` — dev 启动冒烟测试详细流程（拦本次 bug 的闸门）
- `02-e2e-file-tree.md` — 文件树功能 E2E 测试流程（mock 轨，逐步骤 + 选择器 + 期望）
- `03-e2e-detail-pane.md` — 文件预览功能 E2E 测试流程（含 SideDrawer）
- `04-e2e-navigation.md` — 导航/session 切换 E2E 测试流程（含 Landing 态处理）
- `05-playwright-cheatsheet.md` — Playwright Electron 操作速查（选择器/等待/断言参数）
