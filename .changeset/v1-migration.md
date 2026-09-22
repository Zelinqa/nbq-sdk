---
"@zelinqa/sdk": major
---

Zelinqa V1 — complete rewrite of the SDK surface (1.0.0).

The SDK now targets the V1 contract (`openapi/nbq-v1.openapi.yaml`) and exposes
two least-privilege clients:

- `ZelinqaClient` (scope `runtime`): `createSession`, `next`, `applyEvents`,
  `getSession`, `submitFeedback`, plus `startSession` / `resumeSession` returning
  a `Session` handle that tracks `state_version` for you. Zelinqa keeps the canonical
  session state server-side; `refresh()` replaces any client-side resume token.
- `ZelinqaConfigurationClient` (scopes `configuration:read` / `configuration:write` /
  `configuration:publish`): `getConfiguration`, `listQuestions`,
  `iterateQuestions`, `exportQuestionsCsv`, `listAudit`, `applyChanges`,
  `publish`, `getCompilation`, `waitForCompilation`.

Also new:

- consistent public domain/dimension vocabulary (`dimensions`, `dimension_id`),
  including configuration changes, progress, question filters and audit;
- `configuration.domain.name` exposes the current domain name independently
  from the published objective name. Existing IDs and API keys stay unchanged;

- typed error hierarchy mapped from the V1 error envelope (`code` first, then
  HTTP status), with `ZelinqaStateVersionConflictError`,
  `ZelinqaIdempotencyKeyReusedError`, `ZelinqaInsufficientScopeError`,
  `ZelinqaConfigurationValidationError` and friends carrying their structured details;
- automatic `Idempotency-Key` generated once per logical call and reused across
  retries, retry/backoff honouring `Retry-After`, per-attempt timeouts and
  caller-supplied `AbortSignal`;
- all wire types generated from the OpenAPI contract (`pnpm generate:types`),
  nothing hand-copied.

**Breaking:** the 0.9 routes are removed from the SDK — `nextQuestion`,
`reportConversion`, `Message`, `Outcome`, `POST /v1/next-questions` and
`POST /v1/sessions/{id}/conversion` are gone, with no compatibility shim. Use
`next` and `submitFeedback` instead.
