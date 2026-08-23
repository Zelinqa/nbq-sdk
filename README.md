# NBQ SDKs

Official open-source SDKs for the [Zelinqa NBQ API](https://docs.zelinqa.ai).

NBQ selects the next best question for a conversation from a customer-configured question
bank. This repository contains typed API clients only. The hosted NBQ Engine, its scoring
algorithm, prompts, and infrastructure remain private.

## SDKs

| Language | Package | Status |
|---|---|---|
| Python | [`nbq`](./python) | Beta |
| TypeScript | `@zelinqa/nbq` | Planned |

## Python quick start

```bash
pip install nbq
```

```python
from nbq import Message, NBQClient

with NBQClient(api_key="nbq_live_...") as client:
    result = client.next_question(
        session_id="conversation-123",
        conversation_history=[
            Message(role="user", content="We receive about 200 leads per month."),
        ],
    )

    if result.next_question is not None:
        print(result.next_question.text)
```

See the [Python SDK documentation](./python/README.md) for the full usage guide.

## Security

Never expose an NBQ runtime API key in browser or mobile code. Call NBQ from a trusted
backend and report vulnerabilities according to [SECURITY.md](./SECURITY.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
