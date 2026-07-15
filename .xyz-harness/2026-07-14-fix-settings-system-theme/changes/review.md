# Code Review — fix-settings-system-theme

## 审查范围
- commits: 1aee6356 (W1) / ba5e38d3 (W2-W4 合并)
- base: c3e17d7d (Topic 1 review 修正)

## 发现的问题

| # | 维度 | 问题 | 严重度 | 位置 |
|---|------|------|--------|------|
| 1 | 业务逻辑 | W3 useSettings 的 matchMedia 监听：`store.setSystem({ ...store.system })` 触发 DOM 重新同步——但 spread 创建新对象引用，setSystem 内 `system.value = { ...system.value, ...patch }` 会触发 watch，但 watch 监听的是 `store.system.theme`（theme 没变仍是 system），不会重复挂监听。逻辑正确，无死循环风险。但 `void store.setSystem(...)` 的 void 表明这里不 await——setSystem 是 async（写 localStorage），OS 切换时 localStorage 写入是冗余的（theme 没变，只是 OS 偏好变了，localStorage 里存的仍是 system）。这是可接受的小冗余，非 bug。 | nit | useSettings.ts:99 |
| 2 | 测试覆盖 | U6 只测了 useToast 机制本身（info 触发后 toasts 含条目），没测 SettingsModal 的 onSystemUpdate 真的调了 toast（因为 mount SettingsModal 需 Dialog context 太重）。算降级覆盖——toast 机制验证了，但 onSystemUpdate → toast 的接线靠人工 E* 验。 | nit | system-theme.test.ts U6 |
| 3 | 计划符合性 | W2-W4 合并为一个 commit（ba5e38d3），违反"每 Wave 独立 commit"纪律。原因：三 Wave 都在 settings 前端链、改动小、内聚。CW 标 extraCommitReuse warning 但不阻断。接受偏差。 | nit | commit ba5e38d3 |

### 未发现问题的维度（OK）

- **W1 CSS 11 套规则**：dark (`:root[data-theme-preset]`) + light (`[data-theme=light][data-theme-preset]`) 各 11 块，U2 静态断言全覆盖。cold-blue 与 :root 默认 accent 一致（冗余覆盖确保显式）。neutral/sharp 无彩色用中性灰 accent，合理。
- **applySystemToDom 写 data-theme-preset**：L141 `setAttribute('data-theme-preset', s.themePreset ?? 'cold-blue')`，null 兜底 cold-blue。U1 验证 rose/cold-blue 两例。
- **updateSystem 真 await**：L51-54 `async function` + `await getSystem()` + `localStorage.setItem`，消除 fire-and-forget。U3 验证 await 后立即可读。
- **matchMedia 动态挂/卸**：watch(system.theme, immediate) → updateSystemThemeListener。theme=system 挂、非 system 卸。dispose 也清理。U4/U5 验证。模块级 mediaQuery/mediaQueryListener 句柄，切 theme 时先 removeEventListener 再按需重挂，无泄漏。
- **typecheck**：vue-tsc exit 0，无类型错误。
- **回归**：1052 测试全绿（Topic 1 后 1045 + 本 topic 7 个新测试）。

## plan 覆盖核对
- [x] W1 changes[0]: style.css 11 套 dark preset 规则——已落地
- [x] W1 changes[1]: style.css 11 套 light preset 规则（color-mix 派生）——已落地
- [x] W2 changes[0]: applySystemToDom 写 data-theme-preset——已落地
- [x] W2 changes[1]: updateSystem 真 await——已落地
- [x] W3 changes[0]: matchMedia change 监听动态挂/卸——已落地
- [x] W4 changes[0]: SettingsModal toast 反馈——已落地
- [x] W4 changes[1]: SystemPage swatch 选中态——已有，无需改

## 结论
- must_fix 数量：0
- should_fix 数量：0
- nit 数量：3（均为可接受的小偏差）
- 结论：可调 cw(review)
