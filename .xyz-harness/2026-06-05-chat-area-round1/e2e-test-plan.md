---
verdict: pass
---

# E2E Test Plan — Chat Area 第一轮优化

## Test Scenarios

每个 scenario 对应一条或多条 spec AC。验证方式以手动测试为主（UI 交互），辅以部分自动化检查（写入剪贴板内容、session label 字段、WS 消息类型）。

### Scenario 1: 消息操作菜单显示与交互 (AC1)

**Preconditions:**
- 至少有一个 panel 含 1 条 user 消息和 1 条 assistant 消息
- 应用运行在 dev 模式

**Steps:**
1. 鼠标 hover 任意一条消息
2. 观察 `⋯` 按钮出现位置（assistant 在右侧、user 在左侧）
3. 点击 `⋯` 按钮
4. 验证菜单展开，包含 5 项（复制 / 复制纯文本 / 分割线 / Navigate / Fork / Clone）
5. 按 Esc，验证菜单关闭
6. 点击菜单外区域，验证菜单关闭

**Pass Criteria:** 按钮位置正确，菜单内容完整，关闭行为正常

### Scenario 2: 单条消息复制 (AC2)

**Preconditions:** 消息含 thinking block + tool call card + 正文

**Steps:**
1. 点击消息 `⋯` → 「复制」
2. 验证 Toast「已复制」出现并在 1.5s 内消失
3. 在外部编辑器（VSCode/TextEdit）粘贴
4. 验证内容包含：
   - Thinking 块展开文本（`[Thinking: ...]` 之外的实际内容）
   - Tool call 卡片（`[Tool: read ✓ src/file.ts]`）
   - 消息正文

**Pass Criteria:** 剪贴板内容完整，Toast 反馈正确

### Scenario 3: 纯文本复制 (AC2)

**Steps:**
1. 点击消息 `⋯` → 「复制纯文本」
2. 粘贴到编辑器
3. 验证内容不包含 markdown 符号（`# * [ ]` 等）

**Pass Criteria:** 纯文本格式正确

### Scenario 4: 批量选择模式进入与计数 (AC3)

**Preconditions:** panel 含 ≥3 条消息

**Steps:**
1. 点击 panel header 的 `≡` 按钮
2. 验证所有消息左侧出现 hover 显现的 checkbox
3. 依次点击 2 条消息
4. 验证浮动栏显示「已选 2 条消息」
5. 再次点击其中一条，验证取消选中，计数变为 1
6. 点击「取消」，退出选择模式

**Pass Criteria:** 模式切换、选中/取消、计数均正确

### Scenario 5: 批量复制包含 thinking/tool call (AC4)

**Preconditions:** 选中的消息中至少 1 条含 thinking + tool call

**Steps:**
1. 进入选择模式，选中 2 条消息
2. 点击「复制 Markdown」
3. 粘贴到编辑器
4. 验证格式为：
   ```
   --- 助手 14:23 ---
   [Thinking: ...]
   [Tool: read ✓ src/file.ts]
   消息正文...
   --- 用户 14:24 ---
   消息正文...
   ```

**Pass Criteria:** 拼接格式符合 spec

### Scenario 6: 分支 pill 显示与导航 (AC5)

**Preconditions:** 当前 entry 有 ≥2 个 children

**Steps:**
1. 观察消息气泡底部的分支 pill
2. 验证 pill 显示数字 ≥2，且为实色可点击
3. 点击 pill，dropdown 展开
4. 验证每项显示状态圆点 + 分支名，当前活跃分支高亮
5. 点击非活跃分支
6. 验证视图切换到目标 entry，dropdown 关闭

**Pass Criteria:** pill 数字正确，导航触发正确

### Scenario 7: 无分支 pill 行为 (AC5)

**Preconditions:** 当前 entry 有 ≤1 个 children

**Steps:**
1. 观察消息气泡底部的分支 pill
2. 验证 pill 显示 `1`，半透明，不可点击

**Pass Criteria:** 无分支时显示半透明 `1`

### Scenario 8: Utility Rail 显示与滚动 (AC6, AC7, AC12)

**Preconditions:** 消息列表超过 1 屏高度

