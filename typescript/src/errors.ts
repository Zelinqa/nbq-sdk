type APIErrorOptions = {
  readonly statusCode: number;
  readonly requestId?: string;
  readonly errorType?: string;
  readonly detail?: unknown;
};

export class NBQError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NBQConnectionError extends NBQError {}

export class NBQAPIError extends NBQError {
  public readonly statusCode: number;
  public readonly requestId: string | undefined;
  public readonly errorType: string | undefined;
  public readonly detail: unknown;

  public constructor(message: string, options: APIErrorOptions) {
    super(message);
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.errorType = options.errorType;
    this.detail = options.detail;
  }
}

export class NBQAuthenticationError extends NBQAPIError {}
export class NBQValidationError extends NBQAPIError {}
export class NBQConflictError extends NBQAPIError {}
export class NBQRateLimitError extends NBQAPIError {}
export class NBQServerError extends NBQAPIError {}

type ErrorPayload = {
  readonly title?: unknown;
  readonly detail?: unknown;
  readonly type?: unknown;
  readonly request_id?: unknown;
};

export function apiErrorFromPayload(
  statusCode: number,
  payload: ErrorPayload | null,
  fallbackRequestId?: string,
): NBQAPIError {
  const title = typeof payload?.title === "string" ? payload.title : undefined;
  const detail = payload?.detail;
  const errorType = typeof payload?.type === "string" ? payload.type : undefined;
  const requestId =
    typeof payload?.request_id === "string" ? payload.request_id : fallbackRequestId;
  const message =
    title ??
    (typeof detail === "string" ? detail : undefined) ??
    `NBQ API request failed with status ${statusCode}`;

  const options: APIErrorOptions = {
    statusCode,
    ...(requestId === undefined ? {} : { requestId }),
    ...(errorType === undefined ? {} : { errorType }),
    detail,
  };

  if (statusCode === 401 || statusCode === 403) {
    return new NBQAuthenticationError(message, options);
  }
  if (statusCode === 409) {
    return new NBQConflictError(message, options);
  }
  if (statusCode === 422) {
    return new NBQValidationError(message, options);
  }
  if (statusCode === 429) {
    return new NBQRateLimitError(message, options);
  }
  if (statusCode >= 500) {
    return new NBQServerError(message, options);
  }
  return new NBQAPIError(message, options);
}
