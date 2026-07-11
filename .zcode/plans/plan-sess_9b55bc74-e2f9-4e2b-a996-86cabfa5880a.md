# 变更集（ChangeSetCard）三项改进计划

## 问题诊断结论

用户反馈：变更集"全程几乎看不到"+ 需要"默认收起 + 点击文件 drawer 查看 diff"。

**根因（高置信度）**：runtime 的 baseline diff 机制存在盲区。`diffSnapshots`（`file-change-reconciler.ts:123-143`）的判定规则是「current 有 baseline 无 → 新增」「status 变化 → 更新」「**status 相同 → 不报告**」。当 pi session 的 cwd（如本 worktree `fix-composer-move`）工作区**本来就有未提交的 dirty 文件**时：
- `turn-start` 采集 baseline，这些文件已记为 modified
- turn 内 pi 用 write/edit 改了这些文件，git status 仍是 modified
- baseline status === current status → **不报告** → fileChanges 为空 → 卡片守卫 `changeSetFileChanges.length > 0` 不成立 → 卡片不显示

这就是"全程几乎看不到"的根因——开发场景下 worktree 普遍有 dirty 文件，baseline diff 把"已 dirty 的文件被再次修改"判为"无变化"漏掉了。

## 三项改进

### 改进 1：修复 baseline diff 漏报（根因修复）

**文件**：`packages/runtime/src/infra/pi/file-change-reconciler.ts`

`diffSnapshots` 当前只比较 git **status 码**（XY），无法检测"status 不变但内容变了"的情况。修复方案：**不再依赖 status 码对比，改用 git 的真实 diff 结果作为真值源**。

长期方案（推荐）：`diffSnapshots` 的 baseline 对比，对"baseline 有 + current 有 + status 相同"的文件，**额外用 `git diff --name-only HEAD` 判定是否有实际内容变化**——如果文件在 HEAD 之后被改过（numstat 有记录），就报告它。但这会增加 git 命令调用。

**实际采用的修复**：简化 baseline 机制——`diffSnapshots` 对「baseline 有 + current 有」的文件，**只要 current 中存在就报告**（不再要求 status 变化）。即把第 136-139 行的 `else if (baselineStatus !== currentStatus)` 分支改为 `else`（status 相同也报告）。代价：会报告一些"turn 开始前就 dirty 且 turn 内没碰"的文件（误报），但这比漏报好——用户在变更集卡里能看到这些文件，点击可查看 diff 确认。误报的文件在 ready 帧也只是一致地报告，不会产生状态跳变。

**权衡说明**：这是短期方案——接受"turn 开始前的已有 dirty 文件全部进变更集"的误报，换取"不漏报"。长期更优方案是 baseline 记录文件内容的 hash/sha 而非仅 status 码，但那需要额外 git 命令且复杂度高，不在本次范围。

### 改进 2：变更集卡默认收起

**文件**：`packages/renderer/src/components/panel/message-stream/ChangeSetCard.vue`

当前第 60 行 `const collapsed = ref(props.status === 'resolved' || props.status === 'superseded')`，accumulating/ready/partially-reviewed 态默认展开。

改为**默认收起**：`const collapsed = ref(true)`。所有状态初始都折叠，用户点击 header 展开。

同时把 `collapsed` 从非响应式初值改为 `watch(status)`——当 status prop 变化时（如 accumulating→ready），如果用户没有手动展开过，保持收起。用 `userToggled` flag 跟踪用户是否手动操作过，避免 status 变化时意外展开/折叠用户已经设的态。

### 改进 3：点击文件行打开 drawer 查看 diff

**涉及文件**：
- `packages/renderer/src/components/panel/message-stream/ChangeSetCard.vue`（文件行加 click）
- `packages/renderer/src/components/panel/message-stream/Turn.vue`（透传 sessionId prop）
- `packages/renderer/src/composables/features/useSideDrawer.ts`（open 增加指定 detail 文件路径的能力）
- `packages/renderer/src/composables/features/useDetailPane.ts`（增加按指定路径强制 diff 模式的入口）

**实现路径**（扩展 useSideDrawer，非复用 fileTreeStore.selectFile）：

当前 `useDetailPane.openPreview` 依赖 `fileTreeStore.getGitStatus(sid, path)` 判定是否有 git 改动来决定 viewMode。变更集卡里的文件一定有 git 改动（来源就是 git diff），但 fileTreeStore 的 gitOverlay 可能还没加载/刷新，会导致误判为"无改动"走 preview。所以不复用 selectFile 路径，改为：

1. **useSideDrawer** 新增 `detailFilePath` 模块级 ref + `open` 的 `OpenDrawerOptions` 增加可选 `filePath?: string`。open 时若传了 filePath 则设置 detailFilePath。
2. **useDetailPane** 的 watch 增加对 `detailFilePath` 的监听：当 detailFilePath 变化时，`openPreview` 直接用 `forceDiff: true` 参数强制 viewMode='diff'（绕过 gitOverlay 判定，因为变更集文件一定有改动）。用完后清空 detailFilePath 避免残留。
3. **ChangeSetCard** 新增 `sessionId` prop（从 Turn.vue 透传），文件行加 `@click="onClickFile(c)"` → 调 `drawer.open('detail', { filePath: c.filePath })`。文件行加 hover 态（cursor-pointer + 背景色）和 testid。

**为什么不用 selectFile 路径**：selectFile 设置 fileTreeStore.selectedPath，useDetailPane watch 它但用 gitOverlay 判定 viewMode。变更集文件可能在 overlay 里 status 缺失（untracked 或 overlay 未刷新），会被判为 preview 模式。直接增加 forceDiff 路径更可靠。

## 改动清单

| 文件 | 改动 |
|------|------|
| `packages/runtime/src/infra/pi/file-change-reconciler.ts` | `diffSnapshots`：baseline 有 + current 有时也报告（移除 status 必须不同的条件） |
| `packages/renderer/src/components/panel/message-stream/ChangeSetCard.vue` | 默认收起；文件行加 click → drawer diff；补 sessionId prop + testid |
| `packages/renderer/src/components/panel/message-stream/Turn.vue` | 给 ChangeSetCard 透传 `:session-id` prop |
| `packages/renderer/src/composables/features/useSideDrawer.ts` | `detailFilePath` ref + `OpenDrawerOptions.filePath` |
| `packages/renderer/src/composables/features/useDetailPane.ts` | watch detailFilePath，forceDiff 路径绕过 gitOverlay 判定 |

## 验证方式

1. 在有 dirty 文件的 worktree 中跑 dev，让 pi 改文件，确认变更集卡持续可见（不再"全程看不到"）
2. 变更集卡默认收起，点击 header 展开，再点击收起
3. 展开后点击文件行 → SideDrawer 打开 detail tab，显示该文件 diff
4. 运行 `npx vitest run` 确认相关测试通过（fg5-message-stream.test.ts 变更集用例）
