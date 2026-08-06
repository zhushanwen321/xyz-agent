# @zhushanwen/pi-cw-tool

把 `cw`（Agent-agnostic 编码流程编排 CLI）包成 4 个 role-restricted pi 工具，按 role 限制可调 action。

## 背景

v4 递归编排方案要求 cw 命令包成 pi 自定义工具（cw-tool），按 role 限制可调 action——把「独立 review」「层主不写码」从 prompt 软约束变成**工具白名单硬约束**。

## 4 个工具

| 工具 | 谁用 | 允许的 cw action（白名单） |
|---|---|---|
| `cw_planning` | epic/feature/slice 层主 | clarify, plan, execute, replan, retrospect, closeout + 只读(status, handoff, list, tree, frontier) |
| `cw_wave` | wave 层主 | clarify, plan, replan, retrospect, closeout + 只读(**无 execute/test/design-review/exec-review**) |
| `cw_dev` | wave 内 dev | execute, test + 只读(status, handoff) |
| `cw_review` | 审 design/exec | design-review, exec-review + 只读(status) |

层主的 cw-tool 不含审查命令 → 物理上调不了审查 → 必须派独立 review-agent。

## 参数

所有工具共享参数 schema：

- `action`（枚举，受限于此工具白名单）—— 第一道约束（LLM 输入）
- `unitId`（必传）—— `cw --unitId`
- `input?`（JSON 内容字符串）—— 经 stdin 传给 cw（`--input -`）
- `inputFile?`（文件路径）—— `--input <path>`（与 input 互斥）
- `commitHash?`（execute 关联 commit）—— `--commitHash`

## 返回

返回 `details.ok` 区分成功/失败（不抛异常）：

- 成功：`{ ok:true, action, unitId, stdout, parsed, data? }`，`content.text` 为 cw 原始 stdout
- 失败（白名单拒绝 / 非零退出 / stderr 非空 / spawn 异常）：`{ ok:false, action, unitId, error }`

## cw 路径解析

通过 `process.env.PATH` 解析（spawn 裸命令名 `cw`），不硬编码绝对路径。

## 开发

```bash
cd extensions/cw-tool
npx tsc --noEmit   # 类型检查
npx vitest run     # 测试（mock spawn，不真调 cw）
```
