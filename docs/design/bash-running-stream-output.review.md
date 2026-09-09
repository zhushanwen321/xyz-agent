# 对抗式审查报告：bash-running-stream-output.md

> 主审（tech-design-review）报告，覆盖 P0-1~11、P0-13~18、P0-21、全部 P1；P0-12/19/20 归影响面审，本文仅 INFO 交接。
> 审查日期：2026-09-08。文档引用的全部关键源码事实已逐一 read 实装版核实（见「事实核实记录」）。

## Summary

**0 must-fix, 4 suggestions.** 文档质量显著高于一般设计文档：三层根因的因果链与源码逐字吻合（本审独立核实了全部 6 处关键引用，零事实错误）；方案对比含 4 方案双维度评估；验收 S1-S5 全部为真实场景（dev app 真实 session、真实 bash 命令），且含负面行为反向验证与 live ≡ reload 场景。建议项均为一致性/完备性打磨，不阻塞实施。

## 事实核实记录（P0-11）

以下文档声称全部与实装源码核实一致：

| 文档声称 | 核实结果 |
|---|---|
| event-adapter 只取 `.details`，content 文本被丢弃（§3.3） | ✅ `event-adapter.ts:961-978` 逐字吻合 |
| registry 只写 `tool.detail`，output 等 end 才写（§3.3 根因 2） | ✅ `registry.ts:668-680` handler 仅 spread `{ ...c, detail }`；end 路径 `registry.ts:628` 确为 `...(output !== undefined && { output })`（D4 声明准确） |
| pi bash 100ms 节流推送 `{content:[{type:'text',text}], details:{truncation,fullOutputPath}}`（§3.3 根因 1） | ✅ `pi/dist/core/tools/bash.js:147`（BASH_UPDATE_THROTTLE_MS=100）、`:253-263`（emitOutputUpdate 形态逐字吻合）；另有 `:280` 初始 `onUpdate({content:[], details:undefined})`，与 U1「空数组 → output:''」的声明自洽 |
| Block.vue 展开区 `v-if="toolExpanded && (displayContent \|\| guiComponent)"` + header invisible 无内容检查（§3.3 根因 3） | ✅ `Block.vue:142`、`:132/:138`（invisible 条件）、`:317`（displayContent 取 tool.output） |
| `toolTailLines` bash 取 outputRaw，running 恒 undefined（D3） | ✅ `Block.vue:357-361` |
| `normalizePiToolResult` 已存在且语义匹配（D1 证据） | ✅ `normalize-tool-result.ts:45-79`，content 数组 → stripAnsi 文本 + outputRaw ANSI 分离 + details/images |
| `message.tool_call_update` payload 走占位桶（§4 WS 契约安全性） | ✅ `protocol.ts:780`（type 仅列名）+ `ServerMessageMap` 占位桶定义 |
| mock 只发 detail（§4 向后兼容） | ✅ `run-send-stream-branches.ts:85-88`（string detail），且该文件确实含 `__gui__` 分支（:101-112）——S4① 验收场景可执行 |
| pi 快照上界 2000 行 / 50KB（D4） | ✅ `truncate.js:10-11` |

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §7 U2 vs §4 数据流图 | P1-5 内部一致性 | §4 修复后数据流图标注「c.detail = ...（不变）」，但 U2 代码把 detail 写入从现状的**无条件** `{ ...c, detail }`（registry.ts:676）改为条件 `...(detail !== undefined && { detail })`——这是一处未声明的语义变化（detail 缺失的帧将保留旧值而非清空）。当前两个生产端（adapter/mock）都恒带 detail，行为实际等价，但文档自相矛盾且静默改语义 | 要么 U2 代码保持 detail 无条件写入（真正「不变」），要么在 U2 显式声明这处条件化及其理由 |
| SUGGESTION | §7 回归面核对表 | P0-12→INFO 交接 + P1-10 | 回归面核对表遗漏 `useToolMeta.ts:48-54`：bash 属 `OUTPUT_META_TOOLS`，行数/字符数统计直接消费 `tool.output`——修复后 running 态 header 将**首次**出现实时增长的「N 行」meta 项（现状 running 态无此统计）。属可见行为变化：未声明、未验收（S1-S5 均未覆盖 running 态 meta 行为）。可能是有益变化，但需显式裁决并补 S1 观察点 | 回归面表补一行；S1 通过标准增加「running 态 meta 行数统计行为符合预期（显示或不显示，二选一声明）」 |
| SUGGESTION | §3.3 / §4 | P1-8 细节事实 | 文档两处写 `displayContent = tool.output \|\| ...`，实装为 `displayContent = result.value \|\| ...`（`result = computed(() => props.tool?.output)`，Block.vue:315-317）。语义等价，不影响决策，但引用代码应逐字 | 改为引用实装表达或标注「result 即 tool.output」 |
| SUGGESTION | §8.2 S5 | P1-6 | S5 通过标准含「无内存失控迹象」——手动观察无法证伪内存问题（5s 目测不等价于内存有界）。2MB 输入经 pi 快照截断为 ≤50KB，成本有界已有源码证据（D4），此项验收实际保护的是渲染流畅度 | 措辞聚焦可观察项（不卡顿/不白屏/截断标记），内存有界性引用 D4 源码证据即可，不必作为手测通过标准 |

