import { describe, expect, it, vi } from "vitest";

import {
  apiErrorFromResponse,
  GATEWAY_FORBIDDEN_MESSAGE,
  ZelinqaAPIError,
  ZelinqaAuthenticationError,
  ZelinqaClient,
  ZelinqaCompilationInProgressError,
  ZelinqaCompiledArtifactUnavailableError,
  ZelinqaConfigurationValidationError,
  ZelinqaConflictError,
  ZelinqaConnectionError,
  ZelinqaConstraintNoMatchError,
  ZelinqaError,
  ZelinqaIdempotencyContentionError,
  ZelinqaIdempotencyKeyReusedError,
  ZelinqaInsufficientScopeError,
  ZelinqaInvalidChoiceError,
  ZelinqaInvalidPreviousTurnError,
  ZelinqaNotFoundError,
  ZelinqaRateLimitError,
  ZelinqaServerError,
  ZelinqaStateVersionConflictError,
  ZelinqaUnknownCompilationError,
  ZelinqaUnknownConfigurationError,
  ZelinqaUnknownSessionError,
  ZelinqaValidationError,
} from "../src/index.js";
import {
  at,
  contractErrorCodes,
  errorExample,
  jsonResponse,
  recordFetch,
  TEST_API_KEY,
  TEST_BASE_URL,
} from "./helpers.js";

type Constructor = new (...args: never[]) => ZelinqaAPIError;

const BY_CODE: ReadonlyArray<readonly [string, number, Constructor]> = [
  ["unauthorized", 401, ZelinqaAuthenticationError],
  ["insufficient_scope", 403, ZelinqaInsufficientScopeError],
  ["idempotency_contention", 503, ZelinqaIdempotencyContentionError],
  ["state_version_conflict", 409, ZelinqaStateVersionConflictError],
  ["idempotency_key_reused", 409, ZelinqaIdempotencyKeyReusedError],
  ["unknown_session", 404, ZelinqaUnknownSessionError],
  ["invalid_previous_turn", 422, ZelinqaInvalidPreviousTurnError],
  ["constraint_no_match", 422, ZelinqaConstraintNoMatchError],
  ["invalid_choice", 422, ZelinqaInvalidChoiceError],
  ["compiled_artifact_unavailable", 410, ZelinqaCompiledArtifactUnavailableError],
  ["configuration_validation_failed", 422, ZelinqaConfigurationValidationError],
  ["compilation_in_progress", 409, ZelinqaCompilationInProgressError],
  ["unknown_configuration", 404, ZelinqaUnknownConfigurationError],
  ["unknown_compilation", 404, ZelinqaUnknownCompilationError],
];

function envelope(code: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { code, message: `message for ${code}`, request_id: `req_${code}`, details };
}

function client(fetch: ReturnType<typeof recordFetch>["fetch"], maxRetries = 0): ZelinqaClient {
  return new ZelinqaClient({ apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL, maxRetries, fetch });
}

describe("apiErrorFromResponse — envelope codes", () => {
  it("covers every code of the contract catalogue", () => {
    expect(BY_CODE.map(([code]) => code).sort()).toEqual([...contractErrorCodes()].sort());
  });

  for (const [code, status, expected] of BY_CODE) {
    it(`maps ${code} to ${expected.name}`, () => {
      const error = apiErrorFromResponse(status, envelope(code));

      expect(error).toBeInstanceOf(expected);
      expect(error).toBeInstanceOf(ZelinqaAPIError);
      expect(error).toBeInstanceOf(ZelinqaError);
      expect(error.code).toBe(code);
      expect(error.statusCode).toBe(status);
      expect(error.requestId).toBe(`req_${code}`);
      expect(error.message).toBe(`message for ${code}`);
      expect(error.details).toEqual({});
    });
  }

  it("keeps the envelope class even on an unexpected status", () => {
    const error = apiErrorFromResponse(500, envelope("unknown_session"));
    expect(error).toBeInstanceOf(ZelinqaUnknownSessionError);
    expect(error.statusCode).toBe(500);
  });
});

