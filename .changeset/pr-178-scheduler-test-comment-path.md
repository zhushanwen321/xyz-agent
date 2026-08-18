---
"@zhushanwen/pi-scheduler": patch
---

Fix stale tools/ path reference in sdk-contract test comment

The comment in `sdk-contract.test.ts` still pointed to `tools/verify-scheduler-e2e.cjs` after the script was migrated to `scripts/`. Comment-only change, no runtime behavior affected.
