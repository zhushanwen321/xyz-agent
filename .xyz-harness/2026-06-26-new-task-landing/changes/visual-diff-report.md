---
verdict: minor-divergence
date: 2026-06-27
---

# 新建任务 · 设计稿 vs 实现 · 视觉差异对比报告

对比对象（HEAD `9a8f65cf`）：

| # | 设计稿 | 实现 |
|---|---|---|
| 1 | `docs/page-design/v3/new-task/draft-landing.html` | `src-electron/renderer/src/components/new-task/Landing.vue` |
| 2 | `docs/page-design/v3/new-task/draft-directory-select.html` | `src-electron/renderer/src/components/new-task/DirSelectPopover.vue` |
| 3 | `docs/page-design/v3/new-task/draft-branch-select.html` | `src-electron/renderer/src/components/new-task/BranchSelectPopover.vue` |
| 4 | `docs/page-design/v3/new-task/draft-directory-picker.html`（仅 §2 modal） | `src-electron/renderer/src/components/new-task/CreateBranchModal.vue` |

依据：`docs/page-design/v3/new-task/spec.md` + `docs/page-design/design-tokens.md`。
截图存档：`.xyz-harness/2026-06-26-new-task-landing/changes/screenshots/draft-*.png`（设计稿 4 张；实现侧未截图，原因见 §8）。

---

## §0 总结论

**verdict: minor-divergence** — 4 个组件的核心结构、状态流、交互逻辑、主文案均忠实于设计稿（77 个 new-task 测试通过佐证功能完整），但存在**一组系统性视觉差异**与**一处结构性拆分**，尚未达到「像素级一致」：

1. **Card-Active 选中态内描边（`inset 1px var(--accent-ring)`）系统性缺失** —— 设计稿把「`--surface-hover` 底 + inset accent ring + ✓」作为列表/chip 选中态的唯一原语（spec §3.2/§3.3 反复强调），实现普遍只设了 `bg-surface-hover`，**没有 ring**，Dir/Branch 列表当前项、Landing chip open 态均受影响。这是最高频的视觉偏差。
2. **Landing 的 composer 被拆到父级 Panel** —— 设计稿画的是「chip 在 composer-box 顶部 + 输入区 + 工具条 + 发送」一体的居中 composer；`Landing.vue` 只渲染 watermark + greeting + chip 胶囊（输入/工具条/发送/hint 在父级 `Panel.vue` 底部 `composer-band` 的 `Composer.vue`）。功能未丢，但 Landing 态的视觉构成与设计稿不同（chip 与输入框分离）。
3. **Popover 搜索行缺 search 图标 + Esc 徽标**；popover 底色用 `bg-bg-elevated(#1c1c20)` 而非设计稿 `--surface-2(#1b1b20)`；圆角 `rounded-md(6px)` 而非 `--radius(8px)` —— 全部 1px/1-hex 量级，但成片出现。
4. **dirty 提示用 TriangleAlert 图标**，违反 spec §3.3「不画感叹号 icon，用 warning dot」的明确约束。

无阻塞级差异（0 blocker）：所有 spec 要求的状态/边缘态/键盘契约在实现中均有对应（多数还超前补了 unborn/error/格式校验等 AC）。差异集中在视觉 token 层与少量原语缺失，定级 **minor-divergence**。

---

## §1 Landing（draft-landing.html ↔ Landing.vue）

