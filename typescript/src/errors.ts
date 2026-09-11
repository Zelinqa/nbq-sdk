/**
 * Typed error hierarchy of the NBQ Engine V1 SDK.
 *
 * Every failure raised by a client is an `NBQError`. HTTP failures carry the V1
 * error envelope (`code`, `message`, `request_id`, `details`) when the service
 * produced one.
 *
 * The deployed gateway refuses some requests before the service is reached, with
 * a body that is not an envelope:
 * - no `Authorization` header at all → `401 {"message":"Unauthorized"}`;
 * - key invalid, revoked or expired, or missing the scope the authorizer
 *   requires statically for the route → `403 {"message":"Forbidden"}`.
 *
 * The two `403` causes are indistinguishable from the outside, so any `403`
 * without an envelope becomes `NBQAuthenticationError`.
 * `NBQInsufficientScopeError` is reserved for the service's own dynamic check,
 * which does answer a V1 envelope with `code: insufficient_scope` — today only
 * `?state=draft` read with a key that lacks `configuration:write`.
 *
 * The API key never appears in an error, a message or a stack trace.
 */
import type { ConfigurationIssue, ErrorCode } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const EMPTY_DETAILS: Readonly<UnknownRecord> = Object.freeze({});

/** Message of a gateway `403` with no envelope: the two causes are not separable. */
export const GATEWAY_FORBIDDEN_MESSAGE =
  "Forbidden by the API gateway: the key is invalid, revoked, expired, or does not carry the scope required for this route.";

export interface NBQAPIErrorOptions {
  readonly statusCode: number;
  /** Envelope `code`, or `undefined` when the body is not a V1 envelope. */
  readonly code?: ErrorCode | string | undefined;
  readonly requestId?: string | undefined;
  readonly details?: Readonly<UnknownRecord> | undefined;
  /** Seconds advertised by `Retry-After` or `details.retry_after_seconds`. */
  readonly retryAfter?: number | undefined;
  readonly cause?: unknown;
}

/** Base class of every error raised by the SDK. */
export class NBQError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API could not be reached: DNS, socket, TLS or per-attempt timeout. */
export class NBQConnectionError extends NBQError {}

/** `waitForCompilation` exhausted its budget before the job reached a terminal state. */
export class NBQCompilationTimeoutError extends NBQError {
  public readonly compilationId: string;
  public readonly timeoutMs: number;

  public constructor(message: string, compilationId: string, timeoutMs: number) {
    super(message);
    this.compilationId = compilationId;
    this.timeoutMs = timeoutMs;
  }
}

/** The API answered with an HTTP error status. */
export class NBQAPIError extends NBQError {
  public readonly statusCode: number;
  public readonly code: ErrorCode | string | undefined;
  public readonly requestId: string | undefined;
  public readonly details: Readonly<UnknownRecord>;
  public readonly retryAfter: number | undefined;

  public constructor(message: string, options: NBQAPIErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details ?? EMPTY_DETAILS;
    this.retryAfter = options.retryAfter;
  }

  public override toString(): string {
    const prefix = this.code ?? String(this.statusCode);
    const suffix = this.requestId === undefined ? "" : ` (request_id=${this.requestId})`;
    return `${prefix}: ${this.message}${suffix}`;
  }
}

/**
 * The gateway refused the credential.
 *
 * `401` when no `Authorization` header was sent; `403` without a V1 envelope
 * when the key is invalid, revoked, expired, or does not carry the scope the
 * authorizer requires for the route — the gateway does not distinguish them.
 * Read `statusCode` to tell the two apart.
 */
export class NBQAuthenticationError extends NBQAPIError {}

/**
 * `403` with the V1 envelope `insufficient_scope` — the service's own dynamic
 * check refused the request. Today that means reading a draft with a key that
 * carries `configuration:read` but not `configuration:write`.
 */
export class NBQInsufficientScopeError extends NBQAPIError {
  public readonly requiredScopes: readonly string[];
  public readonly grantedScopes: readonly string[];

  public constructor(message: string, options: NBQAPIErrorOptions) {
    super(message, options);
    this.requiredScopes = stringArray(this.details.required_scopes);
    this.grantedScopes = stringArray(this.details.granted_scopes);
  }
}

/** `404` — the addressed resource does not exist for this tenant. */
export class NBQNotFoundError extends NBQAPIError {}
export class NBQUnknownSessionError extends NBQNotFoundError {}
export class NBQUnknownConfigurationError extends NBQNotFoundError {}
export class NBQUnknownCompilationError extends NBQNotFoundError {}

/** `409` — the request conflicts with the current server state. */
export class NBQConflictError extends NBQAPIError {}

/** `409 state_version_conflict` — the session moved since the version the caller read. */
export class NBQStateVersionConflictError extends NBQConflictError {
  public readonly suppliedStateVersion: number | undefined;
  public readonly currentStateVersion: number | undefined;

  public constructor(message: string, options: NBQAPIErrorOptions) {
    super(message, options);
    this.suppliedStateVersion = numberOrUndefined(this.details.supplied_state_version);
    this.currentStateVersion = numberOrUndefined(this.details.current_state_version);
  }
}

/** `409 idempotency_key_reused` — same key, different body. Definitive. */
export class NBQIdempotencyKeyReusedError extends NBQConflictError {}

/** `409 compilation_in_progress` — a job is already queued or running for this NBQ. */
export class NBQCompilationInProgressError extends NBQConflictError {
  public readonly compilationId: string | undefined;
  public readonly compilationStatus: string | undefined;

