---
pr_created: true
pr_url: https://github.com/zhushanwen321/xyz-agent/pull/65
pr_title: "feat: global navigation history stack for Settings↔Chat switching"
branch: feat-front-back-settings-impr
---

# PR Evidence

PR created and CI passed.

## PR Details
- **URL**: https://github.com/zhushanwen321/xyz-agent/pull/65
- **Branch**: feat-front-back-settings-impr → main
- **Commits**: 11 feature commits (from 60819c1 to 3495db0)

## Scope
- NavigationStore (push/back/forward, 50-entry capacity)
- UI integration (AppSidebar ◀▶, SettingsView ESC, App.vue IPC Cmd+,)
- settingsStore.currentView removal (fully migrated to NavigationStore)
- 10 unit tests + 14 test cases verified
