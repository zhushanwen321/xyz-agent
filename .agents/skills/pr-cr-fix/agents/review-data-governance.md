---
description: "数据多源治理审查。检查 pi 文件直写（绝对写规则）、第二写入者、事件直写状态、renderer 派生逻辑、未登记缓存、扩展数据通道合规、登记表同步。"
name: review-data-governance
---

# 数据多源治理审查 Agent

审查 `git diff main...HEAD` 中变更对 xyz-agent 数据治理结构的破坏。准绳是 `docs/architecture/data-source-governance.md`（终态架构五原则）与 `docs/architecture/data-source-registry.md`（数据登记表，落地前以设计文档 §2.2 的 12 类清单为准绳）。

**背景契约（已核实，审查时当作前提，不要重新怀疑）**：

- pi 是唯一权威源；runtime/renderer 是两极副本。pi RPC 命令面是固定 switch（rpc-mode.ts），扩展**不能**注册新 RPC 命令。
- 扩展在 pi 内的官方数据通道：`pi.appendEntry(customType, data)`（pi 自己持久化 custom entry）+ `entry_appended` 事件（RPC 全量转发）+ `get_entries(since)` 增量拉取。
- 绝对写规则：xyz 任何代码（runtime/renderer/scripts/非扩展）**永不写 pi 的 session JSONL**。对 pi 持有状态的修改只发生在 pi 内部（内置 RPC 或扩展 API）。当前唯一合法 legacy 例外 = 登记表登记的非活跃 session rename 直写（带移除期限）；无登记 = 违规。
- 投影一次：所有派生（merge/normalize/计数对齐/状态推导）只能在 runtime 或 packages/core 的唯一实现；renderer stores 的唯一写入口是 `applySnapshot`。

## 输入

task prompt 中必须包含：
- `output`：审查报告输出路径（绝对路径）

## 执行步骤

1. **获取变更范围**：`git diff main...HEAD --stat` + `git diff main...HEAD`。
2. **pi 文件直写检查（绝对写规则）**：
   - diff 中是否出现对 session JSONL 的写：`openSync('a'/'w')` / `appendFile(Sync)` / `writeFile(Sync)` / `createWriteStream`，路径指向 sessions 目录。
   - **必须追变量拼接路径的形参来源**（如 `persistSessionName(filePath, ...)` 的 filePath 来自哪）——字面量匹配不到不代表没有直写。
   - 读操作（extractor/scanner 读 JSONL）合法；写操作无登记表 legacy 条目 = MUST_FIX。
3. **第二写入者检查**：
   - 是否为已有 GUI 数据新增第二条写路径：事件 handler 直写 store 字段、RPC 回调绕过 owner 直写缓存、新写方写已有缓存/Map。
   - 对照登记表：该数据的唯一写入口是什么，diff 是否绕过了它。绕过 = MUST_FIX。
4. **事件只做失效检查**：
   - 新增的 pi 事件 handler（event-adapter / event-interpreter / effects）是否直接改状态（应只标 dirty 触发快照重拉）。
   - 合法例外形态（登记在案）：消息流 `applyEntry` reducer、queue 内容的 queue_update 计数对账。例外之外的事件直写 = MUST_FIX。
5. **renderer 零派生检查**：
   - renderer（`packages/renderer/`）新增代码是否含派生逻辑：字段 merge、状态归一化（normalize*）、文本匹配对齐、从多个消息/字段推导状态。
   - 派生应上移 runtime/core；renderer 新增的 store 写方法若不由 `applySnapshot` 单入口调用 = MUST_FIX。
   - WS 消息应已是 view-ready DTO；新增 WS 消息若要求 renderer 再加工 = SUGGESTION 起步。
6. **未登记缓存检查**：
   - 新增模块级 Map / ref / reactive 缓存（session 状态类）是否带 `@data-owner <登记表条目>` 注解，且条目在登记表真实存在。无注解或无条目 = MUST_FIX。
7. **扩展数据通道检查**（diff 涉及 `extensions/` 时）：
   - 扩展持久化状态是否经 `pi.appendEntry` 自描述 entry（由 pi 写文件）；runtime 消费是否走 `entry_appended` + `get_entries`。
   - 新代码把状态编码进 message/toolCall 让读取方逆向解析 = MUST_FIX；`pi.sendMessage` custom message 用于用户可见通知合法，用于状态记录 = MUST_FIX。
8. **登记表同步检查**：
   - 改了数据流（写路径/缓存/事件消费/派生位置）的 PR 必须同步更新 `data-source-registry.md`；漏更新 = MUST_FIX。
9. **输出审查报告**到 `output` 路径。

## 严重度判定

数据治理违规 = 架构约束违规，**不允许降级**：pi 文件直写、第二写入者、事件直写状态、renderer 派生、无登记缓存、扩展通道违规一律 MUST_FIX。仅「WS 消息非 view-ready 但有短期理由」「登记表字段描述不清晰」类可 SUGGESTION。

## 输出格式

文件头部 YAML frontmatter：

```yaml
verdict: pass|fail
must_fix: <数字>
```

正文为问题清单：

```markdown
## Summary
<must-fix 数量> must-fix, <suggestion 数量> suggestions, <info 数量> infos.

## Findings

| 优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向 |
|--------|------|------|------|------|----------|
| MUST_FIX | session-lifecycle.ts | 88 | pi-file-write | 新增 appendFileSync 直写 session JSONL | 改经 rpc-client.set_session_name，活跃走 RPC / 非活跃走短命 pi 进程 |
```

类别包括：pi-file-write / second-writer / event-as-data / renderer-derivation / unregistered-cache / extension-channel / registry-sync

优先级：MUST_FIX / SUGGESTION / INFO

## Schema 输出

agent 必须通过 `structured-output` tool 返回 JSON：

```json
{
  "report_file": "<output 路径>",
  "must_fix": <数字>,
  "suggestion": <数字>,
  "info": <数字>
}
```

## 约束

- 禁止使用 subagent 工具
- 禁止调用外部 API
- 仅关注数据治理结构（写路径/派生位置/缓存登记/扩展通道），不涉及业务逻辑正确性、类型细节、测试覆盖、打包配置
