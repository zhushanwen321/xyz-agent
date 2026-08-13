---
"@zhushanwen/pi-scheduler": minor
---

Migrate task store to session-scoped append-only CustomEntry storage

- Replace file-based task store with append-only CustomEntry records written to the session JSONL, so scheduled tasks survive session resumption and are scoped per session
- Add legacy store importer that migrates existing `tasks.json` data on first run
- Fix toggle-enable not persisting recalculated `nextRunAt` (tasks lost scheduling after resume)
- Fix residual pending tasks when toggle-enable recalculates `nextRunAt` to the future
- Trim once-task echo to a single run and inject the `now` source for consistent scheduling
