---
wave: W19
phase: P6
cases: simple×2
deps: [W16]
est: 4min
va_ref: VA-07 #1-3(+4-8若建)
---

# W19 · P6 Settings hide 入口检查

> 2 个简单 case：v1 只 hide 入口（spec §9 G-021）。若 SettingsModal 已建则额外验骨架视觉。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/settings/spec.md` | §1（入口）+ §2（modal 骨架） |
| `$ROOT/docs/designs/v3-demo/settings/draft-settings-shell.html` | **主对照稿**（若 modal 已建则对照） |
| `$ROOT/src-electron/renderer/src/components/settings/SettingsModal.vue` | 待验：**可能未建**（hide 策略） |

## 前置

- **W16 PASS**。

## Cases

### Case 1（simple）· 三入口全 hide（⌘, / 头像 / 齿轮）

**检查方法**：
1. 按 `⌘,`（mac）/ `Ctrl+,`（win/linux）→ 确认无 modal 弹出。
2. 查 sidebar 用户区 → 确认无 settings 入口（或头像点击无 settings 响应）。
3. 查 workspace 顶栏 → 确认无齿轮按钮（或点击无反应）。

**期望**（spec §9 G-021 + §8.5 hide 规则）：三入口均不触发 settings。

**PASS**：三入口均 hide（无 modal 弹出）。**FAIL**：任一入口触发 modal 但功能不全（三模式/5菜单 DEFERRED）= 违反 hide 规则。

### Case 2（simple）· 若 modal 已建：验骨架视觉

**检查方法**：若 SettingsModal.vue 存在且 Case 1 某入口能打开它（开发调试用），对照 draft-settings-shell 验骨架。

**期望**（settings/spec §1 + §2）：
- 居中 **modal** + backdrop `blur(10px)`（非全屏覆盖，区别于 Overview）。
- 尺寸 ~900px × ~540px。
- 结构：`.modal-head`（设置 + 搜索 + 保存 pill + ✕）+ `.modal-body`（左 nav ~190px + 右 detail scroll）。
- 关闭恢复（Esc / 点背景 / ✕）。
- 无左竖条强调（用 inset ring）。

**判定**：
- 若 SettingsModal.vue **完全未建**（hide 策略）→ Case 2 标 🔇(未建)，**只验 Case 1**，整体 PASS。
- 若已建骨架 → Case 2 必验，任一不符 = FAIL。
- 若已建但三模式/5菜单/自动保存功能不全 → 不算 FAIL（DEFERRED），只验骨架视觉。

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. 测三入口（Case 1）：⌘, / 头像 / 齿轮。
3. `ls $ROOT/src-electron/renderer/src/components/settings/SettingsModal.vue` 判断是否已建。
4. 若已建 + 可打开：对照 draft-settings-shell 验 Case 2（居中 / blur / 尺寸 / 结构 / 关闭 / 无左竖条）。
5. 若未建：Case 2 🔇，仅 Case 1 判定。

## FAIL 判定

- 三入口任一触发不全功能 modal（Case 1）= FAIL（hide 规则）。
- 若已建：非居中 / 无 blur / 全屏覆盖 / 左竖条（Case 2）= FAIL。
- 若未建 → Case 1 PASS 即整体 PASS。
- PASS 后可与 W20 并行。
