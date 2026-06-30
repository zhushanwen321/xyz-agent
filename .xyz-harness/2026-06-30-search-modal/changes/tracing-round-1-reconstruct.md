# 追踪 Round 1 — 禁读重建

> 重建源：仅 spec.md（设计规范）+ SearchModal.vue（前 100 行模板+注释）+ search-data.ts（前 60 行）。
> 禁读 requirements.md / decisions.md 完成重建后，才对照 requirements.md 做 diff。
> 类型约定：**F**=功能/用例层 · **K**=契约/约束层（键盘/无障碍/数据契约）· **D**=细节/术语层。

## 独立重建

### Actor 清单

- **用户**（主 Actor）：任意视图状态下操作 ⌘K 浮层的唯一人类角色。
- **数据提供者（系统侧，非主动 Actor）**：
  - 命令注册表（应用命令 + pi slash 合并源）
  - 项目索引后端（spec 写「LSP / ripgrep」；search-data.ts 注释亦写「LSP / 命令注册表 / 会话库」）
  - 本地会话库
  - localStorage（recents 持久化）

### 用例（主流程/替代/异常）

**UC-A：唤起浮层并浏览最近项（recents）**
- 主流程：⌘K/Ctrl+K → 模糊遮罩+居中浮层 → 输入框自动 focus 光标置末 → 空查询展示 recents（每类 5 / 共 20）→ ↑↓ 浏览 → Enter 确认跳转 → 关闭。
- 替代：再按 ⌘K / Esc / 点遮罩关闭；Tab/Shift+Tab 循环切类。
- 异常：recents 为空（首次使用）→ 空态提示 + 建议操作。

**UC-B：搜索并执行命令**
- 主流程：输入查询 → debounce(120ms) 查命令注册表 → 命令分组+子串高亮 → Enter 执行 → toast 反馈。
- 替代：命中 pi slash 命令 → 注入 active session composer；命中应用命令 → 触发应用动作。
- 异常：**危险命令（如「终止任务」）→ 不直接执行，二次确认（复用 Flow-3 机制）**。

**UC-C：搜索并打开文件**
- 主流程：输入文件名片段 → 命中（spec 原文「项目索引 LSP/ripgrep」）→ 文件分组 → Enter → **Workspace 打开并定位**。
- 替代/异常：索引查询 >200ms → 加载条（<200ms 不显，避免闪烁）。

**UC-D：搜索并定位符号**
- 主流程：输入查询 → 符号分组（spec 原文「项目索引 LSP」）→ Enter → **Workspace 打开并定位到符号**。
- 异常：占位渲染失败（极端）→ 整个分组隐藏。

**UC-E：搜索并切换会话**
- 主流程：输入会话关键词 → 命中（全局·跨项目）→ 会话分组 → Enter → 切换 active session，**可带 `?focus=overview` 进概览**。

**横切用例**：键盘导航（↑↓跨组扁平化 / Enter / Tab / Esc / Home/End 可选）、类型过滤（Tab 切类 / ⌘1…⌘5 待定）、加载态（>200ms）、空结果态。

### 数据流

```
查询输入 ─debounce(120ms)─▶ 索引查询（命令注册表/项目索引 LSP·ripgrep/会话库）
                              │
                              ▼
                   后端返回「命中区间数组」──▶ 前端渲染 <mark class="hl">（accent 色，不加背景）
                              │
                   分组渲染（命令→文件→符号→会话，顺序固定）
                              │
                  确认项 ─▶ recents ─▶ localStorage 持久化
```
- z-index：浮层/遮罩 1000，确认 toast 1100。
- 选中态：Card-Active inset ring（禁用左色条）；↑↓ 用 `scrollIntoViewIfNeeded`（避免 OD 预览 iframe 滚动冲突）。
- 无障碍：role=dialog + aria-modal、focus trap、role=listbox/option。
- 性能：单类 >200 项启用虚拟化；分组头 sticky。

## 与 requirements.md diff

