import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CompilationStatus,
  type ConfigurationChangesRequest,
  NBQAuthenticationError,
  NBQCompilationInProgressError,
  NBQCompilationTimeoutError,
  NBQConfigurationClient,
  NBQConfigurationValidationError,
  NBQInsufficientScopeError,
  NBQUnknownCompilationError,
  VERSION,
} from "../src/index.js";
import {
  at,
  csvResponseExample,
  errorExample,
  jsonResponse,
  parseBody,
  recordFetch,
  requestExample,
  responseExample,
  sharedExample,
  TEST_API_KEY,
  TEST_BASE_URL,
  textResponse,
} from "./helpers.js";

const CONFIGURATION = sharedExample("ConfigurationPubliee");
const QUESTION_PAGE = sharedExample("PageDeQuestions");
const AUDIT_PAGE = responseExample("/v1/configuration/audit", "get", "200");
const CHANGES_RESPONSE = responseExample("/v1/configuration/changes", "post", "200");
const PUBLISH_ACCEPTED = responseExample("/v1/configuration/publish", "post", "202");
const COMPILATION_RUNNING = responseExample(
  "/v1/configuration/compilations/{compilation_id}",
  "get",
  "200",
  "en_cours",
);
const COMPILATION_DONE = responseExample(
  "/v1/configuration/compilations/{compilation_id}",
  "get",
  "200",
  "terminee",
);
const COMPILATION_FAILED = responseExample(
  "/v1/configuration/compilations/{compilation_id}",
  "get",
  "200",
  "echouee",
);

function client(
  fetch: ReturnType<typeof recordFetch>["fetch"],
  maxRetries = 0,
): NBQConfigurationClient {
  return new NBQConfigurationClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    maxRetries,
    fetch,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NBQConfigurationClient.getConfiguration", () => {
  it("reads the published configuration by default", async () => {
    const recorder = recordFetch([() => jsonResponse(CONFIGURATION)]);

    const configuration = await client(recorder.fetch).getConfiguration();

    const request = at(recorder.requests, 0);
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/configuration");
    expect(request.search).toBe("");
    expect(request.headers).toMatchObject({
      Authorization: `Bearer ${TEST_API_KEY}`,
      Accept: "application/json",
      "User-Agent": `nbq-typescript/${VERSION}`,
    });
    expect(configuration).toEqual(CONFIGURATION);
    expect(configuration.state).toBe("published");
    expect(configuration.questions).toHaveLength(3);
  });

  it("maps the envelope-less gateway 403 to an authentication error", async () => {
    // A key that lacks the scope the AUTHORIZER requires statically never reaches
    // the service, so the body is `{"message":"Forbidden"}` and is
    // indistinguishable from an invalid or revoked key.
    const recorder = recordFetch([() => jsonResponse({ message: "Forbidden" }, { status: 403 })]);

    const error = await client(recorder.fetch)
      .getConfiguration()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NBQAuthenticationError);
    expect(error).not.toBeInstanceOf(NBQInsufficientScopeError);
    expect((error as NBQAuthenticationError).statusCode).toBe(403);
    expect((error as NBQAuthenticationError).code).toBeUndefined();
  });

  it("asks for the draft explicitly and surfaces the dynamic scope refusal", async () => {
    const draft = { ...CONFIGURATION, state: "draft", draft_revision: 42 };
    const recorder = recordFetch([
      () => jsonResponse(draft),
      () => jsonResponse(errorExample("InsufficientScope"), { status: 403 }),
    ]);
    const configuration = client(recorder.fetch);

    const result = await configuration.getConfiguration({ state: "draft" });
    expect(at(recorder.requests, 0).search).toBe("?state=draft");
    expect(result.draft_revision).toBe(42);

    const error = await configuration
      .getConfiguration({ state: "draft" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NBQInsufficientScopeError);
    expect((error as NBQInsufficientScopeError).requiredScopes).toEqual(["configuration:publish"]);
    expect((error as NBQInsufficientScopeError).grantedScopes).toEqual([
      "configuration:read",
      "configuration:write",
    ]);
  });
});

