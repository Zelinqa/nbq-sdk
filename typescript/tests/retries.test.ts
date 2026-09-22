import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZelinqaClient, ZelinqaConnectionError, ZelinqaServerError } from "../src/index.js";
import { at, jsonResponse, recordFetch, TEST_API_KEY, TEST_BASE_URL } from "./helpers.js";

/** Distinctive per-attempt timeout, so backoff sleeps are easy to isolate. */
const ATTEMPT_TIMEOUT_MS = 987_654;

let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

function backoffDelays(): number[] {
  return setTimeoutSpy.mock.calls
    .map((call) => call[1])
    .filter((delay): delay is number => typeof delay === "number" && delay !== ATTEMPT_TIMEOUT_MS);
}

function client(fetch: ReturnType<typeof recordFetch>["fetch"], maxRetries: number): ZelinqaClient {
  return new ZelinqaClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    timeoutMs: ATTEMPT_TIMEOUT_MS,
    maxRetries,
    fetch,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
  // biome-ignore lint/suspicious/noExplicitAny: spying on the faked global timer
  setTimeoutSpy = vi.spyOn(globalThis, "setTimeout" as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("retry policy", () => {
  it("backs off 0.5s, 1s then 2s before giving up", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const recorder = recordFetch([() => jsonResponse({}, { status: 500 })]);

    const promise = client(recorder.fetch, 3)
      .createSession()
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await promise;

    expect(error).toBeInstanceOf(ZelinqaServerError);
    expect(recorder.requests).toHaveLength(4);
    expect(backoffDelays()).toEqual([500, 1_000, 2_000]);
  });

  it("adds jitter on top of the exponential base", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const recorder = recordFetch([() => jsonResponse({}, { status: 502 })]);

    const promise = client(recorder.fetch, 2)
      .createSession()
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(backoffDelays()).toEqual([625, 1_250]);
  });

  it("caps the exponential backoff at 10s", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const recorder = recordFetch([() => jsonResponse({}, { status: 504 })]);

    const promise = client(recorder.fetch, 6)
      .createSession()
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(backoffDelays()).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000]);
  });

  it("honours Retry-After expressed in seconds", async () => {
    const recorder = recordFetch([
      () => jsonResponse({}, { status: 429, headers: { "Retry-After": "7" } }),
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 1).createSession();
    await vi.advanceTimersByTimeAsync(7_000);
    await promise;

    expect(backoffDelays()).toEqual([7_000]);
  });

  it("honours Retry-After expressed as an HTTP-date", async () => {
    const recorder = recordFetch([
      () =>
        jsonResponse(
          {},
          { status: 503, headers: { "Retry-After": "Tue, 01 Sep 2026 09:00:03 GMT" } },
        ),
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 1).createSession();
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(backoffDelays()).toEqual([3_000]);
  });

  it("caps Retry-After at 30s", async () => {
    const recorder = recordFetch([
      () => jsonResponse({}, { status: 429, headers: { "Retry-After": "600" } }),
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 1).createSession();
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(backoffDelays()).toEqual([30_000]);
  });

  it("honours details.retry_after_seconds when no header is present", async () => {
    const recorder = recordFetch([
      () =>
        jsonResponse(
          {
            code: "idempotency_contention",
            message: "retry",
            request_id: "req_1",
            details: { retry_after_seconds: 2 },
          },
          { status: 503 },
        ),
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 1).createSession();
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(backoffDelays()).toEqual([2_000]);
  });

  it("never retries a client error", async () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      const recorder = recordFetch([() => jsonResponse({}, { status })]);

      await client(recorder.fetch, 3)
        .createSession()
        .catch(() => undefined);

      expect(recorder.requests, `status ${status}`).toHaveLength(1);
    }
    expect(backoffDelays()).toEqual([]);
  });

  it("retries a network failure then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const recorder = recordFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 2).createSession();
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(recorder.requests).toHaveLength(2);
    expect(backoffDelays()).toEqual([500]);
  });

  it("retries a per-attempt timeout and ends on ZelinqaConnectionError", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: AbortSignal[] = [];
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal !== null && signal !== undefined) {
            calls.push(signal);
            signal.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }
        }),
    );
    const runtime = new ZelinqaClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      timeoutMs: 1_000,
      maxRetries: 1,
      fetch,
    });

    const promise = runtime.createSession().catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await promise;

    expect(error).toBeInstanceOf(ZelinqaConnectionError);
    expect(calls).toHaveLength(2);
  });

  it("propagates the caller's abort without retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init?.signal?.reason);
          });
        }),
    );
    const runtime = new ZelinqaClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 3,
      fetch,
    });

    const promise = runtime
      .createSession({}, { signal: controller.signal })
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(reason);
    const error = await promise;

    expect(error).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a request whose signal is already aborted", async () => {
    const recorder = recordFetch([() => jsonResponse({})]);
    const reason = new Error("already aborted");

    const error = await client(recorder.fetch, 2)
      .getSession("ses_1", { signal: AbortSignal.abort(reason) })
      .catch((cause: unknown) => cause);

    expect(error).toBe(reason);
    expect(recorder.requests).toHaveLength(0);
  });

  it("retries GET requests the same way", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const recorder = recordFetch([
      () => jsonResponse({}, { status: 503 }),
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 1).getSession("ses_1");
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(recorder.requests).toHaveLength(2);
    expect(at(recorder.requests, 1).method).toBe("GET");
  });

  it("makes a single attempt when maxRetries is zero", async () => {
    const recorder = recordFetch([() => jsonResponse({}, { status: 500 })]);

    await client(recorder.fetch, 0)
      .createSession()
      .catch(() => undefined);

    expect(recorder.requests).toHaveLength(1);
    expect(backoffDelays()).toEqual([]);
  });

  it("reuses the same Idempotency-Key across every retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const recorder = recordFetch([
      () => jsonResponse({}, { status: 500 }),
      () => jsonResponse({}, { status: 503 }),
      () => jsonResponse({ session_id: "ses_1" }),
    ]);

    const promise = client(recorder.fetch, 2).createSession();
    await vi.advanceTimersByTimeAsync(1_500);
    await promise;

    const keys = recorder.requests.map((request) => request.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(at(keys, 0)).toBeDefined();
  });
});
