#!/usr/bin/env bash
# session-manager-e2e.sh — E2E mock 测试脚本
#
# 用法：bash scripts/cw/session-manager-e2e.sh <test-type>
#   test-type: create | manage | malformed
#
# 测试流程：
# - create（U4-E1）：内嵌 mock handler 自包含验证请求-响应骨架
# - manage / malformed（U4-E2/U4-E3）：委托 vitest 探针驱动仓库真实实现
#   （packages/runtime/src/__tests__/session-manager-e2e-probe.test.ts，
#   真实 event-adapter marker 翻译 + SessionManagerHandler）——内嵌 mock 自包含
#   在无实现基线树上也跑通（无红阶段区分力），故 E2/E3 不再走内嵌 mock
#
# 输出：<U4-EX> PASS 或 <U4-EX> FAIL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_TYPE="${1:-create}"

# 红阶段守卫：验证实现产物存在（区分力检查——基线代码树无此文件会 fail）
HANDLER_IMPL="$PROJECT_ROOT/packages/runtime/src/transport/session-manager-handler.ts"
if [ ! -f "$HANDLER_IMPL" ]; then
  echo "ERROR: session-manager-handler.ts not found — implementation missing (red phase guard)" >&2
  exit 1
fi

# 验证实现文件包含 SessionManagerHandler 类（区分力：基线代码树即使有文件也不会有这个类）
if ! grep -q 'class SessionManagerHandler' "$HANDLER_IMPL"; then
  echo "ERROR: SessionManagerHandler class not found in implementation — red phase guard" >&2
  exit 1
fi

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

log() {
  echo -e "${GREEN}[session-manager-e2e]${NC} $*"
}

error() {
  echo -e "${RED}[session-manager-e2e]${NC} $*" >&2
}

# 创建临时目录
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# 模拟 node 脚本：解析 extension_ui_request 并回写 response（create/E1 专用；
# E2/E3 已改走 vitest 探针驱动真实实现，见上方测试流程注释）
MOCK_HANDLER_SCRIPT="$TEMP_DIR/mock-handler.js"
cat > "$MOCK_HANDLER_SCRIPT" << 'MOCKEOF'
const readline = require('readline');

const SESSION_MANAGER_MARKER = '\x00XYZ_SESSION_MANAGER';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const event = JSON.parse(line);
    
    // 检测 extension_ui_request
    if (event.type === 'extension_ui_request') {
      const title = event.title || '';
      const options = event.options || [];
      
      // 检测 SESSION_MANAGER_MARKER
      if (title === SESSION_MANAGER_MARKER && options.length > 0) {
        try {
          const data = JSON.parse(options[0]);
          const action = data.action;
          const params = data.params || {};
          
          // 根据 action 构造响应
          let response;
          switch (action) {
            case 'create':
              response = {
                sessionId: 'mock-session-' + Date.now(),
                status: 'created',
                modelId: 'openai/gpt-4'
              };
              break;
            case 'send':
              response = { blocked: false };
              break;
            case 'history':
              response = { messages: [], truncated: false };
              break;
            case 'status':
              response = { status: 'active', modelId: 'openai/gpt-4' };
              break;
            case 'list':
              response = { sessions: [] };
              break;
            case 'abort':
              response = { success: true };
              break;
            default:
              response = null;
          }
          
          // 输出响应到 stdout（pi 会读取）
          const responseEvent = {
            type: 'extension_ui_response',
            id: event.id,
            value: response ? JSON.stringify(response) : null,
            method: 'select'
          };
          console.log(JSON.stringify(responseEvent));
          
          // 输出测试标记（格式：验收id原文 PASS/FAIL）
          if (action === 'create') {
            console.log('U4-E1 PASS');
          } else if (['send', 'history', 'status', 'list', 'abort'].includes(action)) {
            console.log('U4-E2 PASS');
          }
        } catch (e) {
          // JSON parse 失败 → malformed
          console.log(JSON.stringify({
            type: 'extension_ui_response',
            id: event.id,
            cancelled: true
          }));
          console.log('U4-E3 PASS');
        }
      }
    }
  } catch (e) {
    // 忽略非 JSON 行
  }
});

// 超时保护
setTimeout(() => {
  console.error('Mock handler timeout');
  process.exit(1);
}, 10000);
MOCKEOF

# 测试函数：运行 mock handler 并验证响应
run_test() {
  local test_name="$1"
  local mock_input="$2"
  local expected_marker="$3"
  
  log "Running test: $test_name"
  
  local output_file="$TEMP_DIR/output_${test_name}.jsonl"
  
  # 将模拟输入传给 mock handler
  echo "$mock_input" | node "$MOCK_HANDLER_SCRIPT" > "$output_file" 2>/dev/null
  
  # 验证输出（格式：验收id原文 PASS/FAIL）
  if grep -q "$expected_marker PASS" "$output_file"; then
    log "Test $test_name passed"
    return 0
  else
    error "Test $test_name failed"
    cat "$output_file"
    return 1
  fi
}

# 根据测试类型运行相应测试
case "$TEST_TYPE" in
  create)
    log "Testing create action via vitest probe..."

    # U4-E1：委托 vitest 探针驱动真实实现（与 E2/E3 同款——探针 import 实现符号，
    # 无实现基线树上 import 即挂，保持红阶段区分力）。
    if (cd "$PROJECT_ROOT/packages/runtime" && npx vitest run src/__tests__/session-manager-e2e-probe.test.ts -t 'U4-E1'); then
      echo "U4-E1 PASS"
    else
      echo "U4-E1 FAIL"
      exit 1
    fi
    ;;
  manage)
    log "Testing manage actions (send/history/status/list/abort) via vitest probe..."

    # U4-E2：委托 vitest 探针驱动真实实现（event-adapter marker 翻译 + SessionManagerHandler）。
    # 探针 import 实现符号，无实现基线树上 import 即挂 → 有红阶段区分力。
    if (cd "$PROJECT_ROOT/packages/runtime" && npx vitest run src/__tests__/session-manager-e2e-probe.test.ts -t 'U4-E2'); then
      echo "U4-E2 PASS"
    else
      echo "U4-E2 FAIL"
      exit 1
    fi
    ;;
  malformed)
    log "Testing malformed action via vitest probe..."

    # U4-E3：同上，委托 vitest 探针（malformed 兜底 → cancelled 回写）
    if (cd "$PROJECT_ROOT/packages/runtime" && npx vitest run src/__tests__/session-manager-e2e-probe.test.ts -t 'U4-E3'); then
      echo "U4-E3 PASS"
    else
      echo "U4-E3 FAIL"
      exit 1
    fi
    ;;
  *)
    error "Unknown test type: $TEST_TYPE"
    error "Usage: $0 <create|manage|malformed>"
    exit 1
    ;;
esac

log "All tests passed"
