---
title: VA-07 · P6 Settings（配置 modal 骨架 / hide 入口）
phase: P6
wave: 5
task: T6.2
group: FG6
priority: ★
---

# VA-07 · P6 Settings

> **v1 只 hide 入口**（spec §9 G-021）：⌘, / sidebar 头像 / workspace 齿轮均不触发。若 SettingsModal.vue 已建则验 modal 骨架视觉，但三模式 / 5 菜单 / 自动保存全 DEFERRED。
> 本文件自包含。完整全局清单见 [va-00-index.md](va-00-index.md)。

## 项目根

**$ROOT** = `/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 关联 harness 文档

| 文档 | 定位 |
|------|------|
| **Spec** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/spec.md` §4 P6 行 + §8.5 P6 v1 边界（hide 入口）+ §9 G-021（三模式触发 DEFERRED）+ §8.5 Round 3（hide 规则） |
| **Plan** | `$ROOT/.xyz-harness/2026-06-20-frontend-rebuild/plan.md` FG6（T6.2） |

## 本 VA 专属 design 文件（绝对路径）

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/settings/spec.md` | **Settings spec**（modal 骨架 + 三模式 A/B/C + 5 菜单差异 + 公共横切） |
| `$ROOT/docs/designs/v3-demo/settings/draft-settings-shell.html` | **主对照稿**：modal 骨架 + 三模式演示（Provider 落地页） |
| `$ROOT/docs/designs/v3-demo/settings/draft-provider.html` | Provider 菜单（DEFERRED 参考） |
| `$ROOT/docs/designs/v3-demo/settings/draft-extension.html` | Extension 菜单（DEFERRED 参考） |
| `$ROOT/docs/designs/v3-demo/settings/draft-system.html` | System 菜单（DEFERRED 参考） |
| `$ROOT/docs/designs/v3-demo/settings/draft-settings-agent.html` | Agent 菜单（DEFERRED 参考，命名遗留见 settings/spec §7） |
| `$ROOT/docs/designs/v3-demo/settings/draft-settings-skill.html` | Skill 菜单（DEFERRED 参考，命名遗留） |
| `$ROOT/docs/architecture/adr/0020-resource-loading-strategy.md` | 资源加载（skill / agent 来源 badge） |

## 待验收代码文件

| 文件 | 类型 |
|------|------|
| `$ROOT/src-electron/renderer/src/components/settings/SettingsModal.vue` | create（骨架，hide 入口） |

## 验收前置

- **VA-01 ~ VA-05 必须 PASS**。
- 启动：`cd $ROOT && npm run dev`（hide 入口检查无需 mock 数据）。

## 对照表

> v1 核心：**入口 hide 检查**。SettingsModal 若已建则验 modal 骨架视觉（居中 + backdrop blur），但功能全 DEFERRED。

| # | 检查项 | 对照 draft / spec | 期望 | 标记 |
|---|--------|------------------|------|------|
| 1 | ⌘, 不触发 | spec §9 G-021 + §8.5 hide 规则 | 按 ⌘, 无反应（入口 hide） | ✅ |
| 2 | sidebar 头像不触发 | spec §9 G-021 + §8.5 hide 规则 | sidebar 用户区无 settings 入口（或头像点击无 settings 响应） | ✅ |
| 3 | workspace 齿轮不触发 | settings/spec §1（入口）+ §8.5 | workspace 顶栏无齿轮按钮（或点击无反应） | ✅ |
| 4 | modal 形态（若已建） | draft-settings-shell + settings/spec §1 | 居中 **modal** + backdrop `blur(10px)`（非全屏覆盖，区别于 Overview） | ✅(若建) / 🔇(未建) |
| 5 | modal 尺寸（若已建） | settings/spec §2 | 宽 ~900px / 高 ~540px | ✅(若建) / 🔇(未建) |
| 6 | modal 骨架结构（若已建） | settings/spec §2 | `.modal-head`（设置 + 搜索 + 保存 pill + ✕）+ `.modal-body`（左 nav ~190px + 右 detail scroll） | ✅(若建) / 🔇(未建) |
| 7 | 关闭恢复 | settings/spec §1 + §5 | Esc / 点背景 / 点 ✕ 关闭，恢复原 workspace | ✅(若建) / 🔇(未建) |
| 8 | 与 Overview 区分 | settings/spec §1 + overview/spec | Settings = 居中 modal（表单）；Overview = 全屏覆盖（鸟瞰）——形态不同 | ✅(若建) / 🔇(未建) |
| 9 | 三模式 A/B/C | settings/spec §3 | — | 🔇 |
| 10 | 5 菜单（Provider / Skill / Agent / Extension / System） | settings/spec §4 + 5 个 per-menu draft | — | 🔇 |
| 11 | 自动保存 debounce 800ms | settings/spec §5 | — | 🔇 |
| 12 | 内置搜索 ⌘K（跨菜单） | settings/spec §5 | — | 🔇 |
| 13 | 冷蓝 token 一致 | settings/spec §6 | 无左竖条强调（用 inset ring） | ✅(若建) / 🔇(未建) |

## 执行步骤

1. `cd $ROOT && npm run dev`。
2. 验 hide 入口（#1-#3）：
   - 按 `⌘,`（mac）/ `Ctrl+,`（win/linux）确认无 modal 弹出。
   - 查 sidebar 用户区无 settings 入口（#2）。
   - 查 workspace 顶栏无齿轮（#3）。
3. 浏览器打开 `$ROOT/docs/designs/v3-demo/settings/draft-settings-shell.html`（若 SettingsModal 已建则对照 #4-#8）。
4. 若 modal 已建：验居中 + backdrop blur（#4）、尺寸（#5）、骨架结构（#6）、关闭恢复（#7）、与 Overview 形态区分（#8）。
5. 🔇 #9-#12 不验（三模式 / 5 菜单 / 自动保存 / 搜索全 DEFERRED）。
6. **判定规则**：若 SettingsModal.vue 完全未实现（hide 策略）→ 只验 #1-#3，#4-#8/#13 标 🔇(未建) = PASS。若已建骨架 → #4-#8/#13 必验。

## FAIL 判定

- ⌘, / 头像 / 齿轮任一触发 modal 但功能不全（#1-#3）= FAIL（违反 hide 规则，spec §8.5 Round 3）。
- 若已建 modal：非居中 / 无 backdrop blur / 全屏覆盖（#4）= FAIL（与 Overview 混淆）。
- 若已建 modal：用左竖条强调（#13）= FAIL。
- 若完全未建（hide）→ #1-#3 PASS 即整体 PASS。
- 🔇 项（#9-#12）不影响判定。
- PASS 后进 [va-08-p6-overlays.md](va-08-p6-overlays.md)。
