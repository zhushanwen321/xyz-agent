# 架构规范

## 模块职责边界

- `services/` — 纯 Rust 业务逻辑，禁止 import tauri crate
- `commands/` — Tauri Command 薄适配层，只做参数解析 + 调用 service
- `models/` — 纯数据结构，无业务逻辑
- `db/` — 持久化，与存储格式耦合，不依赖上层

## 数据流方向

```
commands/ → services/ → models/, db/
```

禁止反向依赖：services 不能依赖 commands，models 不能依赖 services。

## 错误处理

- 统一使用 `AppError` enum（thiserror）
- Tauri Command 返回 `Result<T, String>`，在 command 层做 `.map_err(|e| e.to_string())`
- services 层返回 `Result<T, AppError>`
