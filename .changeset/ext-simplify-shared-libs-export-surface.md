---
'@zhushanwen/pi-extension-logger': minor
'@zhushanwen/pi-cache-probe': minor
---

Converge export surfaces to what consumers actually use.

- **pi-extension-logger**: the package now re-exports a single curated surface instead of the previous wider barrel; internal-only helpers are no longer part of the public API.
- **pi-cache-probe**: `fingerprint` exports are trimmed to the functions consumed downstream, aligning the public surface with actual usage.
