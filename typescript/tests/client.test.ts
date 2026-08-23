import { describe, expect, it, vi } from "vitest";

import {
  NBQAuthenticationError,
  NBQClient,
  NBQConnectionError,
  NBQServerError,
  VERSION,
} from "../src/index.js";

const NEXT_RESPONSE = {
  next_question: {
    external_id: "q_budget",
    text: "What budget have you planned?",
  },
  exhausted: false,
  nbq_version: "0.9.0-beta.1",
  request_id: "req_test",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("NBQClient", () => {
  it("sends auth, idempotency and the API contract", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(init === undefined ? { input } : { input, init });
      return jsonResponse(NEXT_RESPONSE);
    });
    const client = new NBQClient({
      apiKey: "nbq_live_test",
      baseUrl: "https://api.example.test",
      maxRetries: 0,
      fetch,
    });

    const result = await client.nextQuestion({
      sessionId: "session-1",
      conversationHistory: [{ role: "user", content: "We receive 200 leads each month." }],
      answeredQuestionIds: ["q_company"],
      idempotencyKey: "idem-next",
    });

    const requestInput = requests[0]?.input;
    const requestUrl = requestInput instanceof Request ? requestInput.url : requestInput;
    expect(new URL(requestUrl ?? "").pathname).toBe("/v1/next-questions");
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer nbq_live_test",
      "Idempotency-Key": "idem-next",
      "User-Agent": `nbq-typescript/${VERSION}`,
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      session_id: "session-1",
      conversation_history: [{ role: "user", content: "We receive 200 leads each month." }],
      context: null,
      answered_question_ids: ["q_company"],
    });
    expect(result.nextQuestion?.externalId).toBe("q_budget");
    expect(result.requestId).toBe("req_test");
  });

  it("parses an exhausted response", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ ...NEXT_RESPONSE, next_question: null, exhausted: true }),
    );
    const client = new NBQClient({ apiKey: "key", maxRetries: 0, fetch });

    const result = await client.nextQuestion({
      sessionId: "session-1",
      context: "Conversation summary",
    });

    expect(result.exhausted).toBe(true);
    expect(result.nextQuestion).toBeNull();
  });

  it("reports conversion and escapes the session id", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(init === undefined ? { input } : { input, init });
      return jsonResponse(
        { conversion_id: "cv_123", request_id: "req_conversion" },
        { status: 202 },
      );
    });
    const client = new NBQClient({ apiKey: "key", maxRetries: 0, fetch });

    const result = await client.reportConversion({
      sessionId: "session/with/slash",
      outcome: "lead",
      metadata: { source: "website" },
    });

    expect(String(requests[0]?.input)).toContain("session%2Fwith%2Fslash");
    expect(requests[0]?.init?.headers).toMatchObject({
      "Idempotency-Key": expect.any(String),
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      outcome: "lead",
      metadata: { source: "website" },
    });
    expect(result.conversionId).toBe("cv_123");
  });

  it("rejects invalid client settings", () => {
    expect(() => new NBQClient({ apiKey: "" })).toThrow(/apiKey/);
    expect(
      () => new NBQClient({ apiKey: "key", baseUrl: "https://user:password@example.test" }),
    ).toThrow(/credentials/);
    expect(() => new NBQClient({ apiKey: "key", timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => new NBQClient({ apiKey: "key", maxRetries: -1 })).toThrow(/maxRetries/);
  });

  it("rejects invalid conversation history", async () => {
    const fetch = vi.fn(async () => jsonResponse(NEXT_RESPONSE));
    const client = new NBQClient({ apiKey: "key", fetch });

    await expect(
      client.nextQuestion({
        sessionId: "session",
        conversationHistory: [{ role: "user", content: " " }],
      }),
    ).rejects.toThrow(/content/);
    await expect(
      client.nextQuestion({
        sessionId: "session",
        conversationHistory: [{ role: "assistant", content: "How can I help?" }],
      }),
    ).rejects.toThrow(/last conversation message/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps authentication errors and preserves the request id", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          type: "https://docs.zelinqa.ai/errors/invalid_token",
          title: "Invalid token",
          request_id: "req_auth",
        },
        { status: 401 },
      ),
    );
    const client = new NBQClient({ apiKey: "bad-key", maxRetries: 0, fetch });

    const error = await client
      .nextQuestion({ sessionId: "session-1", context: "summary" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NBQAuthenticationError);
    expect(error).toMatchObject({ statusCode: 401, requestId: "req_auth" });
  });

  it("retries transient API failures with the same idempotency key", async () => {
    const keys: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      keys.push(headers["Idempotency-Key"] ?? "");
      if (keys.length === 1) {
        return jsonResponse(
          { title: "Temporarily unavailable" },
          { status: 503, headers: { "Retry-After": "0" } },
        );
      }
      return jsonResponse(NEXT_RESPONSE);
    });
    const client = new NBQClient({ apiKey: "key", maxRetries: 1, fetch });

    await client.nextQuestion({
      sessionId: "session-1",
      context: "summary",
      idempotencyKey: "same-key",
    });

    expect(keys).toEqual(["same-key", "same-key"]);
  });

  it("throws a typed server error after the retry budget", async () => {
    const fetch = vi.fn(async () => jsonResponse({ title: "Internal error" }, { status: 500 }));
    const client = new NBQClient({ apiKey: "key", maxRetries: 0, fetch });

    await expect(
      client.nextQuestion({ sessionId: "session-1", context: "summary" }),
    ).rejects.toBeInstanceOf(NBQServerError);
  });

  it("throws a typed connection error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const client = new NBQClient({ apiKey: "key", maxRetries: 0, fetch });

    await expect(
      client.nextQuestion({ sessionId: "session-1", context: "summary" }),
    ).rejects.toBeInstanceOf(NBQConnectionError);
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const client = new NBQClient({ apiKey: "key", timeoutMs: 1, maxRetries: 0, fetch });

    await expect(
      client.nextQuestion({ sessionId: "session-1", context: "summary" }),
    ).rejects.toBeInstanceOf(NBQConnectionError);
  });

  it("rejects malformed successful API responses", async () => {
    const fetch = vi.fn(async () => new Response("not json"));
    const client = new NBQClient({ apiKey: "key", maxRetries: 0, fetch });

    await expect(
      client.nextQuestion({ sessionId: "session-1", context: "summary" }),
    ).rejects.toMatchObject({ statusCode: 200 });
  });

  it("validates request limits before sending", async () => {
    const fetch = vi.fn(async () => jsonResponse(NEXT_RESPONSE));
    const client = new NBQClient({ apiKey: "key", fetch });

    await expect(
      client.nextQuestion({ sessionId: "s".repeat(129), context: "summary" }),
    ).rejects.toThrow(/sessionId/);
    await expect(
      client.nextQuestion({ sessionId: "session", context: "x".repeat(8_001) }),
    ).rejects.toThrow(/context/);
    await expect(
      client.nextQuestion({
        sessionId: "session",
        context: "summary",
        answeredQuestionIds: Array.from({ length: 201 }, (_, index) => `q_${index}`),
      }),
    ).rejects.toThrow(/answeredQuestionIds/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized and non-JSON conversion metadata", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ conversion_id: "cv_123", request_id: "req_conversion" }, { status: 202 }),
    );
    const client = new NBQClient({ apiKey: "key", fetch });

    await expect(
      client.reportConversion({
        sessionId: "session",
        outcome: "lead",
        metadata: { value: "x".repeat(4_097) },
      }),
    ).rejects.toThrow(/4096/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      client.reportConversion({
        sessionId: "session",
        outcome: "lead",
        metadata: circular,
      }),
    ).rejects.toThrow(/JSON serializable/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
