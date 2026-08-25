---
'@zhushanwen/pi-unified-hooks': patch
---

**Deprecated: superseded by `@zhushanwen/pi-base-tool-enhance`**

- This package is no longer maintained and is marked `deprecated` on npm
- Test-command guarding, tool-error audit and hang protection (now via configurable timeouts) are all covered by `pi-base-tool-enhance`
- Migration: uninstall this package (`pi uninstall npm:@zhushanwen/pi-unified-hooks`), then install `pi-base-tool-enhance`. Keeping both installed causes double interception of `bash` calls — always remove this one first
