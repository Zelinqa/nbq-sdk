# NBQ SDKs

Open-source Python and TypeScript clients for the Zelinqa NBQ API.

## Current status

The code currently reflects the earlier stateless 0.9 contract. It is kept for
reference but must not be presented as the V1 integration path. No external
customer needs a migration guide.

The next release will be generated/aligned from
`nbq-engine/openapi/nbq-v1.openapi.yaml` and use the stateful session flow:

```text
create session -> request next question -> read events/state -> send feedback
```

Do not publish a V1 package until both languages pass the same contract tests
against staging with real, temporary runtime keys.

## Repository

```text
python/       Python client and tests
typescript/   TypeScript client and tests
scripts/      version consistency utilities
```

## Development

### TypeScript

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

### Python

```bash
uv sync
uv run pytest
uv run ruff check .
uv run mypy python/src
```

## Security

The SDKs are server-side clients. Never embed an NBQ API key in browser or
mobile code. Errors and support reports may include `request_id`, never the key
or full conversation content.

## Publishing

Package versions are immutable. Publishing to PyPI/npm is a manual release step
after staging acceptance, bilingual documentation and a product changelog entry.