| gap_id | 类型(F/K/D) | 差异(MISSING/MISMATCH) | 描述 |
|---|---|---|---|
| G1 | F | MISMATCH | **文件数据源**：spec/search-data.ts 原设计「项目索引 LSP / ripgrep 后端」；requirements 改为 runtime 全树递归遍历（不引 LSP/ripgrep，D-003）。属刻意改向，但 requirements 未点明「原 spec 写的是 LSP/ripgrep」，存在 SSOT 源描述漂移风险。 |
| G2 | F | MISMATCH | **文件跳转目标**：spec 原文「Workspace 打开并定位」；requirements UC-3 缩为「DetailPane 打开文件预览（复用 file.read + useDetailPane）」（D-006）。spec 与需求在「打开」语义上不一致，未回填 spec。 |
| G3 | F | MISMATCH | **符号类**：spec 原设计「项目索引 LSP → Workspace 打开并定位到符号」是真实数据用例；requirements 降级为纯占位（UC-5，D-001）。requirements 自洽但 spec 的「符号=真实数据」表述未同步修正。 |
| G4 | F | MISSING | **危险命令二次确认**：spec §四类分组 + §边缘状态明确「危险命令（终止任务）不直接执行，二次确认复用 Flow-3」；requirements §8「本期不做（D-008）」。spec 中此契约仍在，SSOT 与需求 Out-of-Scope 未对齐，易实现期误读 spec 补回确认。 |
| G5 | F | MISSING | **会话 `?focus=overview` 进概览**：spec §四类分组写「切换 active session（可带 ?focus=overview 进概览）」；requirements UC-4 完全未提此 URL 参数能力。重建有、需求无。 |
| G6 | K | MISSING | **无障碍契约**：spec §实现要点列 role=dialog/aria-modal、focus trap、焦点还给触发元素、role=listbox/option；requirements 全文无无障碍条目（功能清单 F1-F10 均无）。盲区。 |
| G7 | K | MISSING | **键盘 Home/End（可选跳首/跳尾）**：spec §键盘契约列「Home/End（可选）待定」；requirements UC/F 清单未提。低优但属契约遗漏。 |
| G8 | K | MISSING | **匹配机制**：spec 写「后端返回命中区间数组」驱动高亮；requirements 改为「前端内存过滤」+ Vue `segments()` 子串切分。MISMATCH（后端区间 vs 前段子串），需求未说明此实现转向。 |
| G9 | D | MISMATCH | **匹配语义术语**：spec 多处用「模糊 + 子串高亮」；requirements/Vue 实际为「子串切分」（segments 按精确子串切，非模糊评分）。术语「模糊」与实现「子串」不一致。 |
| G10 | D | MISSING | **虚拟化阈值**：spec「单类 >200 项启用虚拟化」；requirements 未提性能阈值。 |
| G11 | D | MISSING | **分组头 sticky**：spec §实现要点列；requirements 未提。 |
| G12 | D | MISSING | **z-index 契约**：spec「浮层/遮罩 1000、toast 1100，低于 traffic-light」；requirements 未提分层契约。 |
| G13 | D | MISSING | **scrollIntoViewIfNeeded / OD iframe 滚动冲突规避**：spec 明确禁用 scrollIntoView；requirements 未提，实现期可能踩坑。 |
| G14 | F | MISSING（需求侧） | requirements 比 spec 更深一层：runtime 新增 `search.*` handler、`file-service.listTree` 仅 2 层需新增全递归、gitBranch 缺失降级匹配——这些 spec 未覆盖，是需求独有（非盲区，但说明 spec 在实现可达性上是空白的）。 |

## 小结

- **三类同源盲区**：①spec 的 SSOT 表述未随决策回填（LSP/ripgrep→runtime、Workspace→DetailPane、符号真实→占位、危险确认→不做），spec 仍是旧设计，**实现期读 spec 会与需求冲突**（G1-G4）；②会话 overview 参数能力丢失（G5）；③无障碍契约（G6）在需求层完全缺位。
- **需求比 spec 强**：实现可达性（runtime handler、listTree 全递归、gitBranch 降级）只有需求有，spec 是空白（G14）。