**Steps:**
1. 鼠标 hover panel body
2. 验证右侧出现 36px utility rail
3. 滚动到顶端，验证「↑ 回到顶端」按钮隐藏
4. 向下滚动 100px，验证「↑ 回到顶端」按钮出现
5. 滚动到底端，验证「↓ 回到底部」按钮隐藏
6. 向上滚动 50px，验证「↓ 回到底部」按钮出现
7. 点击「↓ 回到底部」，验证滚动到底部
8. 点击「↑ 回到顶端」，验证滚动到顶端
9. 创建分屏，验证每个 panel 有独立的 rail

**Pass Criteria:** rail 全高贯穿，按钮显隐与功能正确

### Scenario 9: 侧边栏折叠 (AC8)

**Preconditions:** 侧边栏展开

**Steps:**
1. hover 侧边栏右边缘手柄，验证手柄高亮
2. 点击手柄，验证侧边栏折叠（width: 0），左边缘出现 `▸` 按钮
3. 点击左边缘 `▸`，验证侧边栏展开
4. 再次折叠，点击 header 右上角 `◀`，验证折叠
5. 展开后再次点击 `◀`，验证折叠
6. 验证三种入口都有效

**Pass Criteria:** 三种入口都能正确切换，width 过渡流畅

### Scenario 10: macOS 全屏布局 (AC9)

**Preconditions:** macOS 系统，应用窗口化

**Steps:**
1. 触发 macOS 全屏（绿色按钮 / Cmd+Ctrl+F）
2. 验证 brand 标识上移到 Row1
3. 验证 `+ New Session` 按钮变为 `width: 100%` 通栏
4. 验证 Row1 没有 `padding-left: 68px`
5. 退出全屏
6. 验证 brand 回到 Row2，Row1 恢复 `padding-left: 68px`

**Pass Criteria:** 两种状态切换正确，无布局抖动

### Scenario 11: Fork/Clone 命名 (AC10)

**Preconditions:** 当前 session 名 `my-project`

**Steps:**
1. Fork 当前 entry
2. 验证 session 列表中出现 `my-project-fork`
3. Clone 当前 session
4. 验证 session 列表中出现 `my-project-clone`

**Pass Criteria:** 后缀格式正确

### Scenario 12: 发送模式自动切换 (AC11)

**Preconditions:** AI 正在生成回复（`isGenerating === true`）

**Steps:**
1. 在 textarea 中输入消息
2. 验证状态栏显示 `Steer · 将中断当前 AI 处理`（accent 色）
3. 按 Enter
4. 验证 WS 收到 `message.steer` 类型消息
5. 验证 AI 处理被中断
6. 退出生成状态，再输入消息
7. 验证状态栏显示 `Send · Enter 发送`（灰色）
8. 按住 Alt 键
9. 验证状态栏切换为 `Queue · Alt+Enter 排队`（warning 色）
10. 按 Alt+Enter
11. 验证 WS 收到 `message.follow_up` 类型消息

**Pass Criteria:** 模式自动切换与手动切换正确，RPC 类型正确

### Scenario 13: 分屏独立 rail (AC12)

**Preconditions:** 已有 1 个 panel

**Steps:**
1. 触发分屏
2. 验证新 panel 也出现独立 utility rail
3. 在 panel 1 滚动到底部
4. 验证 panel 2 滚动位置不受影响
5. 验证 panel 1 的「↓ 回到底部」按钮独立显隐

**Pass Criteria:** 分屏后每个 panel 行为独立

## Test Environment

| 项 | 值 |
|----|---|
| 平台 | macOS 14+（主测平台），Windows/Linux（回归兼容） |
| Electron | 当前 main 分支版本 |
| 浏览器 | 不适用（Electron 渲染进程） |
| 测试数据 | 使用 fixture session 包含 thinking/tool call/分支/多 panel |
| 自动化框架 | Vitest（单元测试）+ 手动 E2E（UI 交互） |

## Automation vs Manual Split

| 类型 | 覆盖 |
|------|------|
| **自动化** | `collectMessageContent` / `clipboard` / `rebindAfterFork` label / WS 协议类型检测 / `stores/sidebar` toggle |
| **手动** | 所有 UI 交互（hover/click/animation/transition） |
| **混合** | 批量复制内容比对（自动化生成 baseline + 手动核对） |

## Test Data Fixtures

- `tests/fixtures/messages-with-thinking.json`: 含 thinking + tool call 的消息列表
- `tests/fixtures/branch-tree.json`: 含分支的 session 树结构
- `tests/fixtures/sidecar-protocol-messages.json`: 协议消息样例
