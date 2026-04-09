---
name: block-wrong-superpowers-path
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: docs/superpowers/
  - field: new_text
    operator: regex_match
    pattern: .+
---

**禁止在 docs/superpowers/ 目录下创建或编辑文件。**

正确的 superpowers 目录是 `.claude/.superpowers/`，不是 `docs/superpowers/`。

请将文件路径修改为 `.claude/.superpowers/` 下的对应位置。
