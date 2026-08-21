# W2 验收基线：P3 gate 复验改判（场景 3 restore/fork 重开一致性）

> 防篡改验收基线，执行中禁止修改。执行者：主 agent 亲自（dev app 独占，同前四 gate 模式）。创建：2026-08-19 22:40。

## 背景

- p1p4 P3 gate 判 FAIL（用户裁决 2026-08-19「restore 数据丢失绝不能判 PASS」），根因 = restore tmp 附着管线（40f2e0300 引入）。
- 根因已由 restore-fork-attach-fix 修复：W1（668273adb，直附着 + F3 归一化）+ W2（ec38e546f，attach 断言 + 真实 pi 等价测试 3 用例）。单测/等价级已验，**dev app 行为级复验未做**。
- 上次失败链（p1p4 gate/p3-gate-report.md §3.3）：restore 后发消息 → 原 JSONL mtime 零更新 + `$TMPDIR` 出现 `xyz-session-*` 孤儿 → 第二次重启重开 → 整轮消失、用量回退。
- fork 路径上次 gate 未覆盖（按代码同形判受累），本次补。

## 前置

- W1（renameSession 健壮性）committed 后执行——dev app 加载工作区代码，禁止半成品态验收。
- 环境隔离：dev 数据目录 `~/.xyz-agent-dev/`（端口 1420/9222/3310）；启动前 `lsof -i :1420 -P` 确认无占用；结束精确 kill 本方 PGID 并确认三端口清空。

## 验收场景（最小充分集 = 设计文档 restore-fork-attach-fix.md V1 + V3）

### V1 restore 现代文件后对话落盘（对齐 G1/G3）

1. `pnpm dev` → 新建 session（cwd 任选固定目录，模型 mimo）→ 发一轮普通对话。
2. kill dev（`kill -TERM -<PGID>`）→ 重启 → 侧栏重开该 session（走 restoreSession F2 直附着）。
3. 发「记住这句暗号：<本次唯一暗号>」等 assistant 回复完成。
4. **断言 A（落盘即时性）**：对话完成后原 JSONL mtime 推进、行数增长（对比发消息前快照）；`$TMPDIR` 无新增 `xyz-session-*.jsonl` 孤儿。
5. kill dev → 再次重启 → 重开同一 session。
6. **断言 B（第二次重开一致性，上次 FAIL 点）**：暗号轮完整在列（user + assistant）；用量不回退。

### V3 fork 后对话落盘（对齐 G2/G3）

1. 在 V1 session（或另建 session）上 fork。
2. fork 后发「记住这句暗号：<另一唯一暗号>」等回复完成。
3. **断言 C**：对话落 fork 文件（fork 文件 mtime/行数推进）；`$TMPDIR` 无孤儿。
4. kill dev → 重启 → 重开 fork session。
5. **断言 D**：暗号轮完整在列；fork 血缘 header `parentSession` 指针未断（读 fork 文件首行断言存在该字段）。

### 附加观察（非阻断，如实记录）

- `get_state().sessionFile` 与登记路径一致性（attach 断言已在运行时守护，dev 期无 throw 即通过）。
- 上次 gate §4 三项观察（turn-meta 计时、bash live、session 名回退）若再遇则记录对照，不做修复（范围外）。

## 通过标准

断言 A/B/C/D 全部成立 → P3 gate 改判 PASS（根因修复行为级闭环）；任一不成立 → FAIL，如实报告并归因。

## 产物

- gate/w2-gate-report.md（复验报告，含时间线表 + 截图 + 文件快照证据）
- p1p4 ledger：P3 gate 行状态更新 + 事件节收官记录

## 禁止事项

- 禁 mock dev app / 禁改生产代码；探针只读（CDP/DOM/文件系统读）。
- 禁碰打包版 TaiJi.app。
- 多实例坑：确认 browser-automation 连的是 `localhost:1420`（dev renderer）。