describe("NBQConfigurationClient.listQuestions", () => {
  it("serialises every filter into the query string", async () => {
    const recorder = recordFetch([() => jsonResponse(QUESTION_PAGE)]);

    const page = await client(recorder.fetch).listQuestions({
      state: "published",
      sub_objective_id: "so_besoin",
      active: true,
      type: "single_choice",
      search: "canapé",
      limit: 2,
      cursor: "cur_1",
    });

    const request = at(recorder.requests, 0);
    expect(request.path).toBe("/v1/configuration/questions");
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
      state: "published",
      sub_objective_id: "so_besoin",
      active: "true",
      type: "single_choice",
      search: "canapé",
      limit: "2",
      cursor: "cur_1",
    });
    expect(page).toEqual(QUESTION_PAGE);
  });

  it("omits absent filters entirely", async () => {
    const recorder = recordFetch([() => jsonResponse(QUESTION_PAGE)]);

    await client(recorder.fetch).listQuestions({ limit: 50 });

    expect(at(recorder.requests, 0).search).toBe("?limit=50");
  });
});

describe("NBQConfigurationClient.iterateQuestions", () => {
  it("follows next_cursor until the last page", async () => {
    const firstQuestion = at(QUESTION_PAGE.questions as unknown[], 0);
    const secondQuestion = at(QUESTION_PAGE.questions as unknown[], 1);
    const recorder = recordFetch([
      () => jsonResponse({ ...QUESTION_PAGE, questions: [firstQuestion], next_cursor: "cur_2" }),
      () => jsonResponse({ ...QUESTION_PAGE, questions: [secondQuestion], next_cursor: null }),
    ]);

    const collected: unknown[] = [];
    for await (const question of client(recorder.fetch).iterateQuestions({ limit: 1 })) {
      collected.push(question);
    }

    expect(collected).toEqual([firstQuestion, secondQuestion]);
    expect(recorder.requests).toHaveLength(2);
    expect(at(recorder.requests, 0).search).toBe("?limit=1");
    expect(at(recorder.requests, 1).search).toBe("?limit=1&cursor=cur_2");
  });

  it("stops after a single page when next_cursor is null", async () => {
    const recorder = recordFetch([() => jsonResponse(QUESTION_PAGE)]);

    const ids: string[] = [];
    for await (const question of client(recorder.fetch).iterateQuestions()) {
      ids.push(question.id);
    }

    expect(ids).toEqual(["q_style", "q_budget"]);
    expect(recorder.requests).toHaveLength(1);
  });
});

describe("NBQConfigurationClient.exportQuestionsCsv", () => {
  it("asks for text/csv and returns the raw export", async () => {
    const csv = csvResponseExample();
    const recorder = recordFetch([() => textResponse(csv)]);

    const exported = await client(recorder.fetch).exportQuestionsCsv({
      sub_objective_id: "so_besoin",
      limit: 10,
      cursor: "cur_1",
    });

    const request = at(recorder.requests, 0);
    expect(request.headers.Accept).toBe("text/csv");
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
      sub_objective_id: "so_besoin",
      format: "csv",
    });
    expect(exported).toBe(csv);
    expect(exported.split("\n")[0]).toBe("id,text,type,choices,sub_objective_id,active");
  });
});

describe("NBQConfigurationClient.listAudit", () => {
  it("returns the audit page and forwards its filters", async () => {
    const recorder = recordFetch([() => jsonResponse(AUDIT_PAGE)]);

    const page = await client(recorder.fetch).listAudit({
      limit: 50,
      action: "configuration.question.deactivated",
      resource_type: "question",
      cursor: "cur_a",
    });

    const request = at(recorder.requests, 0);
    expect(request.path).toBe("/v1/configuration/audit");
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
      limit: "50",
      cursor: "cur_a",
      action: "configuration.question.deactivated",
      resource_type: "question",
    });
    expect(page).toEqual(AUDIT_PAGE);
    expect(at(page.events, 0).actor.type).toBe("cognito_user");
    expect(page.next_cursor).toBeNull();
  });
});

