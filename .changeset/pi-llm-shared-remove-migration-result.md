---
"@zhushanwen/pi-llm-shared": minor
---

Remove dead `MigrationResult` type re-export from the public entry.

`MigrationResult` is still defined in `src/migrate.ts` (return type of `migrateLegacyConfig`, kept until the permission v2.0.0 migration sunset), but it is no longer re-exported from the package entry: `rg "MigrationResult" extensions/` shows zero external consumers — the only production caller (`@zhushanwen/pi-permission`) ignores the return value, and no workspace package imports the type. For standalone TS consumers importing the type this is a compile-time breaking change, shipped as a minor bump per the repo's 0.x convention (minor = breaking; precedent: llm-shared 0.5.0 dead API surface removal).
