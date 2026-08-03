#!/usr/bin/env bash
# Sync types from runtime plugin-types into the SDK package.
#
# Source of truth (runtime, single source):
#   packages/runtime/src/services/plugin-service/plugin-types.ts            (main, re-export shim + inline)
#   packages/runtime/src/services/plugin-service/plugin-types/descriptor-types.ts
#   packages/runtime/src/services/plugin-service/plugin-types/rpc-protocol.ts
#   packages/runtime/src/services/plugin-service/plugin-types/hook-types.ts
#   packages/extension-protocol/src/core/types.ts                           (GuiComponent 渲染协议类型)
#
# Target (SDK, generated):
#   packages/plugin-sdk/src/types.ts
#
# The SDK file must be:
#   - standalone: ZERO imports (third-party plugin authors must not need the monorepo)
#   - free of runtime-internal service interfaces (ISessionService / IConfigService /
#     IModelService / IPluginInstaller → `unknown`)
#   - free of internal-only types that are not part of the plugin-author contract
#     (IPluginServiceDeps = PluginService constructor params, BridgeSyncPayload =
#     plugin-service internal shaping object)
#
# The runtime main file is a re-export shim over the three subdomain files plus a set
# of cross-domain types it keeps inline. We therefore read all four files in order,
# flatten the re-exports into the inline definitions, and drop every import line.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$SCRIPT_DIR/.."              # packages/plugin-sdk
RUNTIME_PLUGINS="$PKG_DIR/../runtime/src/services/plugin-service"
TARGET="$PKG_DIR/src/types.ts"

MAIN="$RUNTIME_PLUGINS/plugin-types.ts"
DESCRIPTOR="$RUNTIME_PLUGINS/plugin-types/descriptor-types.ts"
RPC="$RUNTIME_PLUGINS/plugin-types/rpc-protocol.ts"
HOOK="$RUNTIME_PLUGINS/plugin-types/hook-types.ts"
EXTENSION_PROTOCOL="$PKG_DIR/../extension-protocol/src/core/types.ts"

for f in "$MAIN" "$DESCRIPTOR" "$RPC" "$HOOK" "$EXTENSION_PROTOCOL"; do
  if [ ! -f "$f" ]; then
    echo "Error: Source file not found at $f" >&2
    exit 1
  fi
done

export DESCRIPTOR RPC HOOK MAIN EXTENSION_PROTOCOL TARGET

python3 - <<'PY'
import os, re

DESCRIPTOR = os.environ['DESCRIPTOR']
RPC        = os.environ['RPC']
HOOK       = os.environ['HOOK']
MAIN       = os.environ['MAIN']
EXTENSION_PROTOCOL = os.environ['EXTENSION_PROTOCOL']
TARGET     = os.environ['TARGET']

# ---- read order: extension-protocol types first (GuiComponent defs), then subdomains, then main ----
sources = [EXTENSION_PROTOCOL, DESCRIPTOR, RPC, HOOK, MAIN]