### 逐项判定摘要（通过项依据）

- **P0-1/2/3 结构**：五段骨架齐备（§1-2 背景 / §3-4 现状根因 / §6-7 方案 / §8 验收 / §9.2 拆分）；SCQA 开篇 + 一句话结论在文档头部；各章首句均为结论。通过。
- **P0-4/5/6 问题定义**：§3.1 用 ASCII 图给出使用者真实所见并引用用户原话，非复述方案；§3.2 失败模式表含被主 bug 掩盖的边界 C（completed 空输出），识别了隐藏问题；「partialResult / AgentToolResult 规范形态 / 扁平 progress 形态」在 §4 开头集中定义并绑例子。通过。
- **P0-7/8/9 方案对比**：§6.5 四方案（A-D）双维度（长期架构/短期成本）+ 风险 + 明确裁决，被否方案有「被否若用」反例推演。通过。
- **P0-10 对抗核心**：§3.3 根因 1（数据层丢弃）是真正的根因，U1 直接命中；根因 2/3 的下游修复经 §4 因果链闭环到 §2 三个目标。失败模式 C 由 D2 恒渲染同构消除，不是只让症状消失。通过。
- **P0-11 关键事实**：见事实核实记录，9/9 全部吻合。通过。
- **P0-13/14/15/21 验收**：§8 存在且 5 场景全部 testable（真实 dev app + 真实 bash 命令 + 明确通过标准），回溯 §2 目标；非单测非 mock（单测职责单列声明「非验收替代」）；投入与「中」改动规模匹配；S3（live ≡ reload）/S4（既有流式语义回归）构成邻居系统不变量场景。通过。
- **P0-16 运行时断言**：节流值/快照形态/上界常量等运行时断言全部附 file:line 证据且经本审查独立核实为真；实施期检查点（§9.3 AnsiText 卡顿）有降级路径（U3 局部节流，不改设计）。通过。
- **P0-17 物理数据流图**：§4 修复前/后两张物理数据流图，各节点标物理位置（pi dist / adapter / WS / registry / Block.vue）。通过。
- **P0-18 错误恢复**：§5.2 两条失败路径均配恢复指引（重开 session 走既有收口路径，明确「本设计不新增故障路径」）。通过。
- **P1-1/2/3/4**：例子充分（§5.1 终态图）；§9.2 每单元有 justification 列；背景对中等开发者友好；被否 alternatives 有记录。通过。
- **P0-12/19/20**：归影响面审，本审不判定。交接线索：除上表 useToolMeta 外，`copyContent`（Block.vue:344-349）running 态复制内容将从「仅命令」变为「命令+中间输出」，建议影响面审一并核对。

## 结论

设计就绪（DoR 达标），可进入实施。4 条建议在实施 PR 内顺手消化即可，无需返工设计。
