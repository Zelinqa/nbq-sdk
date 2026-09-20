import { describe, expect, it, vi } from "vitest";

import {
  type NextRequest,
  Session,
  type SessionCreateRequest,
  type SessionEventsRequest,
  type SessionState,
  VERSION,
  ZelinqaClient,
  ZelinqaStateVersionConflictError,
  ZelinqaUnknownSessionError,
} from "../src/index.js";
import {
  at,
  errorExample,
  jsonResponse,
  parseBody,
  recordFetch,
  requestExample,
  responseExample,
  sharedExample,
  TEST_API_KEY,
  TEST_BASE_URL,
} from "./helpers.js";

const SESSION_NEUVE = sharedExample("SessionNeuve");
const DECISION_NORMALE = sharedExample("DecisionNormale");
const ARRET_SANS_QUESTION = sharedExample("ArretSansQuestion");
const FEEDBACK_202 = responseExample("/v1/sessions/{session_id}/feedback", "post", "202");

function client(fetch: ReturnType<typeof recordFetch>["fetch"], maxRetries = 0): ZelinqaClient {
  return new ZelinqaClient({ apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL, maxRetries, fetch });
}

describe("ZelinqaClient.createSession", () => {
  it("posts the contract body with the mandatory headers", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE, { status: 201 })]);
    const body = requestExample(
      "/v1/sessions",
      "post",
      "reprise_conversation",
    ) as unknown as SessionCreateRequest;

    const state = await client(recorder.fetch).createSession(body, {
      idempotencyKey: "create-session-8842",
    });

    const request = at(recorder.requests, 0);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/sessions");
    expect(request.search).toBe("");
    expect(request.headers).toMatchObject({
      Authorization: `Bearer ${TEST_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": "create-session-8842",
      "User-Agent": `nbq-typescript/${VERSION}`,
    });
    expect(parseBody(request)).toEqual(body);
    expect(state).toEqual(SESSION_NEUVE);
    expect(state.versions.state_version).toBe(0);
    expect(state.status).toBe("active");
  });

  it("defaults to an empty body and generates a UUID idempotency key", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE, { status: 201 })]);

    await client(recorder.fetch).createSession();

    const request = at(recorder.requests, 0);
    expect(parseBody(request)).toEqual({});
    expect(at(recorder.requests, 0).headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("reuses the same Idempotency-Key across retries", async () => {
    const recorder = recordFetch([
      () =>
        jsonResponse(
          { code: "idempotency_contention", message: "retry", request_id: "req_1", details: {} },
          { status: 503, headers: { "Retry-After": "0" } },
        ),
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
    ]);

    await client(recorder.fetch, 1).createSession();

    expect(recorder.requests).toHaveLength(2);
    const first = at(recorder.requests, 0).headers["Idempotency-Key"];
    expect(first).toBeDefined();
    expect(at(recorder.requests, 1).headers["Idempotency-Key"]).toBe(first);
  });
});

describe("ZelinqaClient.next", () => {
  it("posts the structured-answer body and returns the contract decision", async () => {
    const recorder = recordFetch([() => jsonResponse(DECISION_NORMALE)]);
    const body = requestExample(
      "/v1/sessions/{session_id}/next",
      "post",
      "tour_avec_reponse_structuree",
    ) as unknown as NextRequest;

    const response = await client(recorder.fetch).next("ses_01J8Z", body);

    const request = at(recorder.requests, 0);
    expect(request.path).toBe("/v1/sessions/ses_01J8Z/next");
    expect(parseBody(request)).toEqual(body);
    expect(response).toEqual(DECISION_NORMALE);
    expect(response.action).toBe("ask");
    expect(response.candidates).toHaveLength(2);
    expect(at(response.candidates, 0).rank).toBe(1);
  });

  it("percent-encodes the session id and rejects an empty one", async () => {
    const recorder = recordFetch([() => jsonResponse(DECISION_NORMALE)]);
    const runtime = client(recorder.fetch);

    await runtime.next("ses/../secret", { state_version: 0 });
    expect(at(recorder.requests, 0).path).toBe("/v1/sessions/ses%2F..%2Fsecret/next");

    await expect(runtime.next("  ", { state_version: 0 })).rejects.toThrow(TypeError);
  });

  it("passes an explicit selection constraint through untouched", async () => {
    const recorder = recordFetch([() => jsonResponse(ARRET_SANS_QUESTION)]);
    const body = requestExample(
      "/v1/sessions/{session_id}/next",
      "post",
      "selection_contrainte",
    ) as unknown as NextRequest;

    const response = await client(recorder.fetch).next("ses_01J8Z", body);

    expect(parseBody(at(recorder.requests, 0))).toEqual(body);
    expect(response.action).toBe("stop");
    expect(response.stop_reason).toBe("no_question_available");
    expect(response.decision_id).toBeNull();
  });
});

describe("ZelinqaClient.applyEvents", () => {
  it("posts to /events with the contract body", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE)]);
    const body = requestExample(
      "/v1/sessions/{session_id}/events",
      "post",
      "resume_intermediaire",
    ) as unknown as SessionEventsRequest;

    const state = await client(recorder.fetch).applyEvents("ses_01J8Z", body);

    const request = at(recorder.requests, 0);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/sessions/ses_01J8Z/events");
    expect(request.headers["Idempotency-Key"]).toBeDefined();
    expect(parseBody(request)).toEqual(body);
    expect(state).toEqual(SESSION_NEUVE);
  });
});

describe("ZelinqaClient.getSession", () => {
  it("reads the session without a body, a content type or an idempotency key", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE)]);

    const state = await client(recorder.fetch).getSession("ses_01J8Z");

    const request = at(recorder.requests, 0);
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/sessions/ses_01J8Z");
    expect(request.rawBody).toBeUndefined();
    expect(request.headers["Content-Type"]).toBeUndefined();
    expect(request.headers["Idempotency-Key"]).toBeUndefined();
    expect(state).toEqual(SESSION_NEUVE);
  });

  it("maps an unknown session to ZelinqaUnknownSessionError", async () => {
    const payload = errorExample("UnknownSession");
    const recorder = recordFetch([() => jsonResponse(payload, { status: 404 })]);

    await expect(client(recorder.fetch).getSession("ses_inconnue")).rejects.toBeInstanceOf(
      ZelinqaUnknownSessionError,
    );
  });
});

describe("ZelinqaClient.submitFeedback", () => {
  it("posts the feedback and returns the 202 body", async () => {
    const recorder = recordFetch([() => jsonResponse(FEEDBACK_202, { status: 202 })]);
    const body = requestExample("/v1/sessions/{session_id}/feedback", "post", "succes");

    const response = await client(recorder.fetch).submitFeedback(
      "ses_01J8Z",
      body as unknown as Parameters<ZelinqaClient["submitFeedback"]>[1],
      { idempotencyKey: "feedback-ses01J8Z" },
    );

    const request = at(recorder.requests, 0);
    expect(request.path).toBe("/v1/sessions/ses_01J8Z/feedback");
    expect(request.headers["Idempotency-Key"]).toBe("feedback-ses01J8Z");
    expect(parseBody(request)).toEqual(body);
    expect(response).toEqual(FEEDBACK_202);
    expect(response.feedback_id).toBe("fbk_02K1");
  });
});

describe("Session handle", () => {
  it("starts from createSession and exposes the pinned state", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE, { status: 201 })]);

    const session = await client(recorder.fetch).startSession({
      client_reference: "crm-lead-8842",
    });

    expect(session).toBeInstanceOf(Session);
    expect(session.id).toBe("ses_01J8Z");
    expect(session.stateVersion).toBe(0);
    expect(session.pendingDecision).toBeNull();
    expect(session.state).toEqual(SESSION_NEUVE);
    expect(String(session)).toBe("Session(id=ses_01J8Z, stateVersion=0)");
  });

  it("resumes from getSession", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE)]);

    const session = await client(recorder.fetch).resumeSession("ses_01J8Z");

    expect(at(recorder.requests, 0).method).toBe("GET");
    expect(session.stateVersion).toBe(0);
  });

  it("forwards the tracked state_version and tracks the pending decision", async () => {
    const recorder = recordFetch([
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
      () => jsonResponse(DECISION_NORMALE),
    ]);
    const session = await client(recorder.fetch).startSession();

    const decision = await session.next({
      previous_turn: { assistant_text: "Et côté budget ?", user_text: "Autour de 2 000 euros." },
    });

    expect(parseBody(at(recorder.requests, 1))).toEqual({
      previous_turn: { assistant_text: "Et côté budget ?", user_text: "Autour de 2 000 euros." },
      state_version: 0,
    });
    expect(session.stateVersion).toBe(4);
    expect(decision.versions.state_version).toBe(4);
    expect(session.pendingDecision).toEqual({
      decision_id: "dec_7f2a",
      candidates: DECISION_NORMALE.candidates,
    });
  });

  it("clears the pending decision when the engine stops", async () => {
    const recorder = recordFetch([
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
      () => jsonResponse(ARRET_SANS_QUESTION),
    ]);
    const session = await client(recorder.fetch).startSession();

    await session.next();

    expect(session.pendingDecision).toBeNull();
    expect(session.stateVersion).toBe(25);
  });

  it("lets the caller override state_version explicitly", async () => {
    const recorder = recordFetch([
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
      () => jsonResponse(DECISION_NORMALE),
    ]);
    const session = await client(recorder.fetch).startSession();

    await session.next({ state_version: 3 });

    expect(parseBody(at(recorder.requests, 1))).toEqual({ state_version: 3 });
  });

  it("applies events and refreshes with the tracked version", async () => {
    const refreshed: SessionState = {
      ...(SESSION_NEUVE as unknown as SessionState),
      turn_count: 2,
      versions: { state_version: 9, engine_version: "1.0.0", api_version: "1.0" },
    };
    const recorder = recordFetch([
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
      () => jsonResponse(refreshed),
      () => jsonResponse({ ...refreshed, versions: { ...refreshed.versions, state_version: 10 } }),
    ]);
    const session = await client(recorder.fetch).startSession();

    await session.applyEvents({
      client_updates: { data: [{ id: "sdk_budget", operation: "set", value: 2500 }] },
    });
    expect(parseBody(at(recorder.requests, 1))).toEqual({
      client_updates: { data: [{ id: "sdk_budget", operation: "set", value: 2500 }] },
      state_version: 0,
    });
    expect(session.stateVersion).toBe(9);
    expect(session.state?.turn_count).toBe(2);

    await session.refresh();
    expect(at(recorder.requests, 2).method).toBe("GET");
    expect(session.stateVersion).toBe(10);
  });

  it("submits feedback through the handle", async () => {
    const recorder = recordFetch([
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
      () => jsonResponse(FEEDBACK_202, { status: 202 }),
    ]);
    const session = await client(recorder.fetch).startSession();

    const response = await session.submitFeedback({ result: "success", label: "achat" });

    expect(at(recorder.requests, 1).path).toBe("/v1/sessions/ses_01J8Z/feedback");
    expect(response).toEqual(FEEDBACK_202);
  });

  it("propagates a state_version conflict and never auto-refreshes", async () => {
    const conflict = errorExample("SessionMutationConflict", "state_version_conflict");
    const recorder = recordFetch([
      () => jsonResponse(SESSION_NEUVE, { status: 201 }),
      () => jsonResponse(conflict, { status: 409 }),
    ]);
    const session = await client(recorder.fetch).startSession();

    const error = await session.next().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ZelinqaStateVersionConflictError);
    const conflictError = error as ZelinqaStateVersionConflictError;
    expect(conflictError.suppliedStateVersion).toBe(7);
    expect(conflictError.currentStateVersion).toBe(8);
    expect(conflictError.code).toBe("state_version_conflict");
    expect(session.stateVersion).toBe(0);
    expect(recorder.requests).toHaveLength(2);
  });
});

describe("ZelinqaClient construction", () => {
  it("validates its options and never prints the key", () => {
    const fetch = vi.fn();
    expect(() => new ZelinqaClient({ apiKey: "  ", fetch })).toThrow(TypeError);
    expect(() => new ZelinqaClient({ apiKey: "k", baseUrl: "nope", fetch })).toThrow(TypeError);
    expect(() => new ZelinqaClient({ apiKey: "k", baseUrl: "https://u:p@x.test", fetch })).toThrow(
      /credentials/,
    );
    expect(() => new ZelinqaClient({ apiKey: "k", baseUrl: "https://x.test?a=1", fetch })).toThrow(
      /query string/,
    );
    expect(() => new ZelinqaClient({ apiKey: "k", timeoutMs: 0, fetch })).toThrow(TypeError);
    expect(() => new ZelinqaClient({ apiKey: "k", maxRetries: -1, fetch })).toThrow(TypeError);

    const runtime = new ZelinqaClient({ apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL, fetch });
    expect(runtime.baseUrl).toBe(TEST_BASE_URL);
    expect(String(runtime)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(runtime)).not.toContain(TEST_API_KEY);
  });

  it("rejects an idempotency key the contract would refuse", async () => {
    const recorder = recordFetch([() => jsonResponse(SESSION_NEUVE, { status: 201 })]);
    const runtime = client(recorder.fetch);

    await expect(runtime.createSession({}, { idempotencyKey: "short" })).rejects.toThrow(TypeError);
    await expect(runtime.createSession({}, { idempotencyKey: "" })).rejects.toThrow(TypeError);
    expect(recorder.requests).toHaveLength(0);
  });
});