def read(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()

def strip_imports_and_reexports(text):
    """Remove all import statements and `export ... from '...'` re-export
    statements, including multi-line forms. Definitions remain in-place."""
    # Multi-line import:  import [type] { ... } from '...'
    text = re.sub(
        r'''import(?:\s+type)?\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?\s*\n''',
        '', text, flags=re.DOTALL)
    # Single-line import:  import [type] Foo from '...'
    text = re.sub(
        r'''import(?:\s+type)?\s+\w+\s+from\s*['"][^'"]+['"]\s*;?\s*\n''',
        '', text)
    # Multi-line value re-export:  export { ... } from './...'
    text = re.sub(
        r'''export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?\s*\n''',
        '', text, flags=re.DOTALL)
    # Multi-line type re-export:  export type { ... } from './...'
    text = re.sub(
        r'''export\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?\s*\n''',
        '', text, flags=re.DOTALL)
    return text

def replace_internal_refs(text):
    # runtime-internal service ports → unknown (SDK must not depend on runtime internals)
    text = re.sub(r'\bISessionService\b',   'unknown', text)
    text = re.sub(r'\bIConfigService\b',    'unknown', text)
    text = re.sub(r'\bIModelService\b',     'unknown', text)
    text = re.sub(r'\bIPluginInstaller\b',  'unknown', text)
    # inline dynamic-import type refs, e.g. import('../../interfaces.js').IModelService
    text = re.sub(r'''import\([^)]*\)\.\w+''', 'unknown', text)
    return text

def drop_interface(text, name):
    """Drop an `export interface NAME { ... }` block together with its leading
    doc comment / section-header comment lines and one trailing newline."""
    idx = text.find(f'export interface {name} ')
    if idx == -1:
        return text
    start = text.index('{', idx)
    depth = 0
    end = start
    for i in range(start, len(text)):
        c = text[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    # Expand backwards over contiguous comment / blank lines that document this type.
    probe = idx
    while probe > 0:
        nl = text.rfind('\n', 0, probe - 1)
        prev_line = text[nl + 1:probe - 1].strip() if nl != -1 else text[:probe - 1].strip()
        if prev_line.startswith('//') or prev_line.startswith('*') or \
           prev_line.startswith('/*') or prev_line == '':
            probe = nl + 1 if nl != -1 else 0
        else:
            break
    block_end = end
    if block_end < len(text) and text[block_end] == '\n':
        block_end += 1
    return text[:probe] + text[block_end:]

# ---- build output ----
header = '''/**
 * !! 此文件由 packages/plugin-sdk/scripts/sync-types.sh 自动生成 !!
 * !! 请勿手动编辑 —— 修改 runtime 的 plugin-types 后重跑 sync-types.sh  !!
 *
 * 来源（single source of truth）:
 *   packages/runtime/src/services/plugin-service/plugin-types.ts
 *   packages/runtime/src/services/plugin-service/plugin-types/{descriptor-types,rpc-protocol,hook-types}.ts
 *   packages/extension-protocol/src/core/types.ts（GuiComponent 渲染协议类型）
 *
 * 生成规则：
 *   - 拍平 runtime 主文件的 re-export shim + 3 个子域文件 + extension-protocol 协议类型 → 单个自包含文件
 *   - 剥离所有 import（SDK 保持零依赖，第三方插件作者无需装整个 monorepo）
 *   - runtime 内部 service 接口（ISessionService / IConfigService /
 *     IModelService / IPluginInstaller）替换为 `unknown`
 *   - 剥离不应进 SDK 的内部类型：IPluginServiceDeps（PluginService 构造参数）、
 *     BridgeSyncPayload（plugin-service 内部塑形对象）
 *
 * D28: 本文件刻意与 runtime 的 plugin-types 镜像而非 re-export，这是有意的跨包
 * 契约重复——sync 脚本是它的「真相源」，避免 SDK 引入对 @xyz-agent/runtime 的依赖。
 */

'''

body = header
for src in sources:
    chunk = read(src)
    chunk = strip_imports_and_reexports(chunk)
    chunk = replace_internal_refs(chunk)
    # ensure each file's content is separated by a blank line
    body += '\n' + chunk.rstrip() + '\n'

# Drop internal-only types that are not part of the plugin-author contract.
for name in ('IPluginServiceDeps', 'BridgeSyncPayload'):
    body = drop_interface(body, name)

# Collapse 3+ consecutive newlines (side effect of removals / file seams).
body = re.sub(r'\n{3,}', '\n\n', body)
body = body.rstrip() + '\n'

with open(TARGET, 'w', encoding='utf-8') as fh:
    fh.write(body)
PY

# ---- guardrails: fail loudly if a future runtime change resurrects forbidden content ----
# Checks operate on CODE lines only (comment lines are excluded), so documenting a
# forbidden name in the header doc does not trip the guard.
export TARGET
python3 - <<'PY'
import os, re, sys
path = os.environ['TARGET']
with open(path, encoding='utf-8') as fh:
    lines = fh.readlines()

def is_comment(line):
    s = line.strip()
    return s.startswith('//') or s.startswith('*') or s.startswith('/*')

violations = []
for i, line in enumerate(lines, 1):
    if is_comment(line):
        continue
    stripped = line.lstrip()
    # 1. any top-level import statement
    if re.match(r'^import\b', stripped) or re.match(r'^export\s+type\s*\{', stripped) \
       or re.match(r'^export\s*\{[^}]*\}\s*from\b', stripped):
        violations.append(f'{i}: import/re-export survived: {line.rstrip()}')
    # 2. declaration of an internal-only type
    if re.match(r'^export\s+(interface|type)\s+(IPluginServiceDeps|BridgeSyncPayload)\b', stripped):
        violations.append(f'{i}: internal-only type survived: {line.rstrip()}')
    # 3. residual runtime service interface reference
    if re.search(r'\bI(Model|Session|Config)Service\b|\bIPluginInstaller\b', line):
        violations.append(f'{i}: runtime service interface survived: {line.rstrip()}')

if violations:
    print('Error: generated file failed guardrail checks:', file=sys.stderr)
    for v in violations:
        print('  ' + v, file=sys.stderr)
    sys.exit(1)
PY

echo "Synced types from runtime plugin-types to packages/plugin-sdk/src/types.ts"
