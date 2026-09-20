# Changelog

## 1.0.0 — Unreleased

- Python `zelinqa`, TypeScript `@zelinqa/sdk`, `ZelinqaClient` and
  `ZelinqaConfigurationClient`; Python also provides async clients.
- V1 runtime sessions, next question, context/events, progress and feedback.
- `Session.answer` with text or choice labels; IDs stay in the integration layer.
- Current question metadata: editorial `source` and semi-open `selection_mode`.
- Configuration read/edit/publish, compilation polling, CSV export and audit.
- Typed errors, optimistic concurrency, retry/idempotency support.

Migration: replace `nbq` imports / `@zelinqa/nbq`, `NBQClient` class names and
`NBQ_*` SDK environment variables with the documented Zelinqa equivalents.
Existing API keys, REST paths and wire fields do not change. No automatic
redirect from old packages and no publication is implied by this entry.
