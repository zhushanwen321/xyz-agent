---
wave: W06
phase: P2
cases: complex×1
deps: [W05]
est: 12min
va_ref: VA-03 #5-8,18-19
---

# W06 · P2 Sidebar 容器（四态 + segmented tab）

> 1 个复杂 case：四态 A/B/C/D 切换 + tab 互斥 + 状态保持。多状态交互。

## $ROOT

`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`

## 本 wave 专属文件

| 文件 | 用途 |
|------|------|
| `$ROOT/docs/designs/v3-demo/sidebar/spec.md` | **§容器四态 + §视图切换** |
| `$ROOT/docs/designs/v3-demo/sidebar/draft-five-states.html` | **主对照稿**（四态 A/B/C/D） |
| `$ROOT/src-electron/renderer/src/components/sidebar/Sidebar.vue` | 待验：容器四态 |
| `$ROOT/src-electron/renderer/src/components/sidebar/SegmentedTab.vue` | 待验：tab 互斥 |

## 前置

- **W05 PASS**（shell aside 槽就绪）。
- **依赖 FG1**：session api + navigation store。
- 启动：`cd $ROOT && VITE_MOCK=true npm run dev`（需 mock 多 session）。

## Case · 容器四态 + Tab 互斥（complex）

> 四态：A 会话列表 / B 文件视图 / C 收起 / D 空。

### 检查项

| # | 检查 | 对照 | 期望 |
|---|------|------|------|
| a | tab 互斥 | draft-five-states + spec §视图切换 | 会话 / 文件同时只显一个子视图，共享容器盒 |
| b | tab 计数 | spec §视图切换 | 每 tab 右侧小字计数（会话 N / 文件 M） |
| c | tab 状态保持 | spec §视图切换 | 切到文件 tab → 收起 → 展开 → 恢复文件 tab（非默认会话 tab）；刷新也恢复 |
| d | 空态（D） | spec §容器四态 + §8.5 | 会话数=0 时显示引导新建入口（非空白） |
| e | 文件视图（B）骨架 | spec §8.5 P2 + G2-003 | tab 切到文件可渲染容器 + 空态（内容 DEFERRED，只验切换可用 + 不崩溃） |

### 检查方法

1. `cd $ROOT && VITE_MOCK=true npm run dev`。
2. 浏览器打开 draft-five-states.html 并排。
3. mock ≥3 session：默认显会话列表（A），tab 计数显 N（b）。
4. 点文件 tab：切到 B（a 互斥），显计数 M + 空态/骨架（e）。
5. 切回会话 tab，再切文件 tab → ⌘B 收起 → ⌘B 展开：确认恢复文件 tab（c）。
6. 删空 mock session（或切到空 fixture）：显空态 D（d）。

### 判定

**PASS**：a-e 全符合。
**FAIL 触发**：
- (a) 两 tab 内容同时可见 = FAIL。
- (c) 收起/刷新后 tab 不恢复 = FAIL（状态未持久）。
- (e) 切文件 tab 崩溃 / 完全无容器 = FAIL（骨架要求）。

## 执行步骤

1. 启动 mock + draft 并排。
2. 切 tab 验互斥 + 计数（a/b）。
3. 状态保持测试（c）：切 tab → 收起 → 展开 → 查恢复。
4. 空态（d）+ 文件骨架（e）。

## FAIL 判定

- 见上方 FAIL 触发。
- PASS 后 W07/W08/W09 可并行（均依赖本 wave）。
