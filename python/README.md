# NBQ Python SDK

Typed Python client for the hosted NBQ API.

> The current implementation is the legacy 0.9 client. Do not use it for a new
> V1 integration or publish it as V1 until the session contract and live staging
> tests are complete.

## V1 target surface

- create a session;
- send the previous answer and request the next question;
- read public session state and events;
- send final feedback;
- expose typed V1 errors, `request_id`, idempotency and retry behavior.

## Development

From the repository root:

```bash
uv sync
uv run pytest
uv run ruff check .
uv run mypy python/src
```

The client is intended for trusted backend environments. API keys must come from
environment/secret management and must never appear in logs or exceptions.
