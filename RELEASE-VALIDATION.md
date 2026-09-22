# NBQ-132 / NBQ-134 — Zelinqa release validation

## Verified locally and against staging, 20 September 2026

- Python: 326 non-live tests; mypy and Ruff passed.
- TypeScript: 102 non-live tests; typecheck, lint, ESM/CJS build and version checks passed.
- Real staging API: 38 Python tests and 15 TypeScript tests passed, using only a
  dedicated synthetic NBQ. Covered configuration changes, publication/compilation,
  read/write/publish scopes, CSV, pagination, session state, choices, context,
  idempotency, optimistic conflicts, revoked keys and feedback.
- Python sync and async managed `answer`/resume were exercised on the real API.
- MCP's separate recipe passed 8 live tests, including the default business loop
  over a real stdio process. Six feedback rows from the combined recipe were
  verified directly in PostgreSQL, not inferred from HTTP responses alone.
- All 6 temporary credentials for the successful recipe were revoked. Its tenant
  and NBQ were disabled; synthetic records were retained for diagnosis. An earlier
  recipe also had its 6 keys revoked and fixture disabled after finding a stale CSV assertion.
- SDK wheel installed with the MCP wheel in a clean Python environment. The MCP
  wheel exposed 7 tools, 2 prompts and its guide resource over stdio.
- npm tarball installed in a clean package; ESM and CommonJS exports loaded.
- Local `answer_turn` microbenchmark: 10,000 calls, approximately 12.7 microseconds
  per call under tracemalloc, 4,040 peak traced bytes in that loop. This measures
  only local identifier/choice mapping, **not** API latency or total process memory.

## Release gates

The functional CI jobs execute pytest and Vitest (not just lint/build). Live suites
are opt-in, not run on PRs; the GitHub `staging-live` environment still needs protected
credentials before its manual workflow can repeat this recipe.

Maintainer review and approval are required; no package has been published. New PyPI/npm
projects need publisher configuration. Existing `nbq` / `@zelinqa/nbq` packages are
not overwritten or silently migrated. See `PUBLISHING.md`.

Session handles are sequential, not cross-worker locks. The backend must persist
the session ID for restart recovery. No sustained-load or total-RSS benchmark was
performed, and these functional tests do not establish tenant capacity.