describe("NBQConfigurationClient.applyChanges", () => {
  it("posts the ordered change list with an idempotency key", async () => {
    const recorder = recordFetch([() => jsonResponse(CHANGES_RESPONSE)]);
    const body = requestExample(
      "/v1/configuration/changes",
      "post",
      "ajout_question_et_information",
    ) as unknown as ConfigurationChangesRequest;

    const response = await client(recorder.fetch).applyChanges(body, {
      idempotencyKey: "changes-rev-41",
    });

    const request = at(recorder.requests, 0);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/configuration/changes");
    expect(request.headers["Idempotency-Key"]).toBe("changes-rev-41");
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(parseBody(request)).toEqual(body);
    expect(response).toEqual(CHANGES_RESPONSE);
    expect(response.draft_revision).toBe(42);
  });

  it("reuses the same Idempotency-Key across retries", async () => {
    const recorder = recordFetch([
      () => jsonResponse({}, { status: 502 }),
      () => jsonResponse(CHANGES_RESPONSE),
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();

    const promise = client(recorder.fetch, 1).applyChanges({
      changes: [{ entity: "objective", operation: "update", objective: { max_turns: 12 } }],
    });
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(recorder.requests).toHaveLength(2);
    const key = at(recorder.requests, 0).headers["Idempotency-Key"];
    expect(key).toBeDefined();
    expect(at(recorder.requests, 1).headers["Idempotency-Key"]).toBe(key);
  });

  it("surfaces grouped validation issues", async () => {
    const payload = errorExample("ConfigurationValidationFailed", "validation_publication");
    const recorder = recordFetch([() => jsonResponse(payload, { status: 422 })]);

    const error = await client(recorder.fetch)
      .applyChanges({ changes: [{ entity: "objective", operation: "update", objective: {} }] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NBQConfigurationValidationError);
    const validation = error as NBQConfigurationValidationError;
    expect(validation.issues).toHaveLength(2);
    expect(at(validation.issues, 0).code).toBe("success_information_without_active_question");
  });
});

describe("NBQConfigurationClient.publish", () => {
  it("queues a compilation and returns the 202 status", async () => {
    const recorder = recordFetch([() => jsonResponse(PUBLISH_ACCEPTED, { status: 202 })]);

    const status = await client(recorder.fetch).publish({ expected_draft_revision: 42 });

    const request = at(recorder.requests, 0);
    expect(request.path).toBe("/v1/configuration/publish");
    expect(request.headers["Idempotency-Key"]).toBeDefined();
    expect(parseBody(request)).toEqual({ expected_draft_revision: 42 });
    expect(status).toEqual(PUBLISH_ACCEPTED);
    expect(status.status).toBe("queued");
  });

  it("sends an empty body when no revision is pinned", async () => {
    const recorder = recordFetch([() => jsonResponse(PUBLISH_ACCEPTED, { status: 202 })]);

    await client(recorder.fetch).publish();

    expect(parseBody(at(recorder.requests, 0))).toEqual({});
  });

  it("reports a compilation already in progress", async () => {
    const payload = errorExample("PublishConflict", "compilation_in_progress");
    const recorder = recordFetch([() => jsonResponse(payload, { status: 409 })]);

    const error = await client(recorder.fetch)
      .publish()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(NBQCompilationInProgressError);
    const conflict = error as NBQCompilationInProgressError;
    expect(conflict.compilationId).toBe("cmp_01K2QF");
    expect(conflict.compilationStatus).toBe("running");
  });
});

describe("NBQConfigurationClient.getCompilation", () => {
  it("reads a job status", async () => {
    const recorder = recordFetch([() => jsonResponse(COMPILATION_RUNNING)]);

    const status = await client(recorder.fetch).getCompilation("cmp_01K2QF");

    expect(at(recorder.requests, 0).path).toBe("/v1/configuration/compilations/cmp_01K2QF");
    expect(status).toEqual(COMPILATION_RUNNING);
    expect(status.progress).toBe(0.45);
  });

  it("maps an unknown compilation", async () => {
    const recorder = recordFetch([
      () => jsonResponse(errorExample("UnknownCompilation"), { status: 404 }),
    ]);

    await expect(client(recorder.fetch).getCompilation("cmp_x")).rejects.toBeInstanceOf(
      NBQUnknownCompilationError,
    );
  });
});

describe("NBQConfigurationClient.waitForCompilation", () => {
  it("polls until the job succeeds", async () => {
    vi.useFakeTimers();
    const recorder = recordFetch([
      () => jsonResponse(PUBLISH_ACCEPTED),
      () => jsonResponse(COMPILATION_RUNNING),
      () => jsonResponse(COMPILATION_DONE),
    ]);

    const promise = client(recorder.fetch).waitForCompilation("cmp_01K2QF", {
      pollIntervalMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const status = await promise;

    expect(recorder.requests).toHaveLength(3);
    expect(at(recorder.requests, 2).path).toBe("/v1/configuration/compilations/cmp_01K2QF");
    expect(status).toEqual(COMPILATION_DONE);
    expect(status.configuration_version).toBe("cfg_00014");
  });

  it("returns a failed job instead of raising", async () => {
    vi.useFakeTimers();
    const recorder = recordFetch([() => jsonResponse(COMPILATION_FAILED)]);

    const status = await client(recorder.fetch).waitForCompilation("cmp_01K2QG");

    expect(status.status).toBe("failed");
    expect((status.error as NonNullable<CompilationStatus["error"]>).code).toBe("llm_unavailable");
  });

  it("raises NBQCompilationTimeoutError once the budget is spent", async () => {
    vi.useFakeTimers();
    const recorder = recordFetch([() => jsonResponse(PUBLISH_ACCEPTED)]);

    const promise = client(recorder.fetch)
      .waitForCompilation("cmp_01K2QF", { pollIntervalMs: 3_000, timeoutMs: 5_000 })
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await promise;

    expect(error).toBeInstanceOf(NBQCompilationTimeoutError);
    expect((error as NBQCompilationTimeoutError).compilationId).toBe("cmp_01K2QF");
    expect((error as NBQCompilationTimeoutError).timeoutMs).toBe(5_000);
    expect(recorder.requests).toHaveLength(2);
  });

  it("stops when the caller aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const recorder = recordFetch([() => jsonResponse(PUBLISH_ACCEPTED)]);

    const promise = client(recorder.fetch)
      .waitForCompilation("cmp_01K2QF", { pollIntervalMs: 60_000, signal: controller.signal })
      .catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error("caller changed its mind"));
    const error = await promise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("caller changed its mind");
    expect(recorder.requests).toHaveLength(1);
  });

  it("validates its polling options", async () => {
    const recorder = recordFetch([() => jsonResponse(COMPILATION_DONE)]);
    const configuration = client(recorder.fetch);

    await expect(configuration.waitForCompilation("cmp_1", { pollIntervalMs: 0 })).rejects.toThrow(
      TypeError,
    );
    await expect(configuration.waitForCompilation("cmp_1", { timeoutMs: -1 })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("NBQConfigurationClient construction", () => {
  it("never prints the key", () => {
    const configuration = new NBQConfigurationClient({
      apiKey: TEST_API_KEY,
      baseUrl: TEST_BASE_URL,
      fetch: vi.fn(),
    });

    expect(configuration.baseUrl).toBe(TEST_BASE_URL);
    expect(String(configuration)).not.toContain(TEST_API_KEY);
  });
});
