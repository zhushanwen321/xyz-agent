---
verdict: pass
---

# E2E Test Plan — Pi Extension Installation

## Test Scenarios

### TS1: npm 安装 — 标准包名

1. 打开 Settings → Extensions
2. 在 npm tab 输入 `pi-subagents` → 点击 Install
3. 验证：扩展出现在列表，source 显示 "user-installed"，toggle 可用

### TS2: npm 安装 — scoped 包名

1. 输入 `@zhushanwen/pi-goal` → 点击 Install
2. 验证：安装成功，列表显示正确的 scoped 名称

### TS3: npm 安装 — `npm:` 前缀兼容

1. 输入 `npm:pi-subagents` → 点击 Install
2. 验证：安装成功，等同于不带前缀

### TS4: npm 安装 — 非 pi 扩展

1. 输入 `lodash` → 点击 Install
2. 验证：安装失败，显示 "not a valid pi extension" 错误提示

### TS5: npm 安装 — 不存在的包

1. 输入 `this-package-does-not-exist-12345` → 点击 Install
2. 验证：安装失败，显示 404/not found 错误提示

### TS6: 本地目录 — 单个扩展

1. 准备一个包含单个 valid pi extension 的目录
2. 在 local tab 输入路径 → Install
3. 验证：发现列表显示 1 个扩展，勾选后安装成功

### TS7: 本地目录 — Collection 多扩展

1. 准备一个包含 3 个 pi extension 子目录的目录
2. 输入路径 → Install
3. 验证：发现列表显示 3 个扩展，勾选 2 个 → 仅这 2 个被安装

### TS8: Git URL 安装

1. 在 git tab 输入 `https://github.com/zhushanwen321/pi-goal.git` → Install
2. 验证：显示 Clone→Scan 进度，发现列表显示扩展，确认安装后成功

### TS9: normalizeExtName 去重

1. 安装 `@scope1/pi-goal` 和 `@scope2/pi-goal`
2. 验证：两个扩展共存，互不冲突

### TS10: Extension toggle/uninstall

1. 安装一个扩展 → toggle 关闭 → 扩展变灰/隐藏
2. toggle 重新打开 → 恢复正常
3. uninstall → 扩展从列表消失

## Test Environment

- 开发模式：`npm run dev` 启动 xyz-agent
- 需要网络连接（npm registry + git clone 测试）
- 测试用 mock registry 或本地 npm pack 可加速
