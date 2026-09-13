# OpenAPI contract snapshot

`nbq-v1.openapi.yaml` is a verbatim copy of `openapi/nbq-v1.openapi.yaml` from
`Zelinqa/nbq-engine` at commit `98b7ae4` (`origin/main`, 2026-09-11). It is the
source of truth for both SDKs: TypeScript types are generated from it and the
Python models are validated against every example it contains.

Update it only by copying the file from `nbq-engine` `origin/main`; never edit
it by hand.

Verification log (byte-for-byte `diff` against `nbq-engine` `origin/main`):

| Date | `nbq-engine` commit | Result |
|---|---|---|
| 2026-09-11 | `98b7ae4` | snapshot taken |
| 2026-09-13 | `752161b` | identical; engine PRs #47 to #54 did not touch the contract |
