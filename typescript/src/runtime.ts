/**
 * Runtime client of the Zelinqa V1 API — the five session routes.
 *
 * Requires a key carrying the `runtime` scope. Keep it on a backend: the key is
 * a bearer credential and must never reach a browser or a mobile bundle.
 */

import { type AnswerInput, answerTurn } from "./answers.js";
import { encodePathSegment, HttpTransport } from "./http.js";
import type {
  FeedbackRequest,
  FeedbackResponse,
  NextRequest,
  NextResponse,
  PendingDecisionView,
  RequestOptions,
  SessionCreateRequest,
  SessionEventsRequest,
  SessionState,
  ZelinqaClientOptions,
} from "./types.js";

/** `NextRequest` with the `state_version` tracked by a `Session` handle. */
export type SessionNextInput = Omit<NextRequest, "state_version"> & {
  readonly state_version?: number;
};

/** `SessionEventsRequest` with the `state_version` tracked by a `Session` handle. */
export type SessionEventsInput = Omit<SessionEventsRequest, "state_version"> & {
  readonly state_version?: number;
};

function sessionPath(sessionId: string, suffix = ""): string {
  return `/v1/sessions/${encodePathSegment(sessionId, "sessionId")}${suffix}`;
}

export class ZelinqaClient {
  readonly #http: HttpTransport;

  public constructor(options: ZelinqaClientOptions) {
    this.#http = new HttpTransport(options);
  }

  public get baseUrl(): string {
    return this.#http.baseUrl;
  }

  /** Never exposes the API key. */
  public toString(): string {
    return `ZelinqaClient(baseUrl=${this.#http.baseUrl})`;
  }

  /**
   * `POST /v1/sessions` — creates a session pinned to the configuration version
   * published at that moment. No candidate is returned yet: call `next` after.
   */
  public async createSession(
    body: SessionCreateRequest = {},
    options?: RequestOptions,
  ): Promise<SessionState> {
    return await this.#http.requestJson<SessionState>({
      method: "POST",
      path: "/v1/sessions",
      body,
      mutation: true,
      options,
    });
  }

  /**
   * `POST /v1/sessions/{id}/next` — understands the previous turn, applies the
   * client updates, then ranks the eligible questions.
   */
  public async next(
    sessionId: string,
    body: NextRequest,
    options?: RequestOptions,
  ): Promise<NextResponse> {
    return await this.#http.requestJson<NextResponse>({
      method: "POST",
      path: sessionPath(sessionId, "/next"),
      body,
      mutation: true,
      options,
    });
  }

  /**
   * `POST /v1/sessions/{id}/events` — same reducer as `next`, without selection.
   */
  public async applyEvents(
    sessionId: string,
    body: SessionEventsRequest,
    options?: RequestOptions,
  ): Promise<SessionState> {
    return await this.#http.requestJson<SessionState>({
      method: "POST",
      path: sessionPath(sessionId, "/events"),
      body,
      mutation: true,
      options,
    });
  }

  /** `GET /v1/sessions/{id}` — full resume state, including rehydrated candidates. */
  public async getSession(sessionId: string, options?: RequestOptions): Promise<SessionState> {
    return await this.#http.requestJson<SessionState>({
      method: "GET",
      path: sessionPath(sessionId),
      options,
    });
  }

  /** `POST /v1/sessions/{id}/feedback` — records what the conversation produced. */
  public async submitFeedback(
    sessionId: string,
    body: FeedbackRequest,
    options?: RequestOptions,
  ): Promise<FeedbackResponse> {
    return await this.#http.requestJson<FeedbackResponse>({
      method: "POST",
      path: sessionPath(sessionId, "/feedback"),
      body,
      mutation: true,
      options,
    });
  }

  /** Creates a session and returns a handle that tracks `state_version` for you. */
  public async startSession(
    body: SessionCreateRequest = {},
    options?: RequestOptions,
  ): Promise<Session> {
    return Session.fromState(this, await this.createSession(body, options));
  }

  /** Reads an existing session and returns a handle that tracks `state_version`. */
  public async resumeSession(sessionId: string, options?: RequestOptions): Promise<Session> {
    return Session.fromState(this, await this.getSession(sessionId, options));
  }
}

