# NBQ SDKs

Official open-source SDKs for the [Zelinqa NBQ API](https://docs.zelinqa.ai).

NBQ selects the next best question for a conversation from a customer-configured question
bank. This repository contains typed API clients only. The hosted NBQ Engine, its scoring
algorithm, prompts, and infrastructure remain private.

## SDKs

| Language | Package | Status |
|---|---|---|
| Python | [`nbq`](./python) | Beta |
| TypeScript | [`@zelinqa/nbq`](#typescript-quick-start) | Beta |

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

## TypeScript quick start

The TypeScript SDK supports Node.js 20 or newer and ships both ESM and CommonJS builds.

```bash
pnpm add @zelinqa/nbq
```

```typescript
import { NBQClient } from "@zelinqa/nbq";

const client = new NBQClient({
  apiKey: process.env.NBQ_API_KEY!,
});

const result = await client.nextQuestion({
  sessionId: "conversation-123",
  conversationHistory: [
    { role: "user", content: "We receive about 200 leads per month." },
  ],
});

if (result.nextQuestion) {
  console.log(result.nextQuestion.text);
}
```

The client validates the public API limits before sending, creates idempotency keys, retries
temporary failures, respects `Retry-After`, and exposes typed API errors. You can configure
`baseUrl`, `timeoutMs`, `maxRetries`, and a custom Fetch implementation in the constructor.

Report the final business outcome using the same conversation identifier:

```typescript
await client.reportConversion({
  sessionId: "conversation-123",
  outcome: "lead",
  metadata: { source: "website" },
});
```

## Security

Never expose an NBQ runtime API key in browser or mobile code. Both SDKs are intended for
trusted backend environments. Report vulnerabilities according to [SECURITY.md](./SECURITY.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
