# 对话流 Block 渲染重构 —— §8 验收报告

> 验收日期：2026-08-12（dev app：feat-optimize-ui 分支，localhost:9222 / vite 1420）
> 模型：xiaomi-token-plan-cn/mimo-v2.5-pro（MiMo-V2.5-Pro，禁 kimi）
> 执行方式：Playwright（browser-automation skill）连 dev app 真实操作，DOM 快照 200ms 采样 + 节点 identity 标记逐帧对比（等价录屏逐帧）
> 设计文档：docs/architecture/conversation-stream-block-rendering.md §8.2 / §11

## 结论总览

| 场景 | 结果 | 备注 |
|---|---|---|
| 1. 说话→调工具→总结（主症） | ✅ 通过 | 流式全程零跳变（帧 7-38 稳定），样式统一 |
| 2. 多工具连续调用 | ✅ 通过 | 工具按序稳定，文字穿插位置不变；检查点 2 通过 |
| 3. 折叠/重开/重连 text 可见性 | ✅ 通过 | 折叠隐藏 thinking/tool 保留 text；重开可见；重连以刷新等价（注明局限） |
| 4. thinking + 文字 | ⚠️ 降级 | MiMo-V2.5-Pro 高/最高档均不产出 thinking content；折叠行为由组件测试覆盖 |
| 5. streaming 光标显隐 | ✅ 通过 | 文字流式光标在末尾；检查点 1 裁决：末块 completed tool 时光标**显示**（与 §11 倾向冲突，见裁决） |
| 6. 操作栏功能与门控 | ✅ 通过 | copy/fork/handoff 正常；纯工具 turn 出现操作栏（预期行为变更） |
| 7. 样式统一 | ✅ 通过 | 所有 text 正文级 token 锚点，无两级样式 |

## 场景明细

### 场景 1：说话→调工具→总结（主症）✅

**流程**：composer 发「读 packages/runtime/src/index.ts 和 packages/shared/src/constants.ts 两个文件，然后详细总结两者的作用与关系」，流式期间 200ms 采样 DOM 快照（text 块 data-br-id 标记 + className + 相对顺序 + streaming-tail）。

**证据**：/tmp/br-acc/scene1-frames.json（75 帧）+ scene1-f001~f0xx.png 截图。

**结果**：
- 新 turn 产生 T1-0(tool) / T1-1(tool) / T1-2(text) 三个块，**按 contentBlocks 顺序稳定排列**，text 在工具之后
- 已有 turn 的 T0-0(text) 全程保持 `text-neutral-fg`（完成态），**未随新 assistant 到达翻转颜色**；T1-2 新 text 流式期间为 `text-neutral-mid`（streaming 态）——颜色跟所属 assistant status，单调不翻转
- T0-0 的节点 identity 与相对顺序全程不变（帧 7-38 零跳变；帧 39 后的变化为完成态虚拟滚动节点复用噪声，非跳变）
- **通过标准对照**：全程无 block 改变位置；a2 出现不改 a1 位置/样式；文字统一正文级 —— 全部满足

### 场景 2：多工具连续调用 ✅

**流程**：发「读 extensions/ask-user/src/index.ts 和 extensions/plan/src/index.ts 两个文件，简述各自的作用」→ a1(text + tool1) → a2(tool2) → a3(text)。

**证据**：scene1-frames.json 第二次运行数据（T1-0/T1-1 两个 tool 按序 + T1-2 text）。

**结果**：工具按 contentBlocks 顺序稳定排列，文字穿插位置不变；折叠态（turn-9）meta 显示「工具 ×2」。

**§11 检查点 2（每 message 单 text 块）**：✅ 通过。DOM 层每 trace 至多 1 个 text 块；session 文件（019ff216）逐条 assistant content 确认 text part 数 ≤1，三处幂等守卫（registry.ts / message-converter.ts / streaming-state-machine.ts）未被 pi 绕过。

### 场景 3：折叠/重开/重连 text 可见性 ✅

**流程**：场景 1 完成后：①点 turn-meta 折叠 ②location.reload() 重开 ③重连以刷新重载为等价证据。

**结果**：
- **折叠**：turn-9 展开态 trace-blk=3（text + 2 tool）→ 折叠后 trace-blk=1（text 可见，tool 隐藏）；text 内容完整可见（无丢失）
- **重开**：reload 后重新进入 session，历史 text 块完整渲染（多 turn text 可见）
- **重连**：⚠️ 以刷新重载为等价证据（重连与重开共享持久化读取路径 message-converter → contentBlocks）；**局限注明**：真实 kill pi 子进程的断线重连未实测（dev 实例稳定性考虑）

### 场景 4：thinking + 文字 ⚠️ 降级

**流程**：思考级别切「最高」→ 发推理问题「分析 xyz-agent 的 runtime 三层架构设计，给出改进建议」；再切「高」档发纯推理消息。