| 维度 | 设计稿 | 实现 | 差异 | 严重度 |
|---|---|---|---|---|
| 布局·composer | 单一居中 `.composer-box`：顶部 meta-row(chip) + `.composer-area`(输入) + `.composer-bar`(+ / 上下文 / 模型 / 思考 / 发送) + `.composer-hint` | `Landing.vue` 仅渲染 chip 胶囊行；输入/工具条/发送/hint 在父级 `Panel.vue` 底部 `composer-band` 的 `Composer.vue` | **结构性拆分**：设计稿「chip 在输入框正上方一体」→ 实现「chip 居中、composer 在底部独立带」，视觉构成不同（疑似遵循 panel 架构，非 bug） | 一般（待截图确认 composed 视图） |
| 文案·问候语 | 静态「上午好呀，有什么想让我帮忙的吗」 | 动态 `上午好呀/下午好呀/晚上好呀` + 同后缀 | 合理增强（覆盖全天时段） | 吹毛求疵 |
| 文案·directory 空态 | 未画（spec §6 列为遗留待裁决） | 无 cwd → chip 显「选择目录」(AC-1.7) | 合理补充 | 吹毛求疵 |
| 尺寸·composer max-width | `max-width:720px` | Landing 内无 composer（父级 Composer 另定） | 同「composer 拆分」 | 一般 |
| 尺寸·greeting | 22px / weight 650 / `letter-spacing:-0.01em` | `text-[22px] font-[650]`，无 letter-spacing | 缺 -0.01em 字距 | 吹毛求疵 |
| 间距·greeting→下 | margin-bottom 28px | 父容器 `gap-8`(32px) | 4px 差 | 吹毛求疵 |
| 间距·container padding | `32px 24px 64px` | `p-6`(24px 全) | 上/下 padding 收窄 | 吹毛求疵 |
| 颜色·chip 文字 | `--text-secondary`(#8a8a95 muted) | `text-subtle`(#5a5a65)，无 cwd 时 `!text-accent` | chip 默认比设计稿暗一档 | 一般 |
| 颜色·directory 图标 | folder 图标 `color:var(--accent)`(蓝) | Folder 无 accent，随 text-subtle | 设计稿蓝、实现灰 | 一般 |
| 图标·watermark | 「xyz」字样 + `-webkit-text-stroke` | SVG 圆角方框 + 对勾路径（`text-fg opacity-[0.04]`） | **形状完全不同**：设计稿是品牌字「xyz」，实现是「对勾方框」（像 task-done icon）。注：spec §3.1 措辞为「SVG 描边」，实现按字面用了 SVG，但语义形状与设计稿不符 | 一般（0.04 opacity 近不可见，实际影响待截图） |
| 图标·chip chevron | chip 末尾 11px 下箭头 `.ch-chev`（示「可下拉」） | chip 无 chevron，仅 icon+label | **缺 chevron**，chip 失去「可点开下拉」视觉暗示 | 一般 |
| 交互·chip open 态 | `.open`=`--surface-2` 底 + `inset 0 0 0 1px accent-ring` | 依赖 shadcn `PopoverTrigger`，chip 未显式加 Card-Active inset ring | **缺 inset ring**（系统性问题，见 §0） | 一般 |
| 交互·meta 分隔线 | 1px×18px，margin 0 6px | `h-3.5 w-px`(14px)，无水平 margin（父 gap-2）；仅 `v-if=gitBranch` | 高度 14 vs 18px | 吹毛求疵 |
| 状态·非 git 隐藏 branch | 设计稿恒显 branch chip | `v-if="gitBranch"` 隐藏(AC-2.2/UC-7) | 合理且更正确 | 吹毛求疵 |
| 状态·historyError 重试 | 设计稿未画 | `<Button variant=secondary>重试加载历史`+RefreshCw(AC-2.6) | **实现多出**（合理 AC 补充） | 吹毛求疵 |
| 动效·popover 方向 | 向上展开 | `PopoverContent side="top"` | 一致 | — |

---

## §2 DirSelectPopover（draft-directory-select.html ↔ DirSelectPopover.vue）

| 维度 | 设计稿 | 实现 | 差异 | 严重度 |
|---|---|---|---|---|
| 尺寸·宽度 | 380px | `w-[380px]` | 一致 | — |
| 尺寸·底色 | `--surface-2`(#1b1b20) | `bg-bg-elevated`(#1c1c20) | **token 错位** 1hex（系统性，应 `bg-surface-2`） | 吹毛求疵 |
| 尺寸·圆角 | `--radius`(8px) | `rounded-md`(6px) | 2px 差（系统性） | 吹毛求疵 |
| 布局·搜索行 | search 图标 + input + Esc 徽标 | shadcn `<Input>` 单元素 | **缺 search 图标 + Esc 徽标**（系统性） | 一般 |
| 文案·分组标签 | 「最近工作区 · 5」 | 无分组标签 | **缺 group label** | 一般 |
| 文案·空态 | §3.1「暂无最近工作区 · 选择一个本地目录开始」+ folder 大图标 + 「打开文件夹」按钮 | 「暂无最近工作区 · 选择一个本地目录开始」+ Folder 图标，无独立「打开文件夹」按钮（靠下方动作项） | 空态三要素缺独立 Primary 按钮 | 吹毛求疵 |
| 文案·无结果态 | §3.2「未找到「zzzz」的相关工作区」+ 建议 chips(auth/goal/打开文件夹) | 无独立无结果态，复用通用 isEmpty 空态 | **缺「无结果+建议」变体** | 一般 |
| 布局·subline | 仅选中项显路径 subline | 所有项均显 cwd subline(mono 11px subtle) | 信息更密（设计稿仅选中项） | 吹毛求疵 |
| 颜色·选中态(Card-Active) | `--surface-hover` 底 + `inset 1px accent-ring` + ✓ | active 仅 `bg-surface-hover`，**无 inset ring**；`data-active` 属性设了但无 ring 样式 | **缺 inset ring**（系统性，见 §0） | 一般 |
| 颜色·选中项图标 | folder 图标转 `--accent` | 恒 `text-subtle` | 选中项图标未转蓝 | 一般 |
| 图标·search/Esc | 有 | 无 | 同「搜索行」 | 一般 |
| 图标·folder/folder-plus/cloud/check | 内联 symbol | lucide Folder/FolderPlus/Cloud/Check | 等价一致 | — |
| 交互·键盘 ↑↓Enter Esc | spec §3.2 扁平化跨组 | `onKeydown` 扁平化(列表+2动作) | 一致 | — |
| 交互·hover | `--surface-hover` 底 | `hover:bg-surface-hover` | 一致 | — |
| 交互·远程连接 stub | §6 toast「v1 暂未支持」 | `toastError('v1 暂未支持远程连接')` | 一致 | — |
| 动效·popover 方向 | 向上 | 父级 `side="top"` | 一致 | — |

---

## §3 BranchSelectPopover（draft-branch-select.html ↔ BranchSelectPopover.vue）

| 维度 | 设计稿 | 实现 | 差异 | 严重度 |
|---|---|---|---|---|
| 尺寸·宽度 | 420px（比 directory 略宽） | `w-[420px]` | 一致 | — |
| 尺寸·底色/圆角 | `--surface-2` / `--radius`(8px) | `bg-bg-elevated` / `rounded-md`(6px) | 同 §2 系统性 token 偏差 | 吹毛求疵 |
| 布局·搜索行 | search 图标 + input + Esc | shadcn Input 单元素 | **缺 search/Esc**（系统性） | 一般 |
| 文案·分组标签 | 「分支 · 4」 | 「分支」+ `{{ allBranches.length }}` | 一致 | — |
| 文案·dirty subline | warning **dot**(6px圆) + warning 文字「未提交的更改：N 个文件」；spec §3.3 明确「**不画感叹号 icon**」 | TriangleAlert **图标** + warning 文字 | **违反 spec**：用 icon 代替 dot（spec 明令禁止 icon） | 一般 |
| 文案·非当前分支 subline | 「领先 main 12 提交」「默认分支」等 | 仅当前 dirty 分支有 subline，其余无 | **缺 ahead/default subline**（数据未取，仅 branches[]+dirtyCount） | 一般 |
| 文案·确认条 | 「<b>refactor-goal-extension</b> 有 2 个未提交更改，切走将保留在工作区（不自动 stash）」 | 「「<branch>」当前工作区有 N 个未提交更改，切走将保留在工作区。」 | 措辞调整（impl「当前工作区有」比稿「<branch>有」更准）；稿「不自动 stash」说明缺失 | 吹毛求疵 |
| 布局·确认条位置 | spec §3.3/实现要点「从列表**上方**插入，**不替换列表**」 | 确认条渲染在 popover **底部**（`border-t`，列表/动作之下） | **位置相反**：稿顶部(列表仍可见) vs 实现底部 | 一般 |
| 颜色·确认条按钮 | 「切走」= 实色 warning(#f5a524) 按钮 | 「切走」= default(accent 蓝) Button | **按钮配色不同**：稿 warning 黄 vs 实现 accent 蓝 | 一般 |
| 颜色·选中态(Card-Active) | surface-hover 底 + inset accent-ring + ✓ check | active 仅 `bg-surface-hover`，**无 inset ring**；**当前分支无 ✓ check**（DirSelectPopover 有 Check，本组件无） | **缺 ring + 缺当前分支 ✓**（系统性 ring 缺失 + check 遗漏） | 一般 |
| 图标·create-branch | branch-**plus**(branch+加号组合) | 普通 Plus | 图标语义弱化（稿用组合图标区分「建分支」） | 吹毛求疵 |
| 图标·git-graph | 内联 graph symbol | lucide GitGraph | 等价 | — |
| 图标·dirty | warning dot | TriangleAlert | 同 dirty subline（spec 违反） | 一般 |
| 交互·键盘 ↑↓Enter Esc | spec §3.3 | `onKeydown` 扁平化 | 一致 | — |
| 交互·dirty 二次确认 | 选 dirty → inline 确认条 → 确认才切 | `pendingDirtyBranch` → confirmDirtySwitch | 逻辑一致 | — |
| 交互·Git 图谱 stub | §6 toast | `toastError('v1 暂未支持 Git 图谱')` | 一致 | — |
| 状态·unborn HEAD | 未画 | 「无分支 · 引导首次 commit」(AC-6.3) | **实现多出**（合理 AC） | 吹毛求疵 |
| 状态·status 失败 | 未画 | 「加载分支失败，请重试」+TriangleAlert(AC-6.4) | **实现多出**（合理 AC） | 吹毛求疵 |
| 状态·分支极多 | 未画 | `MAX_RENDER_BRANCHES=50` 渲染上限(AC-6.9) | **实现多出**（合理 AC） | 吹毛求疵 |
| 动效·popover 方向 | 向上 | 父级 `side="top"` | 一致 | — |

---

## §4 CreateBranchModal（draft-directory-picker.html §2 ↔ CreateBranchModal.vue）

> 设计稿 §1（系统原生目录选择器）无前端组件对应（走 OS `dialog.showOpenDialog`，`DirSelectPopover` 的 `open-dir-dialog` → `useNewTaskFlow.openDirDialog` 已接），仅对比 §2 modal。

| 维度 | 设计稿 | 实现 | 差异 | 严重度 |
|---|---|---|---|---|
| 尺寸·宽度 | 560px | `sm:max-w-[560px]` | 一致 | — |
| 文案·标题 | 「创建并检出新分支」 | DialogTitle 同 | 一致 | — |
| 文案·描述 | 「基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。」 | DialogDescription 同 | 一致 | — |
| 文案·label/placeholder/hint | 「分支名」/「例如 feature/git-branch-switcher」/「首版只支持基于当前 HEAD 创建并切换。」 | 全部一致 | 一致 | — |
| 文案·按钮 | 「取消」/「创建并切换」 | 同 | 一致 | — |
| 文案·错误 | 「该分支已存在，请换一个名字或切换到该分支」(已存在态) | 前端格式错误「分支名只能含字母、数字…不能含空格 / ..」+ 运行时 errorMsg(`branchErrMsg`) | 触发条件不同：稿画「已存在」，实现主显「格式错误」；运行时错误经 errorMsg 覆盖。实现更全但「已存在」静态文案未见 | 吹毛求疵 |
| 文案·提交中 | §2.2「创建中」+ spinner，「取消」也 disabled | **无 spinner / 无「创建中」文案**，仅 `:disabled="!canSubmit"`(绑 isBranchCreating) | **缺提交中 spinner 反馈** | 一般 |
| 布局·结构 | 标题+X / desc / label / input / hint / 取消+提交 | Dialog(自带 X) / Header(title+desc) / form(label+input+错误+hint+错误+按钮组) | 结构等价（shadcn Dialog 承载 backdrop/居中/X） | — |
| 间距·body/foot | body 14/20/18，foot 0/20/18 | shadcn 默认间距 + `pt-1` | 几 px 差 | 吹毛求疵 |
| 尺寸·标题字号 | 16px weight 650 | DialogTitle(shadcn 默认 ~18px/semibold) | 字号略大 | 吹毛求疵 |
| 尺寸·modal 圆角 | `--radius-lg`(12px) | DialogContent `rounded-lg`(shadcn ~8-12px) | 待确认 | 吹毛求疵 |
| 颜色·input focus | `rgba(79,142,247,0.5)` + inset ring | shadcn Input focus ring(accent) | 一致（token 等价） | — |
| 颜色·错误 input/文字 | `--danger` 边框 / `--danger` 字 | `!border-danger` / `text-danger` | 一致 | — |
| 颜色·主按钮 | accent 实色 | default Button(accent，经 shadcn 映射) | 一致 | — |
| 图标·close X | 自定义 X | shadcn Dialog 内置 X | 等价 | — |
| 图标·错误 icon | 小圆-感叹号 | 无（纯文字） | 缺错误 icon | 吹毛求疵 |
| 交互·Enter 提交 | input 非空时 | form `@submit.prevent` + canSubmit | 一致 | — |
| 交互·Esc/遮罩关闭 | 关闭落回步骤3 | `onOpenChange(false)`→`closeOverlay`；shadcn 遮罩点击 | 一致 | — |
| 交互·空/非法 disabled | 主按钮 disabled | `canSubmit`(isValid && !creating) | 一致 | — |
| 交互·实时格式校验 | 未画（仅「已存在」） | 前端正则 `VALID_BRANCH_NAME` 实时校验(AC-7.8) | **实现多出**（合理 AC，双重校验） | 吹毛求疵 |
| 交互·失败留 modal 可重试 | 未明示 | D-7 `errorMsg` 留 modal(AC-7.3) + 超时文案(AC-7.7) | **实现多出**（合理 AC） | 吹毛求疵 |
| 动效·modal 进出 | backdrop blur + 居中 | shadcn Dialog 进出动画 + overlay blur | 一致 | — |

---

## §5 设计稿示例文案 vs 实现文案 对照

| 位置 | 设计稿文案 | 实现文案 | 性质 |
|---|---|---|---|
| Landing 问候语 | 上午好呀，有什么想让我帮忙的吗 | {上午/下午/晚上}好呀，有什么想让我帮忙的吗 | 合理增强（时段动态） |
| Landing directory 空态 | （未画） | 选择目录 | 合理补充（AC-1.7） |
| Landing placeholder | 描述你想让 AI 做什么，或 @ 引用、# 文件、/ 命令… | （在父级 Composer.vue，本对比未覆盖） | 待核父级 |
| Dir popover 分组标签 | 最近工作区 · 5 | （无） | 遗漏 |
| Dir popover 空态 | 暂无最近工作区 · 选择一个本地目录开始 | 暂无最近工作区 · 选择一个本地目录开始 | 一致（缺独立 Primary 按钮） |
| Dir popover 无结果 | 未找到「zzzz」的相关工作区 + 建议 chips | （复用通用空态） | 遗漏（变体缺失） |
| Branch popover dirty | 未提交的更改：N 个文件（warning **dot**） | 未提交的更改：N 个文件（TriangleAlert **icon**） | spec 违反（icon vs dot） |
| Branch popover subline | 领先 main 12 提交 / 默认分支 | （仅当前 dirty 有 subline） | 遗漏 |
| Branch 确认条 | <branch>有 N 个未提交更改，切走将保留在工作区（不自动 stash） | 「<branch>」当前工作区有 N 个未提交更改，切走将保留在工作区。 | 合理微调（丢「不自动 stash」说明） |
| Modal 错误 | 该分支已存在，请换一个名字或切换到该分支 | 分支名只能含字母、数字…不能含空格 / ..（格式）+ 运行时 msg | 触发条件不同（实现更全） |
| Modal 提交中 | 创建中 + spinner | （无 spinner，仅 disabled） | 遗漏 |

---

## §6 遗漏的设计稿元素（实现未画）

| 元素 | 所属 | 严重度 |
|---|---|---|
| **Card-Active inset accent ring**（选中态内描边） | Dir/Branch 列表当前项 + Landing chip open 态 | 一般（系统性，最高频） |
| **Branch 当前分支 ✓ check 标记** | BranchSelectPopover | 一般 |
| **Popover 搜索行 search 图标 + Esc 徽标** | Dir/Branch popover | 一般（系统性） |
| **Dir popover「最近工作区」分组标签** | DirSelectPopover | 一般 |
| **Dir popover 无结果态 + 建议 chips** | DirSelectPopover(§3.2) | 一般 |
| **Branch 非当前分支 subline**（ahead 计数 / 默认分支） | BranchSelectPopover | 一般（数据未取） |
| **dirty warning dot**（实现误用 TriangleAlert icon，违反 spec §3.3） | BranchSelectPopover | 一般（spec 违反） |
| **Landing chip chevron**（下拉暗示） | Landing | 一般 |
| **Landing watermark「xyz」字样**（实现为对勾方框 SVG） | Landing | 一般（近不可见） |
| **Modal 提交中 spinner +「创建中」** | CreateBranchModal | 一般 |
| **composer 输入区/工具条/发送/hint 在 Landing 内** | Landing（已拆到父级 Composer.vue，非真缺失） | 一般（结构性） |

---

## §7 实现但设计稿没有的元素（实现多出）

| 元素 | 所属 | 性质 |
|---|---|---|
| Landing「重试加载历史」按钮（RefreshCw） | Landing | 合理（AC-2.6 historyError 出口） |
| Branch「无分支 · 引导首次 commit」unborn 空态 | BranchSelectPopover | 合理（AC-6.3） |
| Branch「加载分支失败，请重试」error 态 | BranchSelectPopover | 合理（AC-6.4） |
| Branch 100+ 分支渲染上限 50 + 搜索过滤 | BranchSelectPopover | 合理（AC-6.9） |
| Modal 前端实时格式校验 + 错误文案 | CreateBranchModal | 合理（AC-7.8，双重校验） |
| Modal 失败留 modal 可重试 + 超时文案 | CreateBranchModal | 合理（AC-7.3/7.7） |
| Landing「选择目录」空态文案（无 cwd） | Landing | 合理（AC-1.7） |

> 多出元素几乎全部是 spec/issues 列出的 AC 要求，设计稿未画但实现超前补齐，性质为「合理增强」，非冗余。

---

## §8 需像素级截图确认的项 + 截图可行性结论

### 8.1 已完成截图（设计稿 4 张）

系统 Chrome headless（`/Applications/Google Chrome.app`）可用，4 个 self-contained 设计稿全部截图成功（`--virtual-time-budget` 等待内联 CSS/SVG 渲染）：

```
screenshots/draft-landing.png            (429 KB, 1320×2200)
screenshots/draft-directory-select.png   (288 KB, 1320×2200)
screenshots/draft-branch-select.png      (354 KB, 1320×2200)
screenshots/draft-directory-picker.png   (336 KB, 1320×2200)
```

> 注：本 subagent 模型不支持图片输入，**未能亲自肉眼校验截图内容**，仅以文件大小（288–429KB，非空白）佐证渲染成功。截图已存档供人工 review。

### 8.2 实现侧截图可行性：❌ 不可行（需人工 `npm run dev`）

- renderer 经 `src-electron/renderer/vite.config.ts` 在 `port 1420` 由 `dev:vite` 提供，但 `dev` 脚本为 `dev:vite` + `dev:electron` 并行（`src-electron/package.json`），renderer 依赖 Electron preload 暴露的 IPC bridge（`gitApi`/`dialog` 等），独立 vite 预览会因 preload 缺失在 IPC 调用时崩。
- 进入 Landing 态需「无活跃 session」的应用状态（`Panel.vue`: `messageCount===0 && !isGenerating`），依赖 session store / runtime，无法用静态路由直达。
- 无 puppeteer/playwright 依赖（`renderer/node_modules/.bin` 无），无法脚本化驱动 Electron。
- **结论**：实现侧像素截图需人工 `npm run dev` 启动 Electron → 新建任务进入 Landing → 对 4 个组件各自状态截图。建议人工补充 `impl-landing.png` / `impl-dir-popover.png` / `impl-branch-popover.png` / `impl-create-branch-modal.png` 后与本报告设计稿截图并排比对。

### 8.3 静态对比无法判定、待截图确认的项

| 待确认项 | 原因 |
|---|---|
| Card-Active inset ring 实际是否可见 / shadcn PopoverTrigger 是否注入了 ring | 静态读码未见 ring class，但 shadcn 内部 data-state 可能补样式，需截图 |
| Landing composed 视图（Panel 渲染 Landing+Composer）的 chip 与输入框实际相对位置 | 需运行态截图确认「chip 居中 vs composer 底部」的视觉分离程度 |
| watermark 在 0.04 opacity 下的实际可见度（xyz 字 vs 对勾方框） | 极低 opacity，静态无法判 |
| popover 底色 `#1c1c20` vs `#1b1b20`、圆角 6 vs 8px 的肉眼可辨度 | 1hex/2px 差，需并排截图 |
| dirty TriangleAlert icon vs warning dot 的视觉重量差 | 需截图 |
| Modal shadcn Dialog 标题字号/圆角与设计稿 16px/12px 的实际差 | 需截图 |
| chip 文字 `text-subtle` vs 设计稿 `muted` 的明度差 | 需截图 |

---

## 附：修复优先级建议（仅供决策，本报告不改动代码）

1. **P1 系统性**：补 Card-Active inset ring（Dir/Branch 选中项 + Landing chip open）—— 设计稿核心选中原语，4 处全缺。
2. **P1 spec 违反**：Branch dirty 提示 TriangleAlert → warning dot（spec §3.3 明令）。
3. **P2**：Popover 搜索行补 search 图标 + Esc 徽标；Dir 补「最近工作区」分组标签；Branch 补当前分支 ✓ check。
4. **P2**：Modal 补提交中 spinner +「创建中」。
5. **P3 token 归一**：popover 底色 `bg-bg-elevated` → `bg-surface-2`；圆角 `rounded-md` → `rounded-lg`/`--radius`。
6. **P3**：Branch 确认条位置（底部→顶部）+「切走」按钮配色（accent→warning）对齐设计稿；补非当前分支 ahead/default subline（需扩 git status 数据）。
7. **P3**：Landing chip 补 chevron + directory 图标 accent 色；watermark 形状对齐「xyz」字样（或与设计确认改 logo SVG）。
