# NBQ Python SDK

The official Python client for the [Zelinqa NBQ API](https://docs.zelinqa.ai).

NBQ selects the next best question for a conversation from a customer-configured question
bank. This package is a typed HTTP client; the scoring algorithm remains in the hosted NBQ
Engine.

> The SDK is currently beta. Its public surface follows the deployed `/v1` runtime API.

## Installation

```bash
pip install nbq
```

## Synchronous client

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

Keep the same `session_id` for the entire conversation and use a new one for each new
conversation. Send every question actually asked in `answered_question_ids` on subsequent
calls.

## Asynchronous client

```python
from nbq import AsyncNBQClient, Message

async with AsyncNBQClient(api_key="nbq_live_...") as client:
    result = await client.next_question(
        session_id="conversation-123",
        conversation_history=[
            Message(role="user", content="We receive about 200 leads per month."),
        ],
        answered_question_ids=["q_company_size"],
    )
```

## Report an outcome

```python
conversion = client.report_conversion(
    session_id="conversation-123",
    outcome="lead",
    metadata={"source": "website"},
)
print(conversion.conversion_id)
```

The SDK automatically adds an idempotency key to writes. You can provide your own key when
the same business operation may be retried outside the SDK process.

## Configuration

```python
client = NBQClient(
    api_key="nbq_live_...",
    base_url="https://api.zelinqa.ai",
    timeout=10.0,
    max_retries=2,
)
```

Do not expose the runtime API key in browser or mobile code. Call NBQ from a trusted backend.

## Support

Log the `request_id` returned by NBQ when contacting support. Do not include API keys or
conversation content in bug reports.

## License

Apache License 2.0.
