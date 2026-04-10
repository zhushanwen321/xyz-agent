#!/bin/bash
# 检查：禁止在 .claude/tracers/ 之外创建 tracers 目录或写入 tracers 路径的文件
# 匹配规则：路径中包含 /tracers/ 但不以 .claude/tracers/ 开头

# 从 stdin 读取 tool_input JSON
INPUT=$(cat)

# 提取文件路径（Write tool 的 file_path 或 Bash command 中的路径引用）
# 检查是否包含 tracers 相关路径
if echo "$INPUT" | grep -qE '(file_path|command).*[^.]claude/tracers/|/tracers/[^.]'; then
    # 更精确地检查：路径包含 tracers 但不是 .claude/tracers
    if echo "$INPUT" | grep -qP '(?<!\.claude)/tracers/' 2>/dev/null; then
        echo "BLOCKED: tracers 目录只能创建在 .claude/tracers/ 下，禁止在其他位置创建 tracers 目录或文件"
        exit 2
    fi
fi

exit 0