  public constructor(message: string, options: NBQAPIErrorOptions) {
    super(message, options);
    this.compilationId = stringOrUndefined(this.details.compilation_id);
    this.compilationStatus = stringOrUndefined(this.details.status);
  }
}

/** `410 compiled_artifact_unavailable` — the artifact pinned by the session is unreachable. */
export class NBQCompiledArtifactUnavailableError extends NBQAPIError {}

/** `422` — the payload is well formed but cannot be processed. */
export class NBQValidationError extends NBQAPIError {}
export class NBQInvalidPreviousTurnError extends NBQValidationError {}
export class NBQConstraintNoMatchError extends NBQValidationError {}
export class NBQInvalidChoiceError extends NBQValidationError {}

/** `422 configuration_validation_failed` — the draft is not applicable or not publishable. */
export class NBQConfigurationValidationError extends NBQValidationError {
  public readonly issues: readonly ConfigurationIssue[];

  public constructor(message: string, options: NBQAPIErrorOptions) {
    super(message, options);
    this.issues = configurationIssues(this.details.issues);
  }
}

/** `429` — the caller is rate limited. Retried automatically. */
export class NBQRateLimitError extends NBQAPIError {}

/** `503 idempotency_contention` — retried automatically; raised once retries are exhausted. */
export class NBQIdempotencyContentionError extends NBQAPIError {}

/** Any other `5xx`. Retried automatically for the retriable statuses. */
export class NBQServerError extends NBQAPIError {}

/* ---------------------------------------------------------------------- Mapping */

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Object.freeze(value.filter((entry): entry is string => typeof entry === "string"));
}

function configurationIssues(value: unknown): readonly ConfigurationIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const issues = value.filter(
    (entry): entry is ConfigurationIssue =>
      isRecord(entry) && typeof entry.code === "string" && typeof entry.message === "string",
  );
  return Object.freeze(issues);
}

/** Seconds to wait, from `Retry-After`; accepts a delta in seconds or an HTTP-date. */
export function parseRetryAfterHeader(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0);
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max((timestamp - nowMs) / 1000, 0);
  }
  return undefined;
}

type NBQAPIErrorClass = new (message: string, options: NBQAPIErrorOptions) => NBQAPIError;

const BY_CODE: Readonly<Record<string, NBQAPIErrorClass>> = Object.freeze({
  unauthorized: NBQAuthenticationError,
  insufficient_scope: NBQInsufficientScopeError,
  idempotency_contention: NBQIdempotencyContentionError,
  state_version_conflict: NBQStateVersionConflictError,
  idempotency_key_reused: NBQIdempotencyKeyReusedError,
  unknown_session: NBQUnknownSessionError,
  invalid_previous_turn: NBQInvalidPreviousTurnError,
  constraint_no_match: NBQConstraintNoMatchError,
  invalid_choice: NBQInvalidChoiceError,
  compiled_artifact_unavailable: NBQCompiledArtifactUnavailableError,
  configuration_validation_failed: NBQConfigurationValidationError,
  compilation_in_progress: NBQCompilationInProgressError,
  unknown_configuration: NBQUnknownConfigurationError,
  unknown_compilation: NBQUnknownCompilationError,
});

function byStatus(statusCode: number): NBQAPIErrorClass {
  if (statusCode === 401) {
    return NBQAuthenticationError;
  }
  if (statusCode === 403) {
    // No V1 envelope: the gateway refused the credential and does not say
    // whether the key is invalid or merely under-scoped.
    return NBQAuthenticationError;
  }
  if (statusCode === 404) {
    return NBQNotFoundError;
  }
  if (statusCode === 409) {
    return NBQConflictError;
  }
  if (statusCode === 410) {
    return NBQCompiledArtifactUnavailableError;
  }
  if (statusCode === 422) {
    return NBQValidationError;
  }
  if (statusCode === 429) {
    return NBQRateLimitError;
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return NBQServerError;
  }
  return NBQAPIError;
}

/**
 * Builds the typed error for an HTTP failure.
 *
 * Maps by envelope `code` first, then by HTTP status, with two gateway rules:
 * every `401` is an `NBQAuthenticationError`, and so is every `403` whose body
 * is not a V1 envelope. A body that is not an envelope — the gateway
 * `{"message":"Unauthorized"}` or `{"message":"Forbidden"}`, an HTML page, an
 * empty body — still yields the right class for its status, `code` undefined.
 */
export function apiErrorFromResponse(
  statusCode: number,
  payload: unknown,
  headers?: Headers | null,
): NBQAPIError {
  const body = isRecord(payload) ? payload : undefined;
  const code = stringOrUndefined(body?.code);
  const details = isRecord(body?.details) ? Object.freeze({ ...body.details }) : undefined;
  const requestId =
    stringOrUndefined(body?.request_id) ??
    headers?.get("X-Request-Id") ??
    headers?.get("x-amzn-RequestId") ??
    undefined;
  const message =
    statusCode === 403 && code === undefined
      ? GATEWAY_FORBIDDEN_MESSAGE
      : (stringOrUndefined(body?.message) ?? `NBQ API request failed with status ${statusCode}`);
  const retryAfter =
    parseRetryAfterHeader(headers?.get("Retry-After")) ??
    numberOrUndefined(details?.retry_after_seconds);

  const options: NBQAPIErrorOptions = {
    statusCode,
    code,
    requestId: requestId ?? undefined,
    details,
    retryAfter,
  };

  // A `401` is always a credential refusal, whatever body it carries.
  const errorClass =
    statusCode === 401
      ? NBQAuthenticationError
      : ((code === undefined ? undefined : BY_CODE[code]) ?? byStatus(statusCode));
  return new errorClass(message, options);
}
