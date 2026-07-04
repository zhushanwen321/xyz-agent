---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 问题分析

## 问题清单

### I1: ModelSelectPopover 列表空竞态 [P0]
- **现象**：新建任务页模型选择器经常空列表
- **根因**：onMounted 本地订阅错过 sendInitialState 一次性推送（Composer v-if 重新挂载）
- **修复**：models 提升到 settingsStore（常驻订阅，AppShell 根注册）
- **可逆性**：D-可逆（UI 层重构，不涉及数据模型）

### I2: landing 态选模型不生效 [P0]
- **现象**：新建任务页选模型后显示不变，无报错
- **根因**：onModelSelect 在 sessionId=null 时直接 return 丢弃选择；无 pendingModel 机制
- **修复**：useNewTaskFlow 加 pendingModel state + currentModel computed + setPendingModel；submitFirstMessage create session 后 apply
- **可逆性**：D-可逆

### I3: 切模型后思考等级不重置 [P0]
- **现象**：A(high-max, level=max) 切到 B(on-off) 后思考停在 max
- **根因**：useThinkingLevelSync 的 watch 有 sessionId guard（landing 态跳过）+ currentThinkingLevel 在 landing 态恒 undefined + onThinkingSelect landing 分支 return
- **修复**：去 sessionId guard；watch immediate；landing 态用 localThinkingLevel；onThinkingSelect landing 分支更新 localThinkingLevel
- **可逆性**：D-可逆

### I4: thinkingLevelMap value-based 判定错误 [P0, D-不可逆]
- **现象**：resolveAvailableLevels 按 value 判定可用档位，但 pi 按 key 判定
- **根因**：前端误解 pi 语义——value 是 provider 值（发给 API 的），key 才是 pi 档位名（用户选的）。按 value 判定导致 high-max 的 map={high:'high',xhigh:'max'} 只有 high+max 可用（碰巧对），on-off 的 map={xhigh:'xhigh'} 只有 xhigh 可用（错误）
- **修复**：改为 key-based 判定（key 存在且 value≠null = 可用）
- **可逆性**：**D-不可逆**——这是根本架构理解错误，修正后所有预设/逻辑都基于 key 空间

### I5: 前端枚举 max 不在 pi key 空间 [P1, D-不可逆]
- **现象**：前端 ThinkingLevel='off/low/medium/high/xhigh/max'，pi='off/minimal/low/medium/high/xhigh'。前端有 max 没 minimal
- **影响**：all-levels 模式选 max 发 'max' 给 pi，pi 拒绝（不是合法 ThinkingLevel）；high-max 模式的 max key 在 pi map 不存在
- **修复**：保留前端枚举（不改 minimal），但确保 key 发送对齐 pi 语义
- **可逆性**：**D-不可逆**——枚举空间定义

### I6: on/off 模式显示「关」「高」而非「关」「开」 [P1]
- **现象**：用户期望 on/off 显示「关/开」，但 high 档通用 label 是「高」
- **修复**：getDisplayLabel 函数，on-off map（只有 off+high）时 high→「开」
- **可逆性**：D-可逆

### I7: input 字段保存不生效 [P0]
- **现象**：provider modal 设了文本/图片，保存后丢失
- **根因**：onSave 的 models map 丢弃 input 字段；SetProviderData 类型 + runtime setProvider 全链路缺 input 提取
- **修复**：前端 map 加 input；shared SetProviderData 类型加 input；runtime setProvider 提取 input
- **可逆性**：D-可逆（但全链路 4 层修改）
