# ADR 0034: 统一 file chip 通道——升级 .mention-file 为结构化 file segment

- **状态**: Accepted
- **日期**: 2026-07-16
- **上下文**: drawer-composer-injection 功能（cw-2026-07-16-drawer-composer-injection）

## 背景

feat-gui-optimize 引入了 Segment[] 架构（Message.content = `string | Segment[]`），其中 Segment 类型已预留 `{ type: 'file'; path: string; lineRange?: [number, number] }`，注释明确为"未来从 drawer/diff 选取追加到 composer"。

但现有 `#file` 通道是**伪结构化**的未完成态：

1. composer 输入 `#` → CommandPopover → `insertMentionChip('#', name)` 创建 `.mention-chip.mention-file`（绿色 chip）
2. 该 chip **不设 dataset**（textContent = `#name`）
3. `getSegmentsFromEl` 只对 `.slash-chip` 做结构化解析，`.mention-chip` 走 TEXT_NODE 分支 → 被读成纯文本段，**结构丢失**
4. `Turn.vue` 消息流渲染端只有 `skill` / `text` 分支，**无 file 分支** → file segment 发送后静默不渲染

drawer 选区/文件引用注入需要结构化的 file segment（承载 path + lineRange）。若新增第三种 chip 类型（`.file-chip`），会与现有 `.mention-file` 形成两个 file 通道，违反一致性。

## 决策

**不新增第三种 chip 类型。把现有 `.mention-file` 升级为真结构化 file chip：**

| 层 | 改动 |
|----|------|
| Chip 写入 | `insertMentionChip('#', name)` 的 file 用途改造为 `insertFileChip(path, lineRange?)`。创建 `.mention-chip.mention-file`（复用绿色样式），设 `dataset.chipType='file'` / `chipPath` / `chipLineStart` / `chipLineEnd`，用 `.chip-label` 子元素显示路径（有 lineRange 附 `:L10` 或 `:L10-20`），加 `.chip-x` + ZWSP spacer |
| Chip 解析 | `getSegmentsFromEl` 加 `.mention-file` 分支：`flushText()` → 读 dataset 产出 `{ type:'file', path, lineRange? }` → `rejectChips.add(chip)` 跳过子树 |
| 现有 # 路径 | `useCommandPopoverTrigger.onCmdSelect` 的 file 分支改调 `insertFileChip(payload.name)`（name 即 path，向后兼容） |
| 消息渲染 | `Turn.vue` 加 file badge 分支（绿色，复用 `--success`/`--success-soft` token，点击打开 drawer detail） |

`#` 输入路径和 drawer 注入路径**共用 `insertFileChip`**——同一机制，两种触发方式。

## 替代方案

- **新增独立 `.file-chip` 类型，保留 `.mention-file` 现状**：隔离性好，但产生两个 file chip 通道（mention-file 伪结构化 + file-chip 真结构化），未来维护者会困惑"为什么有两个 file chip"。且现有 `.mention-file` 的结构丢失是 bug，不修反而保留坏通道不合理。

## 后果

- **正面**：单一 file chip 通道，`#` 输入和 drawer 注入一致；修复了现有 `#` 通道的结构丢失 bug；复用绿色样式，不新增 CSS 类。
- **负面**：改动现有 `#` 输入路径（`insertMentionChip` 的 `#` 分支），但该路径本来就是坏的（结构丢失），属于修根因。`@` mention 分支不受影响（保留现状）。