/**
 * Ergonomic handle over one session: it remembers `state_version` and forwards it
 * to every mutation.
 *
 * Conflicts are never hidden. When the server answers `state_version_conflict`,
 * `ZelinqaStateVersionConflictError` propagates and the handle is left untouched:
 * decide yourself whether to `refresh()` and replay, or to surface the conflict.
 */
export class Session {
  readonly #client: ZelinqaClient;
  readonly #id: string;
  #stateVersion: number;
  #state: SessionState | undefined;
  #pendingDecision: PendingDecisionView | null;

  private constructor(
    client: ZelinqaClient,
    id: string,
    stateVersion: number,
    state: SessionState | undefined,
    pendingDecision: PendingDecisionView | null,
  ) {
    this.#client = client;
    this.#id = id;
    this.#stateVersion = stateVersion;
    this.#state = state;
    this.#pendingDecision = pendingDecision;
  }

  /** Builds a handle from a `SessionState` already read from the API. */
  public static fromState(client: ZelinqaClient, state: SessionState): Session {
    return new Session(
      client,
      state.session_id,
      state.versions.state_version,
      state,
      state.pending_decision,
    );
  }

  public get id(): string {
    return this.#id;
  }

  /** Last `versions.state_version` observed, sent with the next mutation. */
  public get stateVersion(): number {
    return this.#stateVersion;
  }

  /**
   * Last full `SessionState` read from `POST /v1/sessions`,
   * `POST /v1/sessions/{id}/events` or `refresh()`. `next()` does not return a
   * session state, so it leaves this value untouched — call `refresh()` for the
   * authoritative state.
   */
  public get state(): SessionState | undefined {
    return this.#state;
  }

  /** Decision proposed and not yet resolved, kept in sync with every call. */
  public get pendingDecision(): PendingDecisionView | null {
    return this.#pendingDecision;
  }

  /** Never exposes the API key. */
  public toString(): string {
    return `Session(id=${this.#id}, stateVersion=${this.#stateVersion})`;
  }

  /** `next` with the tracked `state_version`, unless the caller supplies one. */
  public async next(body: SessionNextInput = {}, options?: RequestOptions): Promise<NextResponse> {
    const response = await this.#client.next(
      this.#id,
      { ...body, state_version: body.state_version ?? this.#stateVersion },
      options,
    );
    this.#stateVersion = response.versions.state_version;
    this.#pendingDecision =
      response.action === "ask" && response.decision_id !== null
        ? { decision_id: response.decision_id, candidates: response.candidates }
        : null;
    return response;
  }

  /** Answer the candidate actually asked, without copying IDs. Call sequentially. */
  public async answer(answer: AnswerInput, options?: RequestOptions): Promise<NextResponse> {
    return await this.next({ previous_turn: answerTurn(this.#pendingDecision, answer) }, options);
  }

  /** `applyEvents` with the tracked `state_version`, unless the caller supplies one. */
  public async applyEvents(
    body: SessionEventsInput,
    options?: RequestOptions,
  ): Promise<SessionState> {
    const state = await this.#client.applyEvents(
      this.#id,
      { ...body, state_version: body.state_version ?? this.#stateVersion },
      options,
    );
    this.#absorb(state);
    return state;
  }

  /** Re-reads the session and resynchronises the handle. */
  public async refresh(options?: RequestOptions): Promise<SessionState> {
    const state = await this.#client.getSession(this.#id, options);
    this.#absorb(state);
    return state;
  }

  /** Records the business outcome of this conversation. */
  public async submitFeedback(
    body: FeedbackRequest,
    options?: RequestOptions,
  ): Promise<FeedbackResponse> {
    return await this.#client.submitFeedback(this.#id, body, options);
  }

  #absorb(state: SessionState): void {
    this.#stateVersion = state.versions.state_version;
    this.#state = state;
    this.#pendingDecision = state.pending_decision;
  }
}
