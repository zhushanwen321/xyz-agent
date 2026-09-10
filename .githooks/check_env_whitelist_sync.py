#!/usr/bin/env python3
"""
ENV_WHITELIST_PREFIXES SSOT 单一性检查 + ENGINE_ENV_* 镜像相等断言

规则 1：`ENV_WHITELIST_PREFIXES` 的 `const ... = [...]` 定义只允许出现在
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

规则 2（W12，impl-plan §2.12）：ENGINE_ENV_PREFIXES / ENGINE_ENV_DENY_LIST 由
shared constants.ts SSOT 构建期生成为 @zhushanwen/subagent-engine-sdk
src/env.ts 的内联镜像（SDK 不得运行时 import @xyz-agent/shared——F9）；本检查
断言镜像与 SSOT 逐项相等（含顺序），漂移即红。注意：SDK 的 env.ts 是镜像的
合法落点，不进 FORBIDDEN_DIRS（FORBIDDEN 只针对 ENV_WHITELIST_PREFIXES 本体）。

运行方式:
  python3 .githooks/check_env_whitelist_sync.py

退出码:
  0 — 通过
  2 — 违规（SSOT 退化或定义点丢失或镜像漂移）
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

# ENGINE_ENV_* 镜像相等断言（W12）
SDK_MIRROR_FILE = PROJECT_ROOT / 'packages/subagent-engine-sdk/src/env.ts'
ENGINE_ENV_CONSTS = ['ENGINE_ENV_PREFIXES', 'ENGINE_ENV_DENY_LIST']

# 匹配 const ENV_WHITELIST_PREFIXES = ...（本地定义，非 import）
# 不匹配 import { ENV_WHITELIST_PREFIXES }、const ENV_WHITELIST = ENV_WHITELIST_PREFIXES
LOCAL_DEF_RE = re.compile(rf'\bconst\s+{CONST_NAME}\s*[:=]')

# 提取 export const NAME: ... = [ 'a', 'b', ... ] 的字符串条目（单/双引号）
ARRAY_ITEMS_RE_TMPL = (
    r'export\s+const\s+{name}\s*:\s*readonly\s+string\[\]\s*=\s*\[(.*?)\]'
)
ARRAY_ITEM_STR_RE = re.compile(r'''['"]([^'"]+)['"]''')


def extract_const_items(text: str, name: str) -> list[str] | None:
    """从 TS 源文本提取 export const NAME: readonly string[] = [...] 的条目列表。

    返回 None = 未找到定义。注释行会被 ARRAY_ITEM_STR_RE 误吞成条目（引号内文本），
    故先剥掉 // 与 /* */ 注释再提取——两处文件该常量块的注释均不含引号包裹的
    变量名形态，剥离后提取即纯条目。
    """
    no_comments = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    no_comments = re.sub(r'//[^\n]*', '', no_comments)
    m = re.search(ARRAY_ITEMS_RE_TMPL.format(name=name), no_comments, re.DOTALL)
    if not m:
        return None
    return ARRAY_ITEM_STR_RE.findall(m.group(1))


def check_engine_env_mirror() -> list[str]:
    """规则 2：SDK env.ts 镜像与 shared SSOT 逐项相等（含顺序）。"""
    errors = []
    ssot_text = SSOT_FILE.read_text(encoding='utf-8')
    if not SDK_MIRROR_FILE.exists():
        return [f'[ERROR] SDK 镜像文件不存在：{SDK_MIRROR_FILE.relative_to(PROJECT_ROOT)}']
    mirror_text = SDK_MIRROR_FILE.read_text(encoding='utf-8')
    for name in ENGINE_ENV_CONSTS:
        ssot_items = extract_const_items(ssot_text, name)
        if ssot_items is None:
            errors.append(
                f'[ERROR] {SSOT_FILE.relative_to(PROJECT_ROOT)} 未定义 `export const {name}`'
                f'（ENGINE_ENV SSOT 丢失）'
            )
            continue
        mirror_items = extract_const_items(mirror_text, name)
        if mirror_items is None:
            errors.append(
                f'[ERROR] {SDK_MIRROR_FILE.relative_to(PROJECT_ROOT)} 未定义镜像 `{name}`'
                f'（构建期生成物丢失，SSOT 改动须两处同批提交）'
            )
            continue
        if ssot_items != mirror_items:
            errors.append(
                f'[ERROR] {name} 镜像与 SSOT 漂移：\n'
                f'  SSOT ({SSOT_FILE.relative_to(PROJECT_ROOT)}): {ssot_items}\n'
                f'  镜像 ({SDK_MIRROR_FILE.relative_to(PROJECT_ROOT)}): {mirror_items}\n'
                f'  修复：两处同批提交（SDK 不得运行时 import @xyz-agent/shared，只能镜像）'
            )
    return errors


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
    errors = check_ssot_exists() + scan_forbidden_local_defs() + check_engine_env_mirror()

    if errors:
        for e in errors:
            print(e)
        print()
        print()
        print('\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
        return 2

    print(f'[OK] {CONST_NAME} SSOT 单一性检查通过（定义点：shared/src/constants.ts）')
    print('[OK] ENGINE_ENV_PREFIXES / ENGINE_ENV_DENY_LIST SDK 镜像与 SSOT 逐项相等')
    return 0


if __name__ == '__main__':
    sys.exit(main())
