# 主题 4：Settings 结构债（收尾 5）

## 现状

3 个问题，强耦合（必须按顺序）：
- **§14.1 目录分层缺失**：renderer 12 .vue + ui 12 .vue 全平铺，零域子目录
- **§14.2 大文件超限**：SystemPage 594 / ExtensionPage 530 / PiPresetsPage 443（PiPresetsPage 反增 4）
- **§14.4 bg-accent 双义**：style.css:128-149 别名映射保留，消费侧已单义化（剔除，详见下文）

**顺序铁律**：§14.1 分层 → §14.2 拆分（否则拆出的 Section 无处归档反向加剧平铺）。

---

## 收尾 5.1：目录分层

### renderer 侧按域建子目录

```
components/settings/
├── provider/         ← ProviderPage + (引用 ui ProviderImportMenu)
├── system/           ← SystemPage + SystemPromptPage + TokenDebugPage
├── preset/           ← PiPresetsPage
├── extension/        ← ExtensionPage
├── worktree/         ← WorktreePage
├── terminal/         ← TerminalPage
├── update/           ← UpdatePage
├── resource/         ← SettingsResourcePage
├── SettingRow.vue    (共用，留顶层)
└── SettingsModal.vue (容器，留顶层，相对 import 路径同步改 :99-108)
```

### ui 侧按域建子目录

```
features/settings/
├── provider/         ← ProviderEditBody + ProviderImportMenu + ProviderImportPreviewDialog
├── coding-plan/      ← CodingPlanSection + PresetModeSection
├── compat/           ← CompatEditor + CompatField
├── common/           ← GroupCard + LoadPaths + SoundPreviewButton + SourceImportSection + ModelListSection
└── __tests__/
```

### 成本

低（纯目录移动 + import 路径改）。零逻辑变更。

---

## 收尾 5.2：大文件拆分（分层后归档）

### SystemPage.vue 594 → 4 Section（目标 < 300）

| 新文件 | 归属 | 内容 | 估算行数 |
|---|---|---|---|
| SystemCodingPlanSection.vue | system/ | coding plan 配置 | ~150（复用 ui CodingPlanSection） |
| SystemProxySection.vue | system/ | 代理配置 | ~120 |
| SystemSoundSection.vue | system/ | 音效配置 | ~100（复用 ui SoundPreviewButton） |
| SystemAppearanceSection.vue | system/ | 外观/主题 | ~120 |
| SystemPage.vue | system/ | 容器 + tab 编排 | ~150 |

### ExtensionPage.vue 530 → 3 组件（目标 < 300）

| 新文件 | 归属 | 内容 | 估算行数 |
|---|---|---|---|
| ExtensionList.vue | extension/ | 扩展列表 + 搜索 | ~180 |
| ExtensionDetail.vue | extension/ | 单扩展详情 + 配置 | ~200 |
| ExtensionActions.vue | extension/ | 启用/禁用/卸载操作 | ~100 |
| ExtensionPage.vue | extension/ | 容器 | ~100 |

### PiPresetsPage.vue 443 → 2 Section（目标 < 300）

| 新文件 | 归属 | 内容 | 估算行数 |
|---|---|---|---|
| PresetListSection.vue | preset/ | preset 列表 + 切换 | ~200（复用 ui PresetModeSection） |
| PresetDetailSection.vue | preset/ | 单 preset 详情 | ~180 |
| PiPresetsPage.vue | preset/ | 容器 | ~100 |

### 依赖

- SystemPage 拆分依赖 ui 包 CodingPlanSection/PresetModeSection 已就位（✅ 已确认存在）
- ExtensionPage/PiPresetsPage 拆分无依赖

---

## §14.4 bg-accent 双义（剔除，不单列）

**为何剔除**：
- 消费侧 75 处已单义化（bg-accent = 主色实色 50+ 处，bg-accent-soft = 软底选中 25 处，零 danger 误用，零「期望软底得主色」陷阱）
- 根源（style.css:128-149 别名映射）保留但不活跃
- 根治（删除别名块 + ui 原语改 v3 命名）依赖 ui 包 shadcn 原语清洗（审计 §14.5 / B8.2），工作量大

**处理**：降优先级，与 ui 原语清洗合并处理（未来工作），不单列 todo。当前消费侧已单义，无现实危害。

---

## 主题 4 验收

- 3 个大文件均 < 300 行
- renderer + ui settings 按域建子目录
- SettingsModal 相对 import 路径正确
- Settings 全功能正常（各页可访问 + 配置可改可保存）
