---
ci_passed: true
ci_url: https://github.com/zhushanwen321/xyz-agent/actions/runs/26367440143
commit_sha: 8e7c193
---

# CI Results

All CI checks passed on second push (first push had TypeCheck/Test failures fixed in 8e7c193).

## Checks
- Lint: passed
- TypeCheck: passed
- Test: passed (73 tests)

## Fix History
- First push (e8e55e9): TypeCheck failed (TreeData type + IEventAdapter mock missing methods), Test failed (Pinia not active in test env)
- Second push (8e7c193): Fixed all issues — updated test mocks, safe Pinia registration, spread TreeData into payload