describe("apiErrorFromResponse — gateway refusals", () => {
  it("handles the 401 body sent when the Authorization header is missing", () => {
    const error = apiErrorFromResponse(401, { message: "Unauthorized" });

    expect(error).toBeInstanceOf(ZelinqaAuthenticationError);
    expect(error.code).toBeUndefined();
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe("Unauthorized");
    expect(error.requestId).toBeUndefined();
    expect(error.details).toEqual({});
  });

  it("maps the 403 gateway body to an authentication error", () => {
    const error = apiErrorFromResponse(403, { message: "Forbidden" });

    expect(error).toBeInstanceOf(ZelinqaAuthenticationError);
    expect(error).not.toBeInstanceOf(ZelinqaInsufficientScopeError);
    expect(error.code).toBeUndefined();
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(GATEWAY_FORBIDDEN_MESSAGE);
    expect(error.details).toEqual({});
  });

  it("keeps ZelinqaInsufficientScopeError for the 403 V1 envelope only", () => {
    const dynamic = apiErrorFromResponse(403, errorExample("InsufficientScope"));
    expect(dynamic).toBeInstanceOf(ZelinqaInsufficientScopeError);
    expect(dynamic.code).toBe("insufficient_scope");

    expect(apiErrorFromResponse(403, null)).toBeInstanceOf(ZelinqaAuthenticationError);
    expect(apiErrorFromResponse(403, "<html>Forbidden</html>")).toBeInstanceOf(
      ZelinqaAuthenticationError,
    );
  });

  it("treats any 401 as a credential refusal, whatever the body", () => {
    expect(apiErrorFromResponse(401, envelope("unauthorized"))).toBeInstanceOf(
      ZelinqaAuthenticationError,
    );
    expect(apiErrorFromResponse(401, envelope("insufficient_scope"))).toBeInstanceOf(
      ZelinqaAuthenticationError,
    );
  });

  it("handles a body that is not JSON at all", () => {
    const error = apiErrorFromResponse(
      401,
      undefined,
      new Headers({ "X-Request-Id": "req_gateway" }),
    );

    expect(error).toBeInstanceOf(ZelinqaAuthenticationError);
    expect(error.message).toBe("NBQ API request failed with status 401");
    expect(error.requestId).toBe("req_gateway");
  });

  it("maps bare statuses without a code", () => {
    expect(apiErrorFromResponse(404, null)).toBeInstanceOf(ZelinqaNotFoundError);
    expect(apiErrorFromResponse(409, null)).toBeInstanceOf(ZelinqaConflictError);
    expect(apiErrorFromResponse(410, null)).toBeInstanceOf(ZelinqaCompiledArtifactUnavailableError);
    expect(apiErrorFromResponse(422, null)).toBeInstanceOf(ZelinqaValidationError);
    expect(apiErrorFromResponse(429, null)).toBeInstanceOf(ZelinqaRateLimitError);
    expect(apiErrorFromResponse(500, null)).toBeInstanceOf(ZelinqaServerError);
    expect(apiErrorFromResponse(504, null)).toBeInstanceOf(ZelinqaServerError);
    const teapot = apiErrorFromResponse(418, null);
    expect(teapot).toBeInstanceOf(ZelinqaAPIError);
    expect(teapot).not.toBeInstanceOf(ZelinqaValidationError);
  });
});

describe("apiErrorFromResponse — detail extraction", () => {
  it("reads the scopes of a 403", () => {
    const error = apiErrorFromResponse(403, errorExample("InsufficientScope"));

    expect(error).toBeInstanceOf(ZelinqaInsufficientScopeError);
    const scoped = error as ZelinqaInsufficientScopeError;
    expect(scoped.requiredScopes).toEqual(["configuration:publish"]);
    expect(scoped.grantedScopes).toEqual(["configuration:read", "configuration:write"]);
  });

  it("reads the versions of a 409 state_version_conflict", () => {
    const error = apiErrorFromResponse(
      409,
      errorExample("SessionMutationConflict", "state_version_conflict"),
    ) as ZelinqaStateVersionConflictError;

    expect(error.suppliedStateVersion).toBe(7);
    expect(error.currentStateVersion).toBe(8);
  });

  it("reads the job of a 409 compilation_in_progress", () => {
    const error = apiErrorFromResponse(
      409,
      errorExample("PublishConflict", "compilation_in_progress"),
    ) as ZelinqaCompilationInProgressError;

    expect(error.compilationId).toBe("cmp_01K2QF");
    expect(error.compilationStatus).toBe("running");
  });

  it("reads the issues of a 422 configuration_validation_failed", () => {
    const error = apiErrorFromResponse(
      422,
      errorExample("ConfigurationValidationFailed", "revision_perimee"),
    ) as ZelinqaConfigurationValidationError;

    expect(error.issues).toHaveLength(1);
    expect(at(error.issues, 0).code).toBe("draft_revision_mismatch");
    expect(at(error.issues, 0).entity).toBe("objective");
  });

  it("tolerates malformed details", () => {
    const scoped = apiErrorFromResponse(403, {
      code: "insufficient_scope",
      message: "nope",
      request_id: "req_x",
      details: { required_scopes: "not-an-array", granted_scopes: [1, "runtime"] },
    }) as ZelinqaInsufficientScopeError;
    expect(scoped.requiredScopes).toEqual([]);
    expect(scoped.grantedScopes).toEqual(["runtime"]);

    const validation = apiErrorFromResponse(422, {
      code: "configuration_validation_failed",
      message: "nope",
      request_id: "req_y",
      details: { issues: [{ code: 1 }, { code: "ok", message: "fine" }] },
    }) as ZelinqaConfigurationValidationError;
    expect(validation.issues).toHaveLength(1);
  });

  it("reads Retry-After in seconds and as an HTTP-date", () => {
    const seconds = apiErrorFromResponse(429, null, new Headers({ "Retry-After": "5" }));
    expect(seconds.retryAfter).toBe(5);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    const httpDate = apiErrorFromResponse(
      503,
      null,
      new Headers({ "Retry-After": "Tue, 01 Sep 2026 09:00:12 GMT" }),
    );
    expect(httpDate.retryAfter).toBe(12);
    vi.useRealTimers();

    const fromDetails = apiErrorFromResponse(503, errorExample("IdempotencyContention"));
    expect(fromDetails).toBeInstanceOf(ZelinqaIdempotencyContentionError);
    expect(fromDetails.retryAfter).toBe(1);

    expect(apiErrorFromResponse(503, null, new Headers({ "Retry-After": "soon" })).retryAfter).toBe(
      undefined,
    );
  });
});

