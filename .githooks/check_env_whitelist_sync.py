#!/usr/bin/env python3
"""
ENV_WHITELIST_PREFIXES SSOT 单一性检查

规则：`ENV_WHITELIST_PREFIXES` 的 `const ... = [...]` 定义只允许出现在
packages/shared/src/constants.ts（单一权威源）。main/ 和 runtime/ 层
禁止本地定义该常量，只能 `import` 自 shared。

[历史] 旧版（check_env_whitelist_sync.py）检查"两份独立常量同步"——基于
runtime-manager.ts 和 rpc-client.ts 各自定义 ENV_WHITELIST_PREFIXES 的假设。
commit 863f0704（Round 4 review 修复）将两份常量收敛到 shared SSOT 后，
旧正则匹配 `const ENV_WHITELIST_PREFIXES = [` 失效（两文件改为 import），
检查静默误报"未找到"。本版适配 SSOT 架构，改为验证定义点单一性。

精神（CLAUDE.md #3）仍保留：主进程可扩展（safe-env.ts: [...SSOT, 'ELECTRON_']），
子进程用全集（rpc-client.ts: = SSOT）。SSOT 化让"两处不同步"物理不可能，
剩余风险是 SSOT 退化（未来有人在 main/runtime 本地重新定义），本检查防此。

运行方式:
  python3 .githooks/check_env_whitelist_sync.py

退出码:
  0 — 通过
  2 — 违规（SSOT 退化或定义点丢失）
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

SSOT_FILE = PROJECT_ROOT / 'packages/shared/src/constants.ts'
# 禁止本地定义 ENV_WHITELIST_PREFIXES 的目录（只能 import 自 shared）
FORBIDDEN_DIRS = [
    PROJECT_ROOT / 'apps/electron/main',
    PROJECT_ROOT / 'packages/runtime',
]
CONST_NAME = 'ENV_WHITELIST_PREFIXES'

# 匹配 const ENV_WHITELIST_PREFIXES = ...（本地定义，非 import）
# 不匹配 import { ENV_WHITELIST_PREFIXES }、const ENV_WHITELIST = ENV_WHITELIST_PREFIXES
LOCAL_DEF_RE = re.compile(rf'\bconst\s+{CONST_NAME}\s*[:=]')


def check_ssot_exists() -> list[str]:
    """验证 SSOT 文件定义了该常量"""
    errors = []
    if not SSOT_FILE.exists():
        errors.append(f'[ERROR] SSOT 文件不存在：{SSOT_FILE.relative_to(PROJECT_ROOT)}')
        return errors
    text = SSOT_FILE.read_text(encoding='utf-8')
    # SSOT 应有 export const ENV_WHITELIST_PREFIXES = [
    if not re.search(rf'export\s+const\s+{CONST_NAME}\s*[:=]', text):
        errors.append(
            f'[ERROR] {SSOT_FILE.relative_to(PROJECT_ROOT)} 未定义 '
            f'`export const {CONST_NAME}`（SSOT 定义丢失）'
        )
    return errors


def scan_forbidden_local_defs() -> list[str]:
    """扫描 forbidden 目录下是否有本地定义"""
    errors = []
    for forbidden_dir in FORBIDDEN_DIRS:
        if not forbidden_dir.exists():
            continue
        for ts_file in forbidden_dir.rglob('*.ts'):
            # 跳过 node_modules / dist
            if 'node_modules' in ts_file.parts or 'dist' in ts_file.parts:
                continue
            text = ts_file.read_text(encoding='utf-8', errors='ignore')
            if LOCAL_DEF_RE.search(text):
                errors.append(
                    f'[ERROR] {ts_file.relative_to(PROJECT_ROOT)}: '
                    f'本地定义了 `{CONST_NAME}`，违反 SSOT 单一性'
                )
                errors.append(
                    f'  修复：删除本地定义，改用 '
                    f"`import {{ {CONST_NAME} }} from '@xyz-agent/shared'`"
                )
    return errors


def main() -> int:
    errors = check_ssot_exists() + scan_forbidden_local_defs()

    if errors:
        for e in errors:
            print(e)
        print()
        print()
        print('\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
        return 2

    print(f'[OK] {CONST_NAME} SSOT 单一性检查通过（定义点：shared/src/constants.ts）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
