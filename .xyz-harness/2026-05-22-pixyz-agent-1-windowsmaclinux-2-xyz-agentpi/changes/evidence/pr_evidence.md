---
pr_created: true
pr_url: https://github.com/zhushanwen321/xyz-agent/pull/44
pr_title: "feat: bundle pi Bun binary into xyz-agent"
branch: feat-package-pi
---

# PR Evidence

## PR Metadata

| Item | Value |
|------|-------|
| PR URL | https://github.com/zhushanwen321/xyz-agent/pull/44 |
| Title | feat: bundle pi Bun binary into xyz-agent |
| Branch | feat-package-pi → main |
| State | OPEN |
| Mergeable | MERGEABLE (CLEAN — no conflicts) |
| Review Decision | REVIEW_REQUIRED (no reviewers assigned yet) |
| Labels | (none) |
| Commit | c2ae28d |

## PR Description Summary

The PR body includes:
- **Summary**: Bundle pi Bun standalone binary so users don't need to install pi or Node.js
- **Changes**: 5 runtime changes, 3 build config changes, 2 vendor submodules, 3 ADRs
- **Spec & Plan**: References spec.md and plan.md in .xyz-harness topic directory
- **Test Results**: 46 runtime + 73 frontend tests passed, typecheck passed, lint 0 errors

## Change Statistics

- 38 files changed, 4234 insertions, 1 deletion
- Modified: 6 existing files (release.yml, eslint.config.mjs, electron-builder.yml, runtime-manager.ts, config-store.ts, process-manager.ts, rpc-client.ts)
- New: 1 script (prepare-pi-resources.sh), 1 resource placeholder (.gitkeep), 2 submodules, 3 ADRs, harness deliverables

## Review Status

- Code review: pass (2 rounds, 0 MUST FIX in final round)
- Test review: pass (13/13 TC executed, all passed)
- CI checks: Lint pass, Test pass, TypeCheck pass