describe("ZelinqaAPIError rendering", () => {
  it("formats as <code or status>: <message> (request_id=…)", () => {
    expect(String(apiErrorFromResponse(404, envelope("unknown_session")))).toBe(
      "unknown_session: message for unknown_session (request_id=req_unknown_session)",
    );
    expect(String(apiErrorFromResponse(401, { message: "Unauthorized" }))).toBe(
      "401: Unauthorized",
    );
    expect(apiErrorFromResponse(404, envelope("unknown_session")).name).toBe(
      "ZelinqaUnknownSessionError",
    );
  });
});

describe("end to end through the client", () => {
  it("retries idempotency_contention then raises it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const payload = errorExample("IdempotencyContention");
    const recorder = recordFetch([() => jsonResponse(payload, { status: 503 })]);

    const promise = client(recorder.fetch, 1)
      .createSession()
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await promise;
    vi.useRealTimers();

    expect(error).toBeInstanceOf(ZelinqaIdempotencyContentionError);
    expect((error as ZelinqaIdempotencyContentionError).code).toBe("idempotency_contention");
    expect(recorder.requests).toHaveLength(2);
  });

  it("does not retry a 422 and surfaces the next-turn detail", async () => {
    const payload = errorExample("NextUnprocessable", "invalid_previous_turn");
    const recorder = recordFetch([() => jsonResponse(payload, { status: 422 })]);

    const error = await client(recorder.fetch, 3)
      .next("ses_01J8Z", { state_version: 4 })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ZelinqaInvalidPreviousTurnError);
    expect((error as ZelinqaInvalidPreviousTurnError).details.pending_decision_id).toBe("dec_7f2a");
    expect(recorder.requests).toHaveLength(1);
  });

  it("raises ZelinqaConnectionError once the network keeps failing", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const recorder = recordFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);

    const promise = client(recorder.fetch, 1)
      .getSession("ses_01J8Z")
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(500);
    const error = await promise;
    vi.useRealTimers();

    expect(error).toBeInstanceOf(ZelinqaConnectionError);
    expect((error as ZelinqaConnectionError).message).toBe("Unable to reach the NBQ API");
    expect(recorder.requests).toHaveLength(2);
  });

  it("raises a typed error when the body is not JSON", async () => {
    const recorder = recordFetch([
      () =>
        new Response("<html>oops</html>", { status: 200, headers: { "X-Request-Id": "req_z" } }),
    ]);

    const error = await client(recorder.fetch)
      .getSession("ses_01J8Z")
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ZelinqaAPIError);
    expect((error as ZelinqaAPIError).message).toBe("NBQ API returned a non-JSON response");
    expect((error as ZelinqaAPIError).requestId).toBe("req_z");
  });

  it("never leaks the API key into an error, a message or a stack", async () => {
    const recorder = recordFetch([
      () =>
        jsonResponse(
          { code: "unauthorized", message: "no", request_id: "r", details: {} },
          { status: 401 },
        ),
      () => {
        throw new TypeError(`connect ECONNREFUSED for ${TEST_BASE_URL}`);
      },
    ]);
    const runtime = new ZelinqaClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      maxRetries: 0,
      fetch: recorder.fetch,
    });

    const apiError = await runtime.getSession("ses_01J8Z").catch((cause: unknown) => cause);
    const connectionError = await runtime.getSession("ses_01J8Z").catch((cause: unknown) => cause);

    for (const error of [apiError, connectionError]) {
      const thrown = error as Error;
      const rendered = [
        thrown.message,
        String(thrown),
        thrown.stack ?? "",
        JSON.stringify(thrown),
        JSON.stringify({ ...thrown }),
      ].join("\n");
      expect(rendered).not.toContain(TEST_API_KEY);
      expect(rendered.toLowerCase()).not.toContain("bearer");
    }
  });
});