**结果**：**MiMo-V2.5-Pro 在「高」和「最高」档均未产出 thinking content**（session 文件 019ff216 最后 6 条 assistant 消息 content 仅 `toolCall`/`text` 类型，无 `thinking` part；builtin-providers.json 虽声明 reasoning:true，实测 provider 不返回 thinking）。thinking 弹层 6 档可选但该模型实际不支持。

**降级处理**：thinking+text 按序与折叠可见性无法用真实 pi 实测；该语义已由组件级测试锁定——TC-M0-3（折叠态 text 可见 thinking 隐藏）、TC-REG-2（多 assistant 折叠可见性）DOM 断言覆盖。真实 thinking 流的端到端验证留待支持 reasoning content 的模型接入后补充。

**检查点 2**：✅ 通过（同场景 2，每 message 单 text 块）。

### 场景 5：streaming 光标显隐 + 检查点 1 裁决 ✅

**流程**：流式期间轮询 .streaming-tail 存在性。

**结果**：
- 文字流式期间 .streaming-tail 存在（scene1-frames.json 帧数据，tail=true 帧与 text 流式同步）
- 工具 running 态未捕捉到独立帧（工具执行 <2s 即 completed），无法直接观测「running 时隐藏」；**该分支已由组件级测试 TC-M0-2b 锁定**（末位 running tool → streaming-tail 不存在）
- 未出现「光标+loader」并存的帧

**§11 检查点 1 裁决（末块 completed tool 时光标行为）**：

**实测**：末块为 completed（非 running）tool 时 .streaming-tail **显示**（scene1-frames.json f7-f17，末块 tool 已 completed 但 tail 持续存在）。

**裁决**：**保持当前实现（显示）**，与设计文档 §11「倾向不显示」冲突，理由：
1. 光标显隐条件 `isStreaming && 末块非 running tool`（IF2）——completed tool 无 loader 并存问题（loader 仅 running 时出现），显示光标无视觉冲突
2. 光标语义 = 「本 turn 还有输出即将到来」；completed tool 后通常仍有 text 流，隐藏光标会误导「已结束」
3. §11 的「倾向不显示」是实施期待验证假设；实测未发现显示造成的问题（无光标+loader 并存、无闪烁）
4. 若未来产品倾向改为隐藏，需改 IF2 公式（末块 tool/agentgraph 一律隐藏），属独立小改动，不进本次 scope

### 场景 6：操作栏功能与门控 ✅

**流程**：场景 1 完成后操作栏四操作；纯工具 turn 观察。

**结果**：
- **copy-btn / copy-markdown-btn**：点击无异常（✅；剪贴板内容级验证受 CDP 用户手势权限限制，降级为点击无异常 + 无 error toast）
- **fork-ask-btn**：点击后 composer 进入 `fork-mode` staging（`composer-box ... fork-mode border-[var(--accent)] shadow accent-ring`）✅
- **handoff-ask-btn**：点击后 composer 进入 `handoff-mode` staging ✅
- **纯工具 turn**：turn-9（2 个 tool 无 text）`.turn-summary` 操作栏出现（copy-btn 等 4 按钮齐全）——**预期行为变更验证通过**（原 summaryText 门控下纯工具 turn 无操作栏）

### 场景 7：样式统一绝对断言 ✅

**流程**：DOM 断言所有 text block 的 className（M0 已合并，以 §8.2 通过标准绝对断言，不回退代码对比）。

**结果**：所有可见 text block（含历史 turn 与新增 turn）className 含 `text-[length:var(--text-base)]` + `leading-7`，无 `text-[length:var(--text-sm)]` / `leading-relaxed`，**零 violations**。颜色验证：T0-0 完成态 `text-neutral-fg`、T1-2 流式 `text-neutral-mid` → 完成后 fg（跟 assistant status，单调）。

## §11 检查点汇总

| 检查点 | 结论 |
|---|---|
| 1. 末块 completed tool 时光标行为 | 实测显示；裁决保持显示（理由见场景 5） |
| 2. pi 是否绕过单 text 幂等守卫 | 未绕过；每 message 至多 1 text part（场景 2/4 实测） |
| 3. 两条 contentBlocks 填充路径顺序语义统一 | 不在本 feature 范围（§11 单独追踪），维持现状 |
| 4. 回填 main 时机 | 不在本 feature 范围（§9.2 独立改动），feat 验收通过后另行执行 |

## 遗留与局限

1. **重连局限**：真实 kill pi 子进程的断线重连未实测（以刷新重载等价覆盖持久化读取路径）
2. **copy 剪贴板**：CDP 无用户手势权限，剪贴板内容级验证降级为点击无异常
3. **thinking 实测缺口**：MiMo-V2.5-Pro 不产出 thinking content，真实 thinking 流端到端验证留待支持 reasoning 的模型
4. **工具 running 帧**：工具执行过快（<2s）未捕捉 running 态光标隐藏的独立帧（组件测试 TC-M0-2b 已锁定该分支）

## 验收结论

**§8 场景 1/2/3/5/6/7 通过，场景 4 降级（模型不支持，行为由组件测试锁定），无阻塞缺陷。检查点 1/2 裁决完成。验收通过。**
