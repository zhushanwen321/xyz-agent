---
"@zhushanwen/pi-agent-ext": patch
"@zhushanwen/pi-msg-id-mapper": patch
"@zhushanwen/pi-system-prompt": patch
---

Builtin extension npm migration completion

- agent-ext: session tree navigation (`/xyz-navigate`) + `/__xyz_reload__` internal reload command, migrated from builtin file to npm package
- msg-id-mapper: message id mapping extension, migrated from builtin file to npm package
- system-prompt: system prompt injection extension, migrated from builtin file to npm package
- runtime drops the getBuiltinExtensionPaths chain; extensions load as regular npm packages
